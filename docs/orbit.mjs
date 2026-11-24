export function bindOrbit(canvas, settings, signal, handler) {
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
  canvas.addEventListener('pointerdown', event => {
    const right = event.pointerType === 'mouse' && event.button === 2;
    if (pointers.size >= 2 || (event.pointerType === 'mouse' && event.button !== 0 &&
      !(right && handler?.canOrbit?.()))) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType, right });
    canvas.setPointerCapture(event.pointerId);
  }, options);
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
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
    if (previous.right) {
      if (event.buttons & 2) handler?.orbitDrag?.(dx, dy);
      else pointers.delete(event.pointerId);
      return;
    }
    if (handler?.drag(dx, dy)) return;
    orbit.yaw -= dx * 0.005 * settings.orbitSpeed * (settings.invertYaw ? -1 : 1);
    orbit.pitch = clamp(orbit.pitch + dy * 0.005 * settings.orbitSpeed * (settings.invertPitch ? -1 : 1), 0.12, 1.32);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, event => pointers.delete(event.pointerId), options);
  }
  canvas.addEventListener('contextmenu', event => {
    if (handler?.canOrbit?.()) event.preventDefault();
  }, options);
  window.addEventListener('blur', () => pointers.clear(), options);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom(clamp(pixels, -250, 250) * 0.0015);
  }, { signal, passive: false });
  return { orbit, clampDistance };
}
