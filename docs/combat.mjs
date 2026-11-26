import { attackAudioAccept, createAttackAudio, readAttackSound, soundData } from './combat-audio.mjs';
import { attackSlot, combatActions, comboLimit } from './animation-slots.mjs';

export const maxHealth = 100;
const effects = ['none', 'stun', 'slow', 'airborne'];
const defaultActions = {
  basic: [14, 2, 1.9, 'none', false],
  skill1: [23, 1, 2.3, 'stun', false],
  skill2: [26, 1, 2.6, 'slow', true],
  ultimate: [35, 1, 3.2, 'airborne', true],
};
const idleInputs = { x: 0, z: 0 };
const bound = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function audioSettings(raw) {
  return Object.fromEntries(Object.keys(combatActions).map(id => [id, soundData(raw?.[id])]));
}

export function combatSettings(raw) {
  const result = { respawn: bound(raw?.respawn, .5, 30, 3), spawn: null, actions: {} };
  if (Number.isFinite(raw?.spawn?.x) && Number.isFinite(raw?.spawn?.z)) {
    result.spawn = { x: bound(raw.spawn.x, -49, 49), z: bound(raw.spawn.z, -49, 49) };
  }
  for (const [id, [damage, count, reach, effect, shake]] of Object.entries(defaultActions)) {
    const item = raw?.actions?.[id];
    result.actions[id] = {
      damage: bound(item?.damage, 1, 100, damage),
      count: Math.round(bound(item?.count, 1, comboLimit, count)),
      reach: bound(item?.reach, .6, 5, reach),
      effect: effects.includes(item?.effect) ? item.effect : effect,
      seconds: bound(item?.seconds, .1, 4, .65),
      shake: typeof item?.shake === 'boolean' ? item.shake : shake,
    };
  }
  return result;
}

const bodyRadius = .36;
const strikeRadius = .46;
const strikeOffset = .66;
const warpGap = .89;
const maxWarpHeight = .65;
const originOf = actor => ({ x: actor.x, y: actor.y, z: actor.z });

export function touchesAttack(origin, target, attack) {
  const x = origin.x + Math.sin(attack.yaw) * strikeOffset;
  const z = origin.z + Math.cos(attack.yaw) * strikeOffset;
  const y = origin.y + (origin.stance === 'crouch' || origin.crouch ? .62 : .92);
  const height = target.stance === 'crouch' || target.crouch ? 1.12 : 1.8;
  const capsuleY = Math.max(target.y + bodyRadius, Math.min(target.y + height - bodyRadius, y));
  return Math.hypot(target.x - x, target.z - z, capsuleY - y) <= bodyRadius + strikeRadius;
}

