import { attackAudioAccept, createAttackAudio, readAttackSound, soundData } from './combat-audio.mjs';
import { attackSlot, combatActions, comboLimit } from './animation-slots.mjs';
import { actorTrace, mountCombatRecorder } from './combat-troubleshoot.mjs';

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
const minimumSwingSeconds = .18;
const originOf = actor => ({ x: actor.x, y: actor.y, z: actor.z });
const warpProgress = (elapsed, warp) => {
  const t = Math.min(1, elapsed / warp.duration);
  return t * t * (3 - 2 * t);
};

function strikeCenter(origin, yaw) {
  return { x: origin.x + Math.sin(yaw) * strikeOffset, z: origin.z + Math.cos(yaw) * strikeOffset,
    y: origin.y + (origin.stance === 'crouch' || origin.crouch ? .62 : .92) };
}

export function touchesAttack(origin, target, attack) {
  const { x, y, z } = strikeCenter(origin, attack.yaw);
  const height = target.stance === 'crouch' || target.crouch ? 1.12 : 1.8;
  const capsuleY = Math.max(target.y + bodyRadius, Math.min(target.y + height - bodyRadius, y));
  return Math.hypot(target.x - x, target.z - z, capsuleY - y) <= bodyRadius + strikeRadius;
}

export function createCombat(actor, settings, fallbackSpawn, animationDuration, onShake, onControlReset, identity = 'local', shakeEnabled, attackMotion, onAttack, sharedActions = () => settings.actions, canAnimate = () => true, animationSpeed = () => 1, trace) {
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
      Math.max(minimumSwingSeconds, clipDuration) : .52 + (id === 'ultimate' ? .22 : 0);
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
    if (trace?.active) trace.log('attack.started', { swing: serial, kind: id, stage, slot, seconds, clipDuration,
      rootMotion: Boolean(swing.motion), reach: swing.reach, actor: actorTrace(actor) });
  }

  function press(id) {
    const blocked = swing ? 'swing_active' : !Object.hasOwn(settings.actions, id) ? 'unknown_attack' :
      actor.hp === 0 ? 'dead' : clock < stunUntil ? 'stunned' : null;
    if (blocked) {
      trace?.log('attack.input_blocked', { kind: id, reason: blocked });
      return false;
    }
    const stage = combo?.id === id && clock <= combo.until && combo.stage < settings.actions[id].count ? combo.stage + 1 : 1;
    const slot = attackSlot(id, stage);
    if (!canAnimate(slot)) {
      trace?.log('attack.input_blocked', { kind: id, slot, reason: 'missing_animation' });
      return false;
    }
    trace?.log('attack.input', { kind: id, slot });
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

  function receive(origin, attack, source) {
    const reason = !actor.hp ? 'dead' : clock < graceUntil ? 'respawn_grace' :
      !touchesAttack(origin, actor, attack) ? 'outside_hitbox' : null;
    if (trace?.active) trace.once((source?.key ?? 'direct') + ':contact:' + reason, 'hit.checked', {
      player: source?.player, swing: source?.swing, kind: attack.kind, accepted: !reason, reason,
      hitbox: { ...strikeCenter(origin, attack.yaw), strikeRadius, bodyRadius }, target: actorTrace(actor),
    });
    if (reason) return false;
    const previousHp = actor.hp;
    actor.hp = Math.max(0, actor.hp - attack.damage);
    trace?.log('damage.received', { player: source?.player, swing: source?.swing, kind: attack.kind,
      damage: previousHp - actor.hp, hpBefore: previousHp, hpAfter: actor.hp, effect: attack.effect });
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
    let target, targetId;
    for (const [uid, pose] of players) {
      if (pose.hp === 0 || Math.abs(pose.y - swing.origin.y) > maxWarpHeight) continue;
      const gap = Math.hypot(pose.x - swing.origin.x, pose.z - swing.origin.z);
      if (gap > distance) continue;
      distance = gap;
      target = pose;
      targetId = uid;
    }
    if (trace?.active) trace.log('attack.target', { swing: swing.packet.id, player: target && trace.peer(targetId),
      distance: target ? distance : undefined, reach: swing.reach, target: target && actorTrace(target) });
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
    const rootX = swing.origin.x + x * Math.cos(facing) + z * Math.sin(facing);
    const rootZ = swing.origin.z + z * Math.cos(facing) - x * Math.sin(facing);
    // Align the authored displacement with the contact position before the hitbox opens.
    const weight = warp ? warpProgress(time, warp) : 0;
    actor.x = warp ? rootX + (warp.x - rootX) * weight : rootX;
    actor.z = warp ? rootZ + (warp.z - rootZ) * weight : rootZ;
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
      trace?.log('damage.acknowledged', { swing: pose.impacts[identity], kind: outgoing.kind });
      shake(outgoing.kind, settings.actions[outgoing.kind]?.shake);
    }
    if (!actor.hp) {
      if (clock < respawnAt) return;
      const { x, z } = settings.spawn ?? fallbackSpawn;
      Object.assign(actor, { x, z, y: 0, verticalSpeed: 0, dashLeft: 0, stance: 'stand',
        gait: 'stop', state: 'grounded', hp: maxHealth, action: '', life: actor.life + 1 });
      stunUntil = slowUntil = 0;
      graceUntil = clock + 1;
      if (trace?.active) trace.log('actor.respawned', { actor: actorTrace(actor) });
      onControlReset();
    }
    for (const [uid, pose] of players) {
      const attack = pose.attack;
      if (!attack) continue;
      const ageMs = Math.round(now - pose.receivedAt);
      const source = trace?.active ? { player: trace.peer(uid), swing: attack.id,
        key: 'incoming:' + uid + ':' + pose.connection + ':' + attack.id } : undefined;
      if (source) trace.once(source.key, 'attack.observed', { player: source.player, swing: attack.id, kind: attack.kind, ageMs });
      if (pose.hp === 0 || now - pose.receivedAt > 280) {
        if (source) trace.once(source.key + ':discarded', 'attack.discarded', { player: source.player,
          swing: attack.id, reason: pose.hp === 0 ? 'attacker_dead' : 'stale_snapshot', ageMs });
        continue;
      }
      const last = connections.get(uid);
      if (last && last.connection === pose.connection && last.id >= attack.id) continue;
      const rules = sharedActions();
      if (!Object.hasOwn(rules, attack.kind)) continue;
      if (receive(pose, { ...rules[attack.kind], kind: attack.kind, yaw: attack.yaw }, source)) {
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
      trace?.log('attack.ended', { swing: swing.packet.id, kind: id, stage });
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
      const eased = warpProgress(swing.elapsed, warp);
      if (!swing.motion) {
        actor.x = swing.origin.x + (warp.x - swing.origin.x) * eased;
        actor.z = swing.origin.z + (warp.z - swing.origin.z) * eased;
      }
      const yaw = warp.fromYaw + warp.turn * eased;
      actor.facingX = Math.sin(yaw);
      actor.facingZ = Math.cos(yaw);
      swing.packet = { ...swing.packet, yaw: Math.atan2(actor.facingX, actor.facingZ) };
      swing.warpFinished = swing.elapsed >= warp.duration;
    }
    if (swing.motion) applyRootMotion(swing.elapsed);
    const contactStart = Math.max(swing.seconds * .34, warp?.duration ?? 0);
    actor.range = swing.elapsed < contactStart + .15 ? actor.range : null;
    // Range selects a target. Only the strike collider during the contact window deals damage.
    actor.attack = swing.elapsed >= contactStart && swing.elapsed <= Math.max(contactStart + .16, swing.seconds * .8) ?
      swing.packet : null;
    if (actor.attack && trace?.active) {
      const hitbox = { ...strikeCenter(actor, swing.packet.yaw), strikeRadius };
      trace.once('hitbox:' + swing.packet.id, 'hitbox.active', {
        swing: swing.packet.id, kind: swing.id, elapsed: swing.elapsed, actor: actorTrace(actor), hitbox,
      });
      for (const [uid, pose] of players) {
        const overlap = touchesAttack(actor, pose, swing.packet);
        trace.once('outgoing:' + swing.packet.id + ':' + uid + ':' + overlap, 'hit.local_overlap', {
          swing: swing.packet.id, player: trace.peer(uid), overlap, hitbox, target: actorTrace(pose),
        });
      }
    }
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
  const recorder = mountCombatRecorder(section, signal, world.querySelector('.game-version')?.textContent);

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
  return { applied, shared, draft: settings, audio: appliedAudio, snapshot, recorder };
}
