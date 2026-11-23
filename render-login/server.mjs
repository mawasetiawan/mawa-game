import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const allowedOrigin = process.env.GAME_ORIGIN || 'https://mawasetiawan.github.io';
const lifetime = 5 * 60_000;
const capacity = 256;
const sessions = new Map();
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest();
const secret = () => randomBytes(32).toString('base64url');
const authorized = (value, expected) =>
  typeof value === 'string' && secretPattern.test(value) && timingSafeEqual(digest(value), expected);

async function readEnvelope(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) return null;
    chunks.push(chunk);
  }
  const payload = Buffer.concat(chunks).toString('utf8');
  return /^[A-Za-z0-9_-]+$/.test(payload) ? payload : null;
}

createServer(async (request, response) => {
  const send = (status, data) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
      Vary: 'Origin',
    });
    response.end(data === undefined ? undefined : JSON.stringify(data));
  };

  try {
    if (request.method === 'GET' && request.url === '/health') return send(200, { ok: true });
    if (request.headers.origin !== allowedOrigin) return send(403);
    if (request.method === 'OPTIONS') return send(204);

    const now = Date.now();
    if (request.method === 'POST' && request.url === '/sessions') {
      for (const [id, entry] of sessions) {
        if (entry.expires <= now) sessions.delete(id);
      }
      if (sessions.size >= capacity) return send(429);
      const id = secret();
      const writeKey = secret();
      const readKey = secret();
      sessions.set(id, { writer: digest(writeKey), reader: digest(readKey), expires: now + lifetime });
      return send(201, { id, writeKey, readKey, expiresIn: lifetime / 1000 });
    }

    const match = /^\/sessions\/([A-Za-z0-9_-]{43})$/.exec(request.url);
    if (!match) return send(404);
    const [, id] = match;
    const entry = sessions.get(id);
    if (!entry || entry.expires <= now) {
      sessions.delete(id);
      return send(404);
    }

    const key = request.headers.authorization?.slice(7);
    if (!request.headers.authorization?.startsWith('Bearer ')) return send(401);
    if (request.method === 'PUT' && authorized(key, entry.writer)) {
      if (entry.payload) return send(409);
      const payload = await readEnvelope(request);
      if (!payload) return send(400);
      if (entry.expires <= Date.now() || sessions.get(id) !== entry) return send(404);
      if (entry.payload) return send(409);
      entry.payload = payload;
      return send(204);
    }
    if (request.method === 'POST' && authorized(key, entry.reader)) {
      if (!entry.payload) return send(202);
      sessions.delete(id);
      return send(200, { payload: entry.payload });
    }
    return send(403);
  } catch {
    if (!response.headersSent && !response.destroyed) send(400);
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