export function createCombat(actor, settings, fallbackSpawn, animationDuration, onShake, onControlReset, identity = 'local', shakeEnabled, attackMotion, onAttack, sharedActions = () => settings.actions, canAnimate = () => true, animationSpeed = () => 1) {
  let clock = 0, serial = 0, swing, combo, respawnAt = 0;
  let stunUntil = 0, slowUntil = 0, graceUntil = 0, impactUntil = 0;
  const connections = new Map();
  const swings = new Map();
  actor.hp = maxHealth;
  actor.life = 0;

  function start(id, stage) {
    const slot = attackSlot(id, stage);
    const clipDuration = animationDuration(slot);
    const seconds = Number.isFinite(clipDuration) && clipDuration > 0 ?
      clipDuration : .52 + (id === 'ultimate' ? .22 : 0);
    const origin = originOf(actor);
    swing = {
      id, stage, elapsed: 0, speed: animationSpeed(), seconds, origin, reach: settings.actions[id].reach, motion: attackMotion?.(slot),
      packet: { kind: id, id: ++serial, yaw: Math.atan2(actor.facingX, actor.facingZ) },
    };
    actor.range = { ...origin, radius: swing.reach };
    actor.action = slot;
    actor.actionSerial = serial;
    actor.dashLeft = 0;
    combo = null;
    onAttack?.(id);
    swings.set(serial, { kind: id, expires: clock + seconds / .45 + 1 });
  }

  function press(id) {
    if (swing || !Object.hasOwn(settings.actions, id) || actor.hp === 0 || clock < stunUntil) return false;
    const stage = combo?.id === id && clock <= combo.until && combo.stage < settings.actions[id].count ? combo.stage + 1 : 1;
    start(id, stage);
    return true;
  }

  function interact() {
    if (actor.hp === 0 || clock < stunUntil || swing || !canAnimate('interact')) return false;
    combo = null;
    actor.action = 'interact';
    actor.actionSerial = ++serial;
    actor.interactionUntil = clock + bound(animationDuration('interact'), .15, 8, .5);
    return true;
  }

  function shake(kind, fallback) {
    if (shakeEnabled?.(kind) ?? fallback) onShake();
  }

  function stopSwing() {
    swing = actor.attack = actor.range = combo = null;
    actor.warping = false;
  }

  function receive(origin, attack) {
    if (!actor.hp || clock < graceUntil || !touchesAttack(origin, actor, attack)) return false;
    actor.hp = Math.max(0, actor.hp - attack.damage);
    shake(attack.kind, attack.shake);
    if (actor.hp === 0) {
      actor.action = 'death';
      actor.actionSerial = ++serial;
      respawnAt = clock + settings.respawn;
      stopSwing();
      actor.dashLeft = 0;
      onControlReset();
    } else if (attack.effect === 'stun') {
      stunUntil = Math.max(stunUntil, clock + attack.seconds);
      stopSwing();
      actor.action = '';
      actor.dashLeft = 0;
      onControlReset();
    } else if (attack.effect === 'slow') slowUntil = Math.max(slowUntil, clock + attack.seconds);
    else if (attack.effect === 'airborne') {
      actor.dashLeft = 0;
      actor.verticalSpeed = Math.min(6, 2.8 + attack.seconds);
      actor.state = 'in air';
      stopSwing();
      if (actor.action?.includes('Combo')) actor.action = '';
    }
    return true;
  }

  function acquireTarget(players) {
    let distance = swing.reach;
    let target;
    for (const pose of players.values()) {
      if (pose.hp === 0 || Math.abs(pose.y - swing.origin.y) > maxWarpHeight) continue;
      const gap = Math.hypot(pose.x - swing.origin.x, pose.z - swing.origin.z);
      if (gap > distance) continue;
      distance = gap;
      target = pose;
    }
    swing.warp = null;
    if (!target || distance < .02) return;
    const dx = target.x - swing.origin.x;
    const dz = target.z - swing.origin.z;
    const fraction = Math.max(0, distance - warpGap) / distance;
    const fromYaw = swing.packet.yaw;
    const difference = Math.atan2(dx, dz) - fromYaw;
    swing.warp = {
      x: swing.origin.x + dx * fraction, z: swing.origin.z + dz * fraction,
      fromYaw, turn: Math.atan2(Math.sin(difference), Math.cos(difference)),
      duration: Math.min(.24, swing.seconds * .45),
    };
  }

  function applyRootMotion(time) {
    const { x, z } = swing.motion(time);
    const warp = swing.warp;
    const facing = warp ? warp.fromYaw + warp.turn : swing.packet.yaw;
    actor.x = swing.origin.x + x * Math.cos(facing) + z * Math.sin(facing);
    actor.z = swing.origin.z + z * Math.cos(facing) - x * Math.sin(facing);
  }

  function tick(dt, now, players) {
    clock += dt;
    if (clock >= impactUntil) actor.impacts = null;
    if (swing) swings.get(swing.packet.id).expires = clock + 1;
    for (const [id, entry] of swings) if (clock > entry.expires) swings.delete(id);
    for (const id of connections.keys()) if (!players.has(id)) connections.delete(id);
    for (const pose of players.values()) {
      const outgoing = swings.get(pose.impacts?.[identity]);
      if (!outgoing || outgoing.acknowledged) continue;
      outgoing.acknowledged = true;
      shake(outgoing.kind, settings.actions[outgoing.kind]?.shake);
    }
    if (!actor.hp) {
      if (clock < respawnAt) return;
      const { x, z } = settings.spawn ?? fallbackSpawn;
      Object.assign(actor, { x, z, y: 0, verticalSpeed: 0, dashLeft: 0, stance: 'stand',
        gait: 'stop', state: 'grounded', hp: maxHealth, action: '', life: actor.life + 1 });
      stunUntil = slowUntil = 0;
      graceUntil = clock + 1;
      onControlReset();
    }
    for (const [uid, pose] of players) {
      const attack = pose.attack;
      if (!attack || pose.hp === 0 || now - pose.receivedAt > 280) continue;
      const last = connections.get(uid);
      if (last?.connection === pose.connection && last.id >= attack.id) continue;
      const rules = sharedActions();
      if (!Object.hasOwn(rules, attack.kind)) continue;
      if (receive(pose, { ...rules[attack.kind], kind: attack.kind, yaw: attack.yaw })) {
        connections.set(uid, { connection: pose.connection, id: attack.id });
        const impacts = { ...actor.impacts, [uid]: attack.id };
        actor.impacts = Object.fromEntries(Object.entries(impacts).slice(-8));
        impactUntil = clock + .65;
      }
      if (!actor.hp) return;
    }
    if (swing) {
      // Root-motion sampling and swing timing use the same play rate as the mixer.
      swing.elapsed += dt * (clock < slowUntil ? .45 : 1) * animationSpeed() / swing.speed;
    }
    if (swing && swing.elapsed >= swing.seconds) {
      const { id, stage } = swing;
      if (swing.motion) applyRootMotion(swing.seconds);
      stopSwing();
      combo = { id, stage, until: clock + .55 };
      actor.action = '';
    }
    if (actor.action === 'interact' && clock >= actor.interactionUntil) actor.action = '';
    if (!swing) return;

    if (swing.warp === undefined) acquireTarget(players);
    const warp = swing.warp;
    actor.warping = Boolean(swing.motion || (warp && swing.elapsed < warp.duration));
    if (warp && !swing.warpFinished) {
      const t = Math.min(1, swing.elapsed / warp.duration);
      const eased = t * t * (3 - 2 * t);
      if (!swing.motion) {
        actor.x = swing.origin.x + (warp.x - swing.origin.x) * eased;
        actor.z = swing.origin.z + (warp.z - swing.origin.z) * eased;
      }
      const yaw = warp.fromYaw + warp.turn * eased;
      actor.facingX = Math.sin(yaw);
      actor.facingZ = Math.cos(yaw);
      swing.packet = { ...swing.packet, yaw: Math.atan2(actor.facingX, actor.facingZ) };
      swing.warpFinished = t === 1;
    }
    if (swing.motion) applyRootMotion(swing.elapsed);
    const contactStart = Math.max(swing.seconds * .34, warp?.duration ?? 0);
    actor.range = swing.elapsed < contactStart + .15 ? actor.range : null;
    // Range selects a target. Only the strike collider during the contact window deals damage.
    actor.attack = swing.elapsed >= contactStart && swing.elapsed <= Math.max(contactStart + .16, swing.seconds * .8) ?
      swing.packet : null;
  }

  return {
    press, interact, tick, receive,
    blocked: () => !actor.hp || clock < stunUntil,
    timeScale: () => clock < slowUntil ? .45 : 1,
    movement: input => clock < stunUntil || swing ? idleInputs : input,
    respawnLeft: () => actor.hp ? 0 : Math.max(0, respawnAt - clock),
  };
}

