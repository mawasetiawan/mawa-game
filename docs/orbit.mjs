export function bindOrbit(canvas, settings, signal) {
  const pointers = new Map();
  const orbit = { yaw: 0, pitch: 0.44, distance: 7.4 };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const options = { signal };
  const clampDistance = () => { orbit.distance = clamp(orbit.distance, settings.zoomMin, settings.zoomMax); };
  const zoom = amount => {
    orbit.distance *= Math.exp(amount * settings.zoomSpeed * (settings.invertZoom ? -1 : 1));
    clampDistance();
  };
  const separation = () => {
    const [a, b] = pointers.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener('pointerdown', event => {
    if (pointers.size >= 2 || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    canvas.setPointerCapture(event.pointerId);
  }, options);
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const pinch = pointers.size === 2 && [...pointers.values()].every(point => point.type === 'touch');
    const before = pinch ? separation() : 0;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    previous.x = event.clientX;
    previous.y = event.clientY;
    if (pinch) {
      const after = separation();
      if (before > 6 && after > 6) zoom(Math.log(before / after));
      return;
    }
    orbit.yaw -= dx * 0.005 * settings.orbitSpeed * (settings.invertYaw ? -1 : 1);
    orbit.pitch = clamp(orbit.pitch + dy * 0.005 * settings.orbitSpeed * (settings.invertPitch ? -1 : 1), 0.12, 1.32);
  }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(name, event => pointers.delete(event.pointerId), options);
  }
  window.addEventListener('blur', () => pointers.clear(), options);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    zoom(clamp(pixels, -250, 250) * 0.0015);
  }, { signal, passive: false });
  return { orbit, clampDistance };
}
