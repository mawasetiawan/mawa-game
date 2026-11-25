import { mountPcControls } from './pc-controls.mjs';
import { createAttackAudio } from './combat-audio.mjs';
import { createCombat, combatSettings, maxHealth } from './combat.mjs?v=7';
import { createHealthBars, mountCombatHud, mountSpawnGizmo } from './combat-hud.mjs?v=2';
import { createCameraCues, triggerCameraCue } from './camera-cues.mjs?v=3';
import { createCameraRig } from './camera-rig.mjs?v=pc';
import { createMovement, stepMovement, Stance, ActorState } from './movement.mjs?v=3';

export async function mountExploration(world, signal, replication, settings, getCamera = () => null, characterEditor, combatPanel, playerName = () => '') {
  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js');
  if (signal.aborted) return;
  const canvas = world.querySelector('canvas');
  const stick = world.querySelector('#joystick');
  const thumb = stick.firstElementChild;
  const actions = world.querySelector('#actions');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x48677d);
  scene.fog = new THREE.Fog(0x48677d, 16, 65);
  scene.add(new THREE.HemisphereLight(0xe1f1ff, 0x333b42, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(4, 8, 5);
  scene.add(light);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({color: 0x374e59}));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(100, 100, 0x7ca9b8, 0x506b75);
  grid.position.y = 0.015;
  scene.add(grid);
  const capsuleGeometry = new THREE.CapsuleGeometry(0.36, 1.08, 8, 16);
  const localMaterial = new THREE.MeshStandardMaterial({color: 0x8ed4ff});
  const remoteMaterial = new THREE.MeshStandardMaterial({color: 0xffb86c});
  const remoteAttack = new THREE.MeshStandardMaterial({color: 0xff846c, emissive: 0x562114});
  const remoteDead = new THREE.MeshStandardMaterial({color: 0x5e6369});
  const capsule = new THREE.Mesh(capsuleGeometry, localMaterial);
  const remoteCapsules = new Map();
  scene.add(capsule);
  const updateCharacter = characterEditor?.attach(THREE, scene);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 85);
  const actor = createMovement();
  const spawnAngle = replication.spawnAngle / 4294967296 * Math.PI * 2;
  actor.x = Math.cos(spawnAngle) * 3;
  actor.z = Math.sin(spawnAngle) * 3;
  const combatConfig = combatPanel?.applied ?? combatSettings();
  const defaultSpawn = { x: actor.x, z: actor.z };
  Object.assign(actor, combatConfig.spawn ?? {});
  const tickCues = createCameraCues(world, signal);
  const shakeOffset = new THREE.Vector3();
  const held = new Set();
  const handled = new Set(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','KeyC','Space','KeyE','KeyF','KeyX','Digit1','Digit2','Digit3','Digit4']);
  const input = {x:0,z:0,walk:false,sprint:false,jump:false,crouch:false,dash:false};
  let lastShift = -Infinity;
  let pointer = null, sprintPointer = null, stickX = 0, stickZ = 0, frame;
  let previous = performance.now();
  let scale = 1;
  let jumpUntil = 0;

  const playerId = replication.uid ?? 'local';
  const playSound = createAttackAudio(signal);
  const combat = createCombat(actor, combatConfig, defaultSpawn, slot => characterEditor?.duration(slot),
    () => triggerCameraCue(world, 'shake'), resetControls, playerId,
    kind => combatConfig.actions[kind]?.shake,
    slot => characterEditor?.attackMotion(slot),
    kind => playSound(combatPanel?.audio?.[kind]),
    () => (replication.preview ? combatConfig : combatPanel?.shared ?? combatConfig).actions);
  const editing = () => world.hasAttribute('data-edit-hud') || world.hasAttribute('data-edit-spawn');
  const control = mountCombatHud(world, actions, signal, {
    press(id) { if (!editing()) { previewFighting = true; combat.press(id); } },
    blocked: combat.blocked, respawnLeft: combat.respawnLeft,
  });
  const health = createHealthBars(THREE, world, canvas, camera, signal);
  mountSpawnGizmo(THREE, world, canvas, scene, camera, combatPanel?.draft ?? combatConfig, actor, signal);
  let previewFighting = false, nextDummyAttack = 0;
  const dummy = replication.preview ? createMovement() : null;
  const dummySpawn = { x: actor.x, z: Math.max(-49, actor.z - 1.65) };
  if (dummy) Object.assign(dummy, dummySpawn, { facingZ: 1, connection: 'preview' });
  const training = dummy && createCombat(dummy, combatConfig, dummySpawn, () => undefined, () => {}, () => {}, 'training');
  const trainingPlayers = new Map();
  const range = new THREE.Mesh(new THREE.RingGeometry(.975, 1, 64),
    new THREE.MeshBasicMaterial({ color: 0xffc770, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide }));
  range.rotation.x = -Math.PI / 2;
  range.visible = false;
  scene.add(range);

  function interact() {
    if (editing() || !combat.interact()) return;
    world.dispatchEvent(new CustomEvent('player-interact', { bubbles: true, detail: { x: actor.x, y: actor.y, z: actor.z } }));
  }

  function resetControls() {
    held.clear();
    pointer = null;
    sprintPointer = null;
    stickX = stickZ = 0;
    input.jump = input.crouch = input.dash = false;
    jumpUntil = 0;
    lastShift = -Infinity;
    thumb.style.transform = '';
  }

  function resize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  const options = { signal };
  const pc = mountPcControls(world, signal, resetControls);
  const cameraRig = createCameraRig(THREE, canvas, camera, actor, settings, getCamera, signal, {
    desktop: pc.desktop,
    button: pc.cameraButton,
    held: () => held.has('camera'),
    blocked: () => pc.open() || editing(),
  });
  const attackIds = ['basic', 'skill1', 'skill2', 'ultimate'];
  function dispatchPc(action) {
    if (!action || held.has(action)) return;
    held.add(action);
    if (attackIds.includes(action)) {
      previewFighting = true;
      combat.press(action);
    } else if (action === 'jump') requestJump();
    else if (action === 'crouch') input.crouch = true;
    else if (action === 'walk') toggleWalk();
    else if (action === 'interact') interact();
    else if (action === 'sprint') sprintTap();
  }
  function sprintTap() {
    const now = performance.now();
    if (now - lastShift <= 280) {
      input.dash = true;
      lastShift = -Infinity;
    } else lastShift = now;
  }
  const gameplayBlocked = () => editing() || combat.blocked() || pc.open();
  canvas.addEventListener('pointerdown', event => {
    if (!pc.desktop() || event.pointerType !== 'mouse' || gameplayBlocked() || event.ctrlKey || event.metaKey) return;
    const action = pc.action('Mouse' + event.button);
    if (!action || action === 'camera') return;
    event.preventDefault();
    dispatchPc(action);
  }, options);
  canvas.addEventListener('contextmenu', event => {
    if (pc.desktop() && pc.action('Mouse2')) event.preventDefault();
  }, options);
  window.addEventListener('pointerup', event => held.delete(pc.action('Mouse' + event.button)), options);
  window.addEventListener('pointercancel', event => {
    if (event.pointerType === 'mouse') resetControls();
  }, options);
  window.addEventListener('blur', resetControls, options);
  world.addEventListener('focusin', event => {
    if (event.target.matches('input, textarea, [contenteditable]')) resetControls();
  }, options);
  const requestJump = () => { if (!editing() && !combat.blocked()) jumpUntil = performance.now() + 140; };
  const hasMoveInput = () => pointer !== null || (pc.desktop() ?
    ['forward', 'left', 'back', 'right'] : ['KeyW', 'KeyA', 'KeyS', 'KeyD']).some(key => held.has(key));
  window.addEventListener('keydown', event => {
    if (gameplayBlocked() || event.altKey || event.metaKey ||
      event.target.closest?.('input, textarea, select, [contenteditable], dialog, .developer-panel') ||
      ((event.code === 'Space' || event.code === 'Enter') && event.target.closest?.('button') && !hasMoveInput())) return;
    if (pc.desktop()) {
      const action = pc.action(event.code);
      if (!action || (event.ctrlKey && !event.code.startsWith('Control'))) return;
      event.preventDefault();
      if (!event.repeat) dispatchPc(action);
      return;
    }
    if (!handled.has(event.code) || event.ctrlKey) return;
    event.preventDefault();
    if (event.repeat || held.has(event.code)) return;
    if (event.code === 'KeyX') control.toggle();
    if (event.code.startsWith('Digit')) control.press(Number(event.code.at(-1)) - 1);
    const wasSprinting = held.has('ShiftLeft') || held.has('ShiftRight');
    held.add(event.code);
    if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !wasSprinting) {
      sprintTap();
    }
    if (event.code === 'KeyC') input.crouch = true;
    if (event.code === 'Space') requestJump();
    if (event.code === 'KeyE' || event.code === 'KeyF') interact();
  }, options);
  window.addEventListener('keyup', event => {
    held.delete(event.code);
    held.delete(pc.action(event.code));
  }, options);

  world.addEventListener('mawa:hud-edit', resetControls, { signal });
  world.addEventListener('mawa:spawn-editing', resetControls, { signal });
  function moveStick(event) {
    const bounds = stick.getBoundingClientRect();
    const angle = (parseFloat(stick.style.rotate) || 0) * Math.PI / 180;
    const [sx = 1, sy = sx] = stick.style.scale.split(' ').filter(Boolean).map(Number);
    const visualZoom = stick.currentCSSZoom || 1;
    const radius = stick.offsetWidth * .36;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const localX = (x * cos + y * sin) / (visualZoom * sx);
    const localY = (-x * sin + y * cos) / (visualZoom * sy);
    const localDistance = Math.hypot(localX, localY);
    const factor = radius / Math.max(radius, localDistance);
    const strength = Math.min(1, localDistance / Math.max(1, radius));
    const distance = Math.max(1, Math.hypot(x, y));
    stickX = x / distance * strength;
    stickZ = y / distance * strength;
    thumb.style.transform = 'translate(' + localX * factor + 'px,' + localY * factor + 'px)';
  }

  stick.addEventListener('pointerdown', event => {
    if (combat.blocked() || editing() || pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    pointer = event.pointerId;
    stick.setPointerCapture(pointer);
    moveStick(event);
  }, options);
  stick.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) moveStick(event);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(name, event => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      stickX = stickZ = 0;
      thumb.style.transform = '';
    }, options);
  }

  const jump = actions.querySelector('[data-action="jump"]');
  const walk = actions.querySelector('[data-action="walk"]');
  const sprint = actions.querySelector('[data-action="sprint"]');
  const interaction = actions.querySelector('[data-action="interact"]');
  jump.addEventListener('pointerdown', event => {
    if ((event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    requestJump();
  }, options);
  jump.addEventListener('click', event => {
    if (event.detail === 0 && !event.pointerType) requestJump();
  }, options);
  function toggleWalk() {
    if (combat.blocked() || editing()) return;
    input.walk = !input.walk;
    walk.setAttribute('aria-pressed', String(input.walk));
  }
  walk.addEventListener('click', toggleWalk, options);
  sprint.addEventListener('pointerdown', event => {
    if (combat.blocked() || editing() || sprintPointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    sprintPointer = event.pointerId;
    sprint.setPointerCapture(sprintPointer);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    sprint.addEventListener(name, event => {
      if (event.pointerId === sprintPointer) sprintPointer = null;
    }, options);
  }
  interaction.addEventListener('click', interact, options);

  // Cancel iOS's synthetic tap on action buttons. Touchend dispatches click-only
  // actions here, while Jump and Sprint keep their pointer-based controls.
  actions.addEventListener('touchend', event => {
    const button = event.target.closest('button[data-action],button[data-combat-action]');
    if (!button || !event.cancelable) return;
    event.preventDefault();
    if (button === walk) toggleWalk();
    if (button === interaction) interact();
    if (button.dataset.combatAction && !button.disabled) button.click();
  }, { signal, passive: false });

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  function animate(now) {
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    if (training) {
      trainingPlayers.set(playerId, { ...actor, receivedAt: now, connection: 'local' });
      const dx = actor.x - dummy.x, dz = actor.z - dummy.z;
      const distance = Math.hypot(dx, dz);
      if (previewFighting && actor.hp && distance <= 2.1 && distance > .01 && now >= nextDummyAttack) {
        dummy.facingX = dx / distance;
        dummy.facingZ = dz / distance;
        training.press('basic');
        nextDummyAttack = now + 1600;
      }
      training.tick(dt, now, trainingPlayers);
      if (dummy.hp) stepMovement(dummy, { x: 0, z: 0 }, dt * training.timeScale(), settings);
      dummy.receivedAt = now;
      replication.players.set('training', dummy);
    }
    combat.tick(dt, now, replication.players);
    control.update();
    const pressed = (action, touchKey) => Number(held.has(pc.desktop() ? action : touchKey));
    const localX = pressed('right', 'KeyD') - pressed('left', 'KeyA') + stickX;
    const localZ = pressed('back', 'KeyS') - pressed('forward', 'KeyW') + stickZ;
    const yaw = cameraRig.heading();
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    input.x = localX * cos + localZ * sin;
    input.z = localZ * cos - localX * sin;
    input.sprint = sprintPointer !== null || held.has('sprint') || held.has('ShiftLeft') || held.has('ShiftRight');
    input.jump = jumpUntil >= now && actor.state === ActorState.GROUNDED && actor.dashLeft === 0 && !input.dash;
    if (input.jump) jumpUntil = 0;
    if (actor.hp > 0) stepMovement(actor, combat.movement(input), dt * combat.timeScale(), settings);
    input.jump = input.crouch = input.dash = false;
    actor.x = THREE.MathUtils.clamp(actor.x, -49, 49);
    actor.z = THREE.MathUtils.clamp(actor.z, -49, 49);
    scale = THREE.MathUtils.lerp(scale, actor.stance === Stance.CROUCH ? 0.62 : 1, 1 - Math.exp(-18 * dt));
    const localHeight = actor.hp ? scale : .34;
    capsule.scale.y = localHeight;
    capsule.position.set(actor.x, actor.y + 0.9 * localHeight, actor.z);
    localMaterial.color.setHex(!actor.hp ? 0x5e7581 : actor.attack ? 0xf8bba0 : 0x8ed4ff);
    capsule.rotation.y = Math.atan2(actor.facingX, actor.facingZ);
    range.visible = Boolean(actor.range);
    if (actor.range) {
      range.position.set(actor.range.x, .033, actor.range.z);
      range.scale.setScalar(actor.range.radius);
      range.material.color.setHex(actor.attack ? 0xff9460 : 0xffce77);
    }
    replication.publish(actor, now, characterEditor?.networkState());
    const blend = 1 - Math.exp(-24 * dt);
    for (const [id, pose] of replication.players) {
      let mesh = remoteCapsules.get(id);
      const height = pose.hp === 0 ? .34 : pose.crouch ? .62 : 1;
      if (!mesh) {
        mesh = new THREE.Mesh(capsuleGeometry, remoteMaterial);
        mesh.position.set(pose.x, pose.y + 0.9 * height, pose.z);
        mesh.scale.y = height;
        remoteCapsules.set(id, mesh);
        mesh.userData.characterView = characterEditor?.createPeer(THREE, scene);
        mesh.rotation.y = pose.yaw ?? 0;
        scene.add(mesh);
      }
      // Predict briefly while snapshots are arriving, then settle at the last position.
      const age = Math.max(0, now - pose.receivedAt);
      const lead = age <= 80 ? age : Math.max(0, 160 - age);
      const predictedX = THREE.MathUtils.clamp(pose.x + (pose.vx ?? 0) * lead / 1000, -49, 49);
      const predictedZ = THREE.MathUtils.clamp(pose.z + (pose.vz ?? 0) * lead / 1000, -49, 49);
      const poseBlend = mesh.userData.life !== pose.life ? 1 : blend;
      mesh.userData.life = pose.life;
      mesh.material = pose.hp === 0 ? remoteDead : pose.attack ? remoteAttack : remoteMaterial;
      mesh.scale.y = THREE.MathUtils.lerp(mesh.scale.y, height, poseBlend);
      mesh.position.x = THREE.MathUtils.lerp(mesh.position.x, predictedX, poseBlend);
      mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, pose.y + 0.9 * mesh.scale.y, poseBlend);
      mesh.position.z = THREE.MathUtils.lerp(mesh.position.z, predictedZ, poseBlend);
      if (Number.isFinite(pose.yaw)) {
        const turn = pose.yaw - mesh.rotation.y;
        mesh.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * poseBlend;
      }
      mesh.visible = true;
      if (pose.anim !== mesh.userData.lastAnim || pose.connection !== mesh.userData.lastConnection) {
        mesh.userData.lastAnim = pose.anim;
        mesh.userData.lastConnection = pose.connection;
        const kind = /^(basic|skill1|skill2|ultimate)Combo[1-4]$/.exec(pose.action ?? '')?.[1];
        const distance = Math.hypot(mesh.position.x - actor.x, mesh.position.z - actor.z);
        if (kind && distance < 16) playSound(combatPanel?.audio?.[kind], .65 * (1 - distance / 16));
      }
      mesh.userData.characterView?.update(pose.character, {
        x: mesh.position.x, y: mesh.position.y - .9 * mesh.scale.y, z: mesh.position.z,
        facingX: Math.sin(mesh.rotation.y), facingZ: Math.cos(mesh.rotation.y),
        stance: pose.crouch ? Stance.CROUCH : Stance.STAND, state: pose.state,
        gait: pose.gait, action: pose.action, actionSerial: pose.anim,
      }, dt, mesh);
    }
    for (const [id, mesh] of remoteCapsules) {
      if (replication.players.has(id)) continue;
      mesh.userData.characterView?.remove();
      scene.remove(mesh);
      remoteCapsules.delete(id);
      health.remove(id);
    }
    cameraRig.update(dt, capsule, scale);
    updateCharacter?.(actor, dt, capsule, combat.timeScale());
    const [shakeX, shakeY, shakeZ] = tickCues(dt);
    shakeOffset.set(shakeX, shakeY, shakeZ).applyQuaternion(camera.quaternion);
    camera.position.add(shakeOffset);
    health.begin();
    if (getCamera()?.mode !== 'fps') {
      health.update('local', actor.x, actor.y + Math.max(.7, characterEditor?.height() ?? 1.8 * localHeight) + .19,
        actor.z, actor.hp, true);
    } else health.remove('local');
    for (const [id, mesh] of remoteCapsules) {
      health.update(id, mesh.position.x, mesh.position.y - .9 * mesh.scale.y + (mesh.userData.characterView?.height() ?? 1.8 * mesh.scale.y) + .19, mesh.position.z,
        replication.players.get(id)?.hp ?? maxHealth, false, id === 'training' ? 'Target latihan' : playerName(id));
    }
    renderer.render(scene, camera);
    camera.position.sub(shakeOffset);
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const mesh of remoteCapsules.values()) mesh.userData.characterView?.remove();
    range.geometry.dispose();
    range.material.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    capsuleGeometry.dispose();
    localMaterial.dispose();
    remoteMaterial.dispose();
    remoteAttack.dispose();
    remoteDead.dispose();
    renderer.dispose();
    walk.setAttribute('aria-pressed', 'false');
    resetControls();
  }, { once: true });
}
