import { combatActions } from './animation-slots.mjs';
import { maxHealth } from './combat.mjs';

export function mountCombatHud(world, actions, signal, control) {
  const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'combat-toggle' });
  const original = [...actions.querySelectorAll('button[data-action]')];
  const buttons = Object.keys(combatActions).map((id, index) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: combatActions[id] });
    button.dataset.combatAction = id;
    button.setAttribute('aria-label', combatActions[id] + ' (' + (index + 1) + ')');
    button.addEventListener('click', () => control.press(id), { signal });
    return button;
  });
  let enabled = false, lastDisabled;
  function updateExplorationButtons() {
    const locomotion = control.locomotion?.();
    for (const node of original) {
      const action = node.dataset.action;
      const unavailable = action === 'walk' ? locomotion?.walkToggle === false :
        action === 'sprint' && locomotion?.sprintHold === false;
      const hidden = enabled || unavailable;
      if (node.hidden !== hidden) node.hidden = hidden;
    }
  }
  function show(value) {
    enabled = value;
    toggle.textContent = enabled ? 'Combat' : 'Eksplorasi';
    toggle.setAttribute('aria-pressed', String(enabled));
    actions.dataset.mode = enabled ? 'combat' : 'exploration';
    actions.setAttribute('aria-label', enabled ? 'Aksi combat' : 'Aksi eksplorasi');
    toggle.setAttribute('aria-label', enabled ? 'Combat aktif. Ganti ke Eksplorasi (X).' : 'Aktifkan Combat (X)');
    updateExplorationButtons();
    for (const node of buttons) node.hidden = !enabled;
  }
  const modeColumn = document.createElement('div');
  modeColumn.className = 'combat-action-column';
  actions.before(modeColumn);
  modeColumn.append(toggle, actions);
  actions.append(...buttons);
  toggle.addEventListener('click', () => show(!enabled), { signal });
  show(false);
  const respawn = document.createElement('output');
  respawn.className = 'combat-respawn';
  respawn.hidden = true;
  world.append(respawn);
  signal.addEventListener('abort', () => {
    modeColumn.replaceWith(actions);
    buttons.forEach(button => button.remove());
    original.forEach(button => { button.hidden = button.disabled = false; });
    respawn.remove();
  }, { once: true });
  return {
    toggle: () => show(!enabled),
    press: index => { if (enabled) buttons[index]?.click(); },
    update() {
      updateExplorationButtons();
      const left = Math.ceil(control.respawnLeft());
      respawn.hidden = left === 0;
      if (left && respawn.value !== 'Respawn dalam ' + left + ' dtk') respawn.value = 'Respawn dalam ' + left + ' dtk';
      const disabled = control.blocked();
      if (disabled !== lastDisabled) {
        for (const node of [toggle, ...original, ...buttons]) node.disabled = disabled;
        lastDisabled = disabled;
      }
    },
  };
}

export function createHealthBars(THREE, world, canvas, camera, signal) {
  const layer = document.createElement('div');
  layer.className = 'combat-health-layer';
  world.append(layer);
  const bars = new Map();
  const point = new THREE.Vector3();
  const relative = new THREE.Vector3();
  const direction = new THREE.Vector3();
  let width, height;

  signal.addEventListener('abort', () => layer.remove(), { once: true });
  return {
    begin() {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      camera.updateMatrixWorld();
      camera.getWorldDirection(direction);
    },
    update(id, x, y, z, hp, local = false, label = '') {
      let bar = bars.get(id);
      if (!bar) {
        const element = document.createElement('div');
        element.className = 'combat-health' + (local ? ' local' : '');
        const fill = document.createElement('i');
        element.append(fill);
        const name = local ? null : document.createElement('span');
        if (name) element.append(name);
        layer.append(element);
        bar = { element, fill, name };
        bars.set(id, bar);
      }
      if (bar.name && bar.name.textContent !== label) bar.name.textContent = label;
      point.set(x, y, z);
      const behind = relative.copy(point).sub(camera.position).dot(direction) <= .1;
      point.project(camera);
      bar.element.hidden = behind || Math.abs(point.x) > 1.05 || Math.abs(point.y) > 1.05 || point.z > 1;
      if (bar.element.hidden) return;
      bar.element.style.transform = 'translate(' + (point.x + 1) * width / 2 + 'px,' +
        (1 - point.y) * height / 2 + 'px) translate(-50%,-100%)';
      if (hp === bar.hp) return;
      bar.hp = hp;
      bar.fill.style.transform = 'scaleX(' + hp / maxHealth + ')';
      bar.element.classList.toggle('empty', hp === 0);
    },
    remove(id) {
      bars.get(id)?.element.remove();
      bars.delete(id);
    },
  };
}

