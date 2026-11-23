import { resolveFov } from './game-settings.mjs?v=3';
import { bindOrbit } from './orbit.mjs?v=1';
import { createMovement, stepMovement, Stance, ActorState } from './movement.mjs?v=2';

export async function mountExploration(world, signal, replication, settings) {
  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js');
  if (signal.aborted) return;
  const canvas = world.querySelector('canvas');
  const { orbit, clampDistance } = bindOrbit(canvas, settings, signal);
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
  const capsule = new THREE.Mesh(capsuleGeometry, localMaterial);
  const remoteCapsules = new Map();
  scene.add(capsule);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 85);
  const target = new THREE.Vector3(0, 1, 0);
  const desiredTarget = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();
  const actor = createMovement();
  const spawnAngle = replication.spawnAngle / 4294967296 * Math.PI * 2;
  actor.x = Math.cos(spawnAngle) * 3;
  actor.z = Math.sin(spawnAngle) * 3;
  target.set(actor.x, 1, actor.z);
  const held = new Set();
  const handled = new Set(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','KeyC','Space','KeyE','KeyF']);
  const input = {x:0,z:0,walk:false,sprint:false,jump:false,crouch:false,dash:false};
  let lastShift = -Infinity;
  let pointer = null, sprintPointer = null, stickX = 0, stickZ = 0, frame;
  let previous = performance.now();
  let scale = 1;
  let jumpUntil = 0;

  function interact() {
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
  window.addEventListener('blur', resetControls, options);
  world.addEventListener('focusin', event => {
    if (event.target.matches('input, textarea, [contenteditable]')) resetControls();
  }, options);
  const requestJump = () => { jumpUntil = performance.now() + 140; };
  const hasMoveInput = () => pointer !== null || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some(key => held.has(key));
  window.addEventListener('keydown', event => {
    if (!handled.has(event.code) || event.altKey || event.ctrlKey || event.metaKey ||
      event.target.matches?.('input, textarea, [contenteditable]') ||
      (event.code === 'Space' && event.target.closest?.('button') && !hasMoveInput())) return;
    event.preventDefault();
    if (event.repeat || held.has(event.code)) return;
    const wasSprinting = held.has('ShiftLeft') || held.has('ShiftRight');
    held.add(event.code);
    if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !wasSprinting) {
      const now = performance.now();
      if (now - lastShift <= 280) {
        input.dash = true;
        lastShift = -Infinity;
      } else lastShift = now;
    }
    if (event.code === 'KeyC') input.crouch = true;
    if (event.code === 'Space') requestJump();
    if (event.code === 'KeyE' || event.code === 'KeyF') interact();
  }, options);
  window.addEventListener('keyup', event => held.delete(event.code), options);

  function moveStick(event) {
    const bounds = stick.getBoundingClientRect();
    const radius = bounds.width * 0.36;
    const x = event.clientX - bounds.left - bounds.width / 2;
    const y = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(x, y);
    const factor = radius / Math.max(radius, distance);
    stickX = x * factor / radius;
    stickZ = y * factor / radius;
    thumb.style.transform = 'translate(' + x * factor + 'px,' + y * factor + 'px)';
  }

  stick.addEventListener('pointerdown', event => {
    if (pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
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
  walk.addEventListener('click', () => {
    input.walk = !input.walk;
    walk.setAttribute('aria-pressed', String(input.walk));
  }, options);
  sprint.addEventListener('pointerdown', event => {
    if (sprintPointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    sprintPointer = event.pointerId;
    sprint.setPointerCapture(sprintPointer);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    sprint.addEventListener(name, event => {
      if (event.pointerId === sprintPointer) sprintPointer = null;
    }, options);
  }
  interaction.addEventListener('click', interact, options);

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  function animate(now) {
    const dt = Math.min((now - previous) / 1000, 0.05);
    previous = now;
    const localX = Number(held.has('KeyD')) - Number(held.has('KeyA')) + stickX;
    const localZ = Number(held.has('KeyS')) - Number(held.has('KeyW')) + stickZ;
    const sin = Math.sin(orbit.yaw), cos = Math.cos(orbit.yaw);
    input.x = localX * cos + localZ * sin;
    input.z = localZ * cos - localX * sin;
    input.sprint = sprintPointer !== null || held.has('ShiftLeft') || held.has('ShiftRight');
    input.jump = jumpUntil >= now && actor.state === ActorState.GROUNDED && actor.dashLeft === 0 && !input.dash;
    if (input.jump) jumpUntil = 0;
    stepMovement(actor, input, dt, settings);
    input.jump = input.crouch = input.dash = false;
    actor.x = THREE.MathUtils.clamp(actor.x, -49, 49);
    actor.z = THREE.MathUtils.clamp(actor.z, -49, 49);
    scale = THREE.MathUtils.lerp(scale, actor.stance === Stance.CROUCH ? 0.62 : 1, 1 - Math.exp(-18 * dt));
    capsule.scale.y = scale;
    capsule.position.set(actor.x, actor.y + 0.9 * scale, actor.z);
    replication.publish(actor, now);
    const blend = 1 - Math.exp(-24 * dt);
    for (const [id, pose] of replication.players) {
      let mesh = remoteCapsules.get(id);
      const height = pose.crouch ? 0.62 : 1;
      if (!mesh) {
        mesh = new THREE.Mesh(capsuleGeometry, remoteMaterial);
        mesh.position.set(pose.x, pose.y + 0.9 * height, pose.z);
        mesh.scale.y = height;
        remoteCapsules.set(id, mesh);
        scene.add(mesh);
      }
      // Predict briefly while snapshots are arriving, then settle at the last position.
      const age = Math.max(0, now - pose.receivedAt);
      const lead = age <= 80 ? age : Math.max(0, 160 - age);
      const predictedX = THREE.MathUtils.clamp(pose.x + pose.vx * lead / 1000, -49, 49);
      const predictedZ = THREE.MathUtils.clamp(pose.z + pose.vz * lead / 1000, -49, 49);
      mesh.scale.y = THREE.MathUtils.lerp(mesh.scale.y, height, blend);
      mesh.position.x = THREE.MathUtils.lerp(mesh.position.x, predictedX, blend);
      mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, pose.y + 0.9 * mesh.scale.y, blend);
      mesh.position.z = THREE.MathUtils.lerp(mesh.position.z, predictedZ, blend);
    }
    for (const [id, mesh] of remoteCapsules) {
      if (replication.players.has(id)) continue;
      scene.remove(mesh);
      remoteCapsules.delete(id);
    }
    desiredTarget.set(actor.x, actor.y + 0.95, actor.z);
    target.lerp(desiredTarget, 1 - Math.exp(-12 * dt));
    clampDistance();
    const fov = resolveFov(settings, orbit.distance);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    const horizontal = Math.cos(orbit.pitch) * orbit.distance;
    cameraOffset.set(sin * horizontal, Math.sin(orbit.pitch) * orbit.distance, cos * horizontal);
    camera.position.copy(target).add(cameraOffset);
    camera.lookAt(target);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    floor.geometry.dispose();
    floor.material.dispose();
    grid.geometry.dispose();
    grid.material.dispose();
    capsuleGeometry.dispose();
    localMaterial.dispose();
    remoteMaterial.dispose();
    renderer.dispose();
    walk.setAttribute('aria-pressed', 'false');
    resetControls();
  }, { once: true });
}
