export function bindOrbit(canvas, settings, signal, handler, desktopControls) {
  const pointers = new Map();
  const orbit = { yaw: 0, pitch: 0.44, distance: 7.4 };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const options = { signal };
  const clampDistance = () => { orbit.distance = clamp(orbit.distance, settings.zoomMin, settings.zoomMax); };
  const zoom = amount => {
    if (handler?.zoom(amount)) return;
    orbit.distance *= Math.exp(amount * settings.zoomSpeed * (settings.invertZoom ? -1 : 1));
    clampDistance();
  };
  const touchPair = () => {
    const [a, b] = pointers.values();
    return { distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  const buttonMasks = [1, 4, 2, 8, 16];
  canvas.addEventListener('pointerdown', event => {
    if (desktopControls?.blocked() || pointers.size >= 2) return;
    const mouse = event.pointerType === 'mouse';
    const desktopMouse = mouse && desktopControls?.desktop();
    const right = mouse && event.button === 2;
    if (desktopMouse ? event.button !== desktopControls.button() :
      (mouse && event.button !== 0 && !(right && handler?.canOrbit?.()))) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType,
      buttonMask: mouse ? buttonMasks[event.button] : 0, orbitOnly: !desktopMouse && right });
    canvas.setPointerCapture(event.pointerId);
  }, options);
  function move(dx, dy, orbitOnly = false) {
    if (orbitOnly || (desktopControls?.desktop() && handler?.canOrbit?.())) {
      handler?.orbitDrag?.(dx, dy);
      return;
    }
    if (handler?.drag(dx, dy)) return;
    orbit.yaw -= dx * 0.005 * settings.orbitSpeed * (settings.invertYaw ? -1 : 1);
    orbit.pitch = clamp(orbit.pitch + dy * 0.005 * settings.orbitSpeed * (settings.invertPitch ? -1 : 1), 0.12, 1.32);
  }
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (desktopControls?.blocked()) return;
    if (!previous) {
      if (event.pointerType === 'mouse' && desktopControls?.desktop() && desktopControls.held()) {
        move(event.movementX, event.movementY);
      }
      return;
    }
    if (previous.buttonMask && !(event.buttons & previous.buttonMask)) {
      pointers.delete(event.pointerId);
      return;
    }
    const pinch = pointers.size === 2 && [...pointers.values()].every(point => point.type === 'touch');
    const before = pinch ? touchPair() : null;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    if (pinch) {
      const after = touchPair();
      if (before.distance > 6 && after.distance > 6) {
        const delta = after.angle - before.angle;
        handler?.twist?.(Math.atan2(Math.sin(delta), Math.cos(delta)));
        zoom(Math.log(before.distance / after.distance));
      }
      return;
    }
    move(dx, dy, previous.orbitOnly);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, event => pointers.delete(event.pointerId), options);
  }
  canvas.addEventListener('contextmenu', event => {
    if (handler?.canOrbit?.() || (desktopControls?.desktop() && desktopControls.button() === 2)) event.preventDefault();
  }, options);
  window.addEventListener('blur', () => pointers.clear(), options);
  canvas.addEventListener('wheel', event => {
    if (desktopControls?.blocked()) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom(clamp(pixels, -250, 250) * 0.0015);
  }, { signal, passive: false });
  return { orbit, clampDistance };
}