export function mountCombatPanel(world, signal, preset, local, applyLocal) {
  const settings = combatSettings(local ?? preset);
  const applied = combatSettings(local ?? preset);
  const shared = combatSettings(preset);
  const audio = audioSettings((local ?? preset)?.audio);
  const appliedAudio = { ...audio };
  const playSound = createAttackAudio(signal);
  let loadingSounds = 0;
  const section = document.createElement('details');
  const heading = document.createElement('summary');
  heading.textContent = 'Combat';
  section.append(heading);

  function field(parent, title, type, getValue, setValue, limits = {}) {
    const label = document.createElement('label');
    const input = document.createElement(type === 'select' ? 'select' : 'input');
    if (type === 'select') {
      for (const [index, text] of ['Tanpa efek', 'Stun', 'Slow Motion', 'Airborne'].entries()) input.add(new Option(text, effects[index]));
    } else Object.assign(input, { type, ...limits });
    function refresh() {
      if (type === 'checkbox') input.checked = getValue();
      else input.value = getValue();
    }
    refresh();
    input.addEventListener('change', () => {
      if (type === 'number' && (!input.checkValidity() || !Number.isFinite(input.valueAsNumber))) {
        input.reportValidity();
        return;
      }
      setValue(type === 'number' ? input.valueAsNumber : type === 'checkbox' ? input.checked : input.value);
    }, { signal });
    label.append(title, input);
    parent.append(label);
  }

  const status = Object.assign(document.createElement('p'), { role: 'status' });
  function button(parent, title, handler) {
    const node = Object.assign(document.createElement('button'), { type: 'button', textContent: title });
    node.addEventListener('click', handler, { signal });
    parent.append(node);
    return node;
  }
  const spawn = document.createElement('details');
  const spawnTitle = document.createElement('summary');
  spawnTitle.textContent = 'Respawn';
  spawn.append(spawnTitle);
  field(spawn, 'Waktu respawn (detik)', 'number', () => settings.respawn, value => settings.respawn = value, { min: .5, max: 30, step: 'any' });
  const readout = document.createElement('p');
  readout.className = 'combat-spawn-readout';
  const refreshSpawn = () => {
    readout.textContent = settings.spawn ? 'X ' + settings.spawn.x.toFixed(1) + ' · Z ' + settings.spawn.z.toFixed(1) : 'Titik bawaan map';
  };
  refreshSpawn();
  const spawnButtons = document.createElement('div');
  spawnButtons.className = 'camera-buttons';
  const place = button(spawnButtons, 'Atur titik di map', () => world.dispatchEvent(new Event('mawa:spawn-edit')));
  place.setAttribute('aria-pressed', 'false');
  button(spawnButtons, 'Reset titik', () => {
    settings.spawn = null;
    world.dispatchEvent(new Event('mawa:spawn-point'));
  });
  world.addEventListener('mawa:spawn-point', refreshSpawn, { signal });
  world.addEventListener('mawa:spawn-editing', event => place.setAttribute('aria-pressed', String(event.detail)), { signal });
  spawn.append(spawnButtons, readout);
  section.append(spawn);
  for (const [id, title] of Object.entries(combatActions)) {
    const group = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    group.append(summary);
    const rule = () => settings.actions[id];
    const number = (label, key, min, max, step) => field(group, label, 'number', () => rule()[key], value => rule()[key] = value, { min, max, step });
    number('Jumlah tahap combo', 'count', 1, comboLimit, 1);
    number('Damage per tahap', 'damage', 1, 100, 1);
    number('Jangkauan (meter)', 'reach', .6, 5, 'any');
    field(group, 'Efek hit', 'select', () => rule().effect, value => rule().effect = value);
    number('Durasi efek (detik)', 'seconds', .1, 4, 'any');
    field(group, 'Camera shake saat hit', 'checkbox', () => rule().shake, value => rule().shake = value);
    const soundLabel = document.createElement('label');
    const soundInput = Object.assign(document.createElement('input'), { type: 'file', accept: attackAudioAccept });
    soundLabel.append('File suara serangan', soundInput);
    const soundActions = Object.assign(document.createElement('div'), { className: 'camera-buttons' });
    function refreshSound() {
      test.disabled = remove.disabled = !audio[id];
      test.textContent = audio[id] ? 'Tes Suara' : 'Suara kosong';
    }
    const test = button(soundActions, 'Tes Suara', () => playSound(audio[id]));
    const remove = button(soundActions, 'Hapus Suara', () => { audio[id] = ''; refreshSound(); });
    refreshSound();
    soundInput.addEventListener('change', async () => {
      const file = soundInput.files?.[0];
      if (!file) return;
      soundInput.value = '';
      soundInput.disabled = remove.disabled = true;
      loadingSounds++;
      try {
        const value = soundData(await readAttackSound(file));
        if (!value) throw Error('Suara tidak valid.');
        if (!signal.aborted) { audio[id] = value; status.textContent = 'Suara siap. Tekan Apply Setting untuk memakainya.'; }
      } catch (error) {
        if (!signal.aborted) status.textContent = error.message;
      } finally {
        loadingSounds--;
        soundInput.disabled = false;
        refreshSound();
      }
    }, { signal });
    group.append(soundLabel, soundActions);
    section.append(group);
  }
  const snapshot = () => ({ ...combatSettings(applied), audio: { ...appliedAudio } });
  button(section, 'Apply Setting', () => {
    if (loadingSounds) return;
    const invalid = [...section.querySelectorAll('input')].find(input => !input.checkValidity() ||
      (input.type === 'number' && !Number.isFinite(input.valueAsNumber)));
    if (invalid) {
      invalid.closest('details').open = true;
      invalid.reportValidity();
      return;
    }
    Object.assign(applied, combatSettings(settings));
    Object.assign(appliedAudio, audio);
    applyLocal?.(snapshot());
    status.textContent = 'Combat diterapkan ke pemain lokal. Damage dan efek untuk lawan online mengikuti konfigurasi GitHub.';
  });
  section.append(status);
  world.querySelector('.developer-fields').append(section);
  return { applied, shared, draft: settings, audio: appliedAudio, snapshot };
}
