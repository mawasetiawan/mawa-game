const tapDelay = 330;
const tapDistance = 28;

export function preventWorldDoubleTap(world, signal) {
  let start, last;
  const options = { passive: false, signal };
  const reset = () => { start = last = undefined; };

  world.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) { reset(); return; }
    const touch = event.changedTouches[0];
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp };
  }, options);

  world.addEventListener('touchend', event => {
    const first = start;
    start = undefined;
    if (!first || event.touches.length || event.changedTouches.length !== 1) { last = undefined; return; }
    const touch = event.changedTouches[0];
    if (touch.identifier !== first.id || event.timeStamp - first.time > tapDelay ||
        Math.hypot(touch.clientX - first.x, touch.clientY - first.y) > tapDistance ||
        event.target.closest?.('input, textarea, select, [contenteditable]')) {
      last = undefined;
      return;
    }

    const tap = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    const doubleTap = last && tap.time - last.time <= tapDelay &&
      Math.hypot(tap.x - last.x, tap.y - last.y) <= tapDistance;
    last = tap;
    if (!doubleTap || event.defaultPrevented || !event.cancelable) return;
    event.preventDefault();
    // Keep real HUD taps working when the browser's synthetic click is suppressed.
    event.target.closest?.('button, a[href], summary')?.click();
  }, options);

  world.addEventListener('touchcancel', reset, options);
  for (const name of ['gesturestart', 'gesturechange']) {
    world.addEventListener(name, event => { if (event.cancelable) event.preventDefault(); }, options);
  }
}

export function isWorldTextOrMenu(target) {
  return Boolean(target.closest?.('input, textarea, select, [contenteditable], dialog, .developer-panel, .chat[data-open]'));
}
