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

export function touchesAttack(origin, target, attack) {
  const dx = target.x - origin.x, dz = target.z - origin.z;
  const forward = dx * Math.sin(attack.yaw) + dz * Math.cos(attack.yaw);
  const lateral = dx * Math.cos(attack.yaw) - dz * Math.sin(attack.yaw);
  return Math.abs(target.y - origin.y) <= 1.25 && forward >= -.38 &&
    forward <= attack.reach + .36 && Math.abs(lateral) <= .88;
}

export function createCombat(actor, settings, fallbackSpawn, animationDuration, onShake, onControlReset) {
  let clock = 0, serial = 0, swing, queued = false, respawnAt = 0;
  let stunUntil = 0, slowUntil = 0, graceUntil = 0;
  const connections = new Map();
  actor.hp = maxHealth;
  actor.life = 0;

  function start(id, stage) {
    const slot = attackSlot(id, stage);
    const seconds = bound(animationDuration(slot), .38, 8, .48 + (id === 'ultimate' ? .22 : 0));
    swing = {
      id, stage, elapsed: 0, seconds,
      packet: { kind: id, id: ++serial, yaw: Math.atan2(actor.facingX, actor.facingZ) },
    };
    actor.action = slot;
    actor.actionSerial = serial;
    queued = false;
  }

  function press(id) {
    if (!Object.hasOwn(settings.actions, id) || actor.hp === 0 || clock < stunUntil) return;
    if (!swing) start(id, 1);
    else if (swing.id === id && swing.stage < settings.actions[id].count) queued = true;
  }

  function interact() {
    if (actor.hp === 0 || clock < stunUntil || swing) return false;
    actor.action = 'interact';
    actor.actionSerial = ++serial;
    actor.interactionUntil = clock + bound(animationDuration('interact'), .15, 8, .5);
    return true;
  }

  function receive(origin, attack) {
    if (!actor.hp || clock < graceUntil || !touchesAttack(origin, actor, attack)) return false;
    actor.hp = Math.max(0, actor.hp - attack.damage);
    if (attack.shake) onShake();
    if (actor.hp === 0) {
      actor.action = 'death';
      actor.actionSerial = ++serial;
      respawnAt = clock + settings.respawn;
      swing = actor.attack = null;
      actor.dashLeft = 0;
      onControlReset();
    } else if (attack.effect === 'stun') {
      stunUntil = Math.max(stunUntil, clock + attack.seconds);
      swing = actor.attack = null;
      actor.action = '';
      actor.dashLeft = 0;
      onControlReset();
    } else if (attack.effect === 'slow') slowUntil = Math.max(slowUntil, clock + attack.seconds);
    else if (attack.effect === 'airborne') {
      actor.dashLeft = 0;
      actor.verticalSpeed = Math.min(6, 2.8 + attack.seconds);
      actor.state = 'in air';
    }
    return true;
  }

  function tick(dt, now, players) {
    clock += dt;
    for (const id of connections.keys()) if (!players.has(id)) connections.delete(id);
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
      if (!Object.hasOwn(settings.actions, attack.kind)) continue;
      if (receive(pose, { ...settings.actions[attack.kind], yaw: attack.yaw })) connections.set(uid, { connection: pose.connection, id: attack.id });
      if (!actor.hp) return;
    }
    if (swing) swing.elapsed += dt * (clock < slowUntil ? .45 : 1);
    if (swing && swing.elapsed >= swing.seconds) {
      if (queued && swing.stage < settings.actions[swing.id].count) start(swing.id, swing.stage + 1);
      else { swing = null; actor.action = ''; }
    }
    if (actor.action === 'interact' && clock >= actor.interactionUntil) actor.action = '';
    // Contact starts after windup and ends before the recovery frames.
    actor.attack = swing && swing.elapsed >= swing.seconds * .25 && swing.elapsed <= swing.seconds * .7 ? swing.packet : null;
  }

  return {
    press, interact, tick, receive,
    blocked: () => !actor.hp || clock < stunUntil,
    timeScale: () => clock < slowUntil ? .45 : 1,
    movement: input => clock < stunUntil ? idleInputs : input,
    respawnLeft: () => actor.hp ? 0 : Math.max(0, respawnAt - clock),
  };
}

export function mountCombatPanel(world, signal, uid, shared) {
  const key = 'mawa-combat-v1:' + uid;
  let raw;
  const local = !shared?.save;
  if (local) {
    try { raw = JSON.parse(localStorage.getItem(key)); } catch {}
  }
  const settings = combatSettings(raw ?? shared?.initial);
  const applied = shared ? combatSettings(shared.initial) : settings;
  const draftFields = [];
  const localPreset = raw ? combatSettings(raw) : null;
  let solo = localPreset;
  let pending = false;
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
    draftFields.push(refresh);
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
  field(spawn, 'Waktu respawn (detik)', 'number', () => settings.respawn, value => settings.respawn = value, { min: .5, max: 30, step: .1 });
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
    number('Jangkauan (meter)', 'reach', .6, 5, .1);
    field(group, 'Efek hit', 'select', () => rule().effect, value => rule().effect = value);
    number('Durasi efek (detik)', 'seconds', .1, 4, .05);
    field(group, 'Camera shake saat terkena', 'checkbox', () => rule().shake, value => rule().shake = value);
    section.append(group);
  }
  const save = button(section, local && shared ? 'Simpan Combat Solo' : 'Simpan Combat', async () => {
    if (pending) return;
    const invalid = [...section.querySelectorAll('input')].find(input => !input.checkValidity() ||
      (input.type === 'number' && !Number.isFinite(input.valueAsNumber)));
    if (invalid) {
      invalid.closest('details').open = true;
      invalid.reportValidity();
      return;
    }
    pending = save.disabled = true;
    try {
      if (shared?.save) {
        await shared.save(combatSettings(settings));
        status.textContent = 'Pengaturan combat diterapkan untuk semua pemain.';
      } else {
        localStorage.setItem(key, JSON.stringify(settings));
        solo = combatSettings(settings);
        status.textContent = shared ? 'Preset solo tersimpan di perangkat ini.' : 'Pengaturan tersimpan di perangkat ini.';
      }
    } catch {
      status.textContent = shared?.save ? 'Pengaturan bersama gagal disimpan.' : 'Penyimpanan perangkat tidak tersedia.';
    } finally { pending = save.disabled = false; }
  });
  if (local && shared) status.textContent = 'Preset ini berlaku saat kamu sendiri di map. Game Master mengatur Combat untuk semua pemain.';
  section.append(status);
  world.querySelector('.developer-fields').append(section);
  const unwatch = shared?.watch(raw => {
    Object.assign(applied, combatSettings(raw));
    if (!local || !solo) {
      Object.assign(settings, combatSettings(raw));
      draftFields.forEach(refresh => refresh());
      world.dispatchEvent(new Event('mawa:spawn-point'));
    }
  });
  if (unwatch) signal.addEventListener('abort', unwatch, { once: true });
  return { applied, draft: settings, solo: () => solo };
}
