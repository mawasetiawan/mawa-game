import { createMovement, stepMovement, Stance } from './movement.mjs?v=1';

export async function mountExploration(world, signal) {
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
  const capsule = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 1.08, 8, 16), new THREE.MeshStandardMaterial({color: 0x8ed4ff}));
  scene.add(capsule);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 85);
  const target = new THREE.Vector3(0, 1, 0);
  const desiredTarget = new THREE.Vector3();
  const cameraOffset = new THREE.Vector3();
  const actor = createMovement();
  const held = new Set();
  const handled = new Set(['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','KeyC','Space','KeyE','KeyF']);
  const input = {x:0,z:0,walk:false,sprint:false,jump:false,crouch:false,dash:false};
  let lastShift = -Infinity;
  let pointer = null, sprintPointer = null, stickX = 0, stickZ = 0, frame;
  let previous = performance.now();
  let scale = 1;

  function interact() {
    world.dispatchEvent(new CustomEvent('player-interact', { bubbles: true, detail: { x: actor.x, y: actor.y, z: actor.z } }));
  }

  function resetControls() {
    held.clear();
    pointer = null;
    sprintPointer = null;
    stickX = stickZ = 0;
    input.jump = input.crouch = input.dash = false;
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
  window.addEventListener('keydown', event => {
    if (!handled.has(event.code) || event.altKey || event.ctrlKey || event.metaKey ||
      event.target.matches?.('input, textarea, [contenteditable]') ||
      (event.code === 'Space' && event.target.closest?.('button'))) return;
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
    if (event.code === 'Space') input.jump = true;
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
    if (pointer !== null || event.button !== 0) return;
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
  jump.addEventListener('click', () => { input.jump = true; }, options);
  walk.addEventListener('click', () => {
    input.walk = !input.walk;
    walk.setAttribute('aria-pressed', String(input.walk));
  }, options);
  sprint.addEventListener('pointerdown', event => {
    if (sprintPointer !== null || event.button !== 0) return;
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
    input.x = Number(held.has('KeyD')) - Number(held.has('KeyA')) + stickX;
    input.z = Number(held.has('KeyS')) - Number(held.has('KeyW')) + stickZ;
    input.sprint = sprintPointer !== null || held.has('ShiftLeft') || held.has('ShiftRight');
    stepMovement(actor, input, dt);
    input.jump = input.crouch = input.dash = false;
    actor.x = THREE.MathUtils.clamp(actor.x, -49, 49);
    actor.z = THREE.MathUtils.clamp(actor.z, -49, 49);
    scale = THREE.MathUtils.lerp(scale, actor.stance === Stance.CROUCH ? 0.62 : 1, 1 - Math.exp(-18 * dt));
    capsule.scale.y = scale;
    capsule.position.set(actor.x, actor.y + 0.9 * scale, actor.z);
    desiredTarget.set(actor.x, actor.y + 0.95, actor.z);
    target.lerp(desiredTarget, 1 - Math.exp(-12 * dt));
    cameraOffset.set(0, 3.2, camera.aspect < 0.9 ? 8.5 : 6.7);
    camera.position.copy(target).add(cameraOffset);
    camera.lookAt(target);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    scene.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    renderer.dispose();
    walk.setAttribute('aria-pressed', 'false');
    resetControls();
  }, { once: true });
}
