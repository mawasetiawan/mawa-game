import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const queue = 'https://mawa-game-default-rtdb.asia-southeast1.firebasedatabase.app/developerConfigPublication';
const receiptPath = '.github/developer-settings-publication.json';
const configPath = 'docs/developer-settings.json';
const validId = /^[a-f0-9]{32}$/;
const configLimit = 1_600_000;
const characterPattern = /^[a-z0-9-]+[.]character[.]json(?:[.]gz)?$/;

async function read(path) {
  const response = await fetch(queue + path + '.json', { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Error('Firebase publication queue returned HTTP ' + response.status);
  return response.json();
}

const last = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, 'utf8')).id : null;
const waiting = await read('/id');
if (waiting === null || waiting === last) process.exit(0);
if (typeof waiting !== 'string' || !validId.test(waiting)) throw Error('Invalid publication ID');

const entry = await read('');
if (!entry || !validId.test(entry.id) || entry.id === last) process.exit(0);
if (typeof entry.payload !== 'string' || Buffer.byteLength(entry.payload) > configLimit) throw Error('Invalid publication payload');
const config = JSON.parse(entry.payload);
if (config?.kind === 'delete-character') {
  const name = config.package;
  const sha = config.sha;
  if (config.version !== 1 || config.publicationId !== entry.id || typeof name !== 'string' ||
      name.length > 100 || !characterPattern.test(name) || typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
    throw Error('Invalid character deletion request');
  }
  const path = 'docs/characters/' + name;
  const active = JSON.parse(readFileSync(configPath, 'utf8')).character?.package;
  let status = 'deleted';
  if (active === name) status = 'active-character';
  else if (existsSync(path)) {
    const current = execFileSync('git', ['hash-object', '--', path], { encoding: 'utf8' }).trim();
    if (current !== sha) status = 'asset-changed';
    else unlinkSync(path);
  }
  writeFileSync(receiptPath, JSON.stringify({ id: entry.id, status }) + '\n');
  console.log('Character deletion result: ' + status);
  process.exit(0);
}

if (!config || config.version !== 1 || config.publicationId !== entry.id ||
    !['game', 'camera', 'effects', 'hud', 'combat'].every(key =>
      config[key] && typeof config[key] === 'object' && !Array.isArray(config[key]))) {
  throw Error('Invalid Developer settings');
}
if (config.character !== null) {
  const name = config.character?.package;
  if (typeof name !== 'string' || name.length > 100 || !characterPattern.test(name) ||
      !existsSync('docs/characters/' + name)) {
    throw Error('Referenced character package must already be committed to docs/characters');
  }
}

writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
writeFileSync(receiptPath, JSON.stringify({ id: entry.id, status: 'published' }) + '\n');
console.log('Prepared Developer settings publication ' + entry.id);