export function mountSpawnGizmo(THREE, world, canvas, scene, camera, settings, actor, signal) {
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const point = new THREE.Vector3();
  const marker = new THREE.Group();
  const surface = new THREE.MeshBasicMaterial({ color: 0xaaffbf, side: THREE.DoubleSide, depthTest: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(.49, .63, 36), surface);
  ring.rotation.x = -Math.PI / 2;
  const pin = new THREE.Mesh(new THREE.ConeGeometry(.17, .42, 4), surface);
  pin.rotation.z = Math.PI;
  pin.position.y = .32;
  marker.add(ring, pin);
  marker.visible = false;
  marker.renderOrder = ring.renderOrder = pin.renderOrder = 3;
  scene.add(marker);
  let grabbing = null, active = false;
  const info = Object.assign(document.createElement('button'), { type: 'button', className: 'combat-spawn-help',
    textContent: 'Geser di map untuk menaruh titik respawn · Selesai', hidden: true });
  world.append(info);
  function toggle(value) {
    active = value;
    grabbing = null;
    info.hidden = !value;
    marker.visible = value;
    world.toggleAttribute('data-edit-spawn', value);
    const { x, z } = settings.spawn ?? actor;
    marker.position.set(x, .04, z);
    world.dispatchEvent(new CustomEvent('mawa:spawn-editing', { detail: value }));
  }
  function move(event) {
    const bounds = canvas.getBoundingClientRect();
    pointer.set((event.clientX - bounds.left) * 2 / bounds.width - 1, 1 - (event.clientY - bounds.top) * 2 / bounds.height);
    ray.setFromCamera(pointer, camera);
    if (!ray.ray.intersectPlane(ground, point)) return;
    const clamp = number => Math.round(10 * Math.max(-49, Math.min(49, number))) / 10;
    settings.spawn = { x: clamp(point.x), z: clamp(point.z) };
    marker.position.set(settings.spawn.x, .04, settings.spawn.z);
    world.dispatchEvent(new Event('mawa:spawn-point'));
  }
  const capture = { capture: true, signal };
  world.addEventListener('mawa:spawn-edit', () => toggle(!active), { signal });
  world.addEventListener('mawa:spawn-point', () => {
    if (!settings.spawn) marker.position.set(actor.x, .04, actor.z);
  }, { signal });
  world.querySelector('[data-close-developer]')?.addEventListener('click', () => { if (active) toggle(false); }, { signal });
  world.querySelector('#developerPanel')?.addEventListener('mawa:developer-tab', () => { if (active) toggle(false); }, { signal });
  world.addEventListener('mawa:hud-edit', () => { if (active) toggle(false); }, { signal });
  info.addEventListener('click', () => toggle(false), { signal });
  world.addEventListener('keydown', event => {
    if (active && event.key === 'Escape') { event.stopImmediatePropagation(); toggle(false); }
  }, capture);
  for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(kind, event => {
      if (!active || (kind === 'pointerdown' ? grabbing !== null || event.button !== 0 : grabbing !== event.pointerId)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (kind === 'pointerdown') {
        grabbing = event.pointerId;
        canvas.setPointerCapture(grabbing);
      }
      if (kind === 'pointerdown' || kind === 'pointermove') move(event);
      else grabbing = null;
    }, capture);
  }
  signal.addEventListener('abort', () => {
    toggle(false);
    marker.removeFromParent();
    for (const mesh of marker.children) mesh.geometry.dispose();
    surface.dispose();
    info.remove();
  }, { once: true });
}
