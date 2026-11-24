export const cameraEvents = Object.freeze({ shake: 'mawa:camera-shake', fade: 'mawa:camera-fade' });
export const cameraCueDefaults = Object.freeze({
  shake: Object.freeze({ amplitude: .16, frequency: 11, duration: .35, decay: 3 }),
  fade: Object.freeze({ color: '#000000', opacity: 1, fadeOut: .25, hold: .15, fadeIn: .35, includeHud: false }),
});

const configured = new WeakMap();
const bound = (v, min, max, fallback) => Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
export function triggerCameraCue(world, kind, settings = {}) {
  if (!Object.hasOwn(cameraEvents, kind)) throw Error('Camera cue tidak dikenal.');
  world.dispatchEvent(new CustomEvent(cameraEvents[kind], { detail: settings }));
}

export function createCameraCues(world, signal) {
  const overlay = document.createElement('div');
  overlay.className = 'camera-fade-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  world.append(overlay);
  const shakes = [];
  const offset = [0, 0, 0];
  let fade;
  world.addEventListener(cameraEvents.shake, ({ detail }) => {
    const d = { ...cameraCueDefaults.shake, ...configured.get(world)?.shake, ...detail };
    if (shakes.length >= 8) shakes.shift();
    shakes.push({ time: 0,
      amplitude: bound(d.amplitude, 0, 2, .16), frequency: bound(d.frequency, 1, 45, 11),
      duration: bound(d.duration, .02, 5, .35), decay: bound(d.decay, 0, 8, 3) });
  }, { signal });
  world.addEventListener(cameraEvents.fade, ({ detail }) => {
    const d = { ...cameraCueDefaults.fade, ...configured.get(world)?.fade, ...detail };
    fade = { time: 0, start: Number(overlay.style.opacity) || 0, opacity: bound(d.opacity, 0, 1, 1),
      fadeOut: bound(d.fadeOut, 0, 10, .25), hold: bound(d.hold, 0, 20, .15), fadeIn: bound(d.fadeIn, 0, 10, .35) };
    overlay.style.background = /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#000000';
    overlay.classList.toggle('camera-fade-hud', d.includeHud === true);
  }, { signal });
  signal.addEventListener('abort', () => overlay.remove(), { once: true });
  return dt => {
    offset.fill(0);
    for (let index = shakes.length - 1; index >= 0; index--) {
      const shake = shakes[index];
      shake.time += dt;
      if (shake.time >= shake.duration) { shakes.splice(index, 1); continue; }
      const t = shake.time / shake.duration;
      const strength = shake.amplitude * (1 - t) * Math.exp(-shake.decay * t);
      for (let axis = 0; axis < 3; axis++) {
        offset[axis] += Math.sin(2 * Math.PI * shake.frequency * shake.time * (1 - axis * .19)) * strength;
      }
    }
    if (fade) {
      fade.time += dt;
      const remaining = fade.time - fade.fadeOut - fade.hold;
      const ease = t => t * t * (3 - 2 * t);
      if (fade.time < fade.fadeOut) {
        overlay.style.opacity = fade.start + (fade.opacity - fade.start) * ease(fade.time / fade.fadeOut);
      } else if (remaining <= 0) overlay.style.opacity = fade.opacity;
      else if (remaining < fade.fadeIn) overlay.style.opacity = fade.opacity * (1 - ease(remaining / fade.fadeIn));
      else { overlay.style.opacity = 0; fade = undefined; }
    }
    return offset;
  };
}

export function mountCameraCuePanel(world, signal, preset) {
  const initial = {};
  for (const [kind, defaults] of Object.entries(cameraCueDefaults)) {
    const options = preset?.[kind];
    if (!options || typeof options !== 'object') continue;
    initial[kind] = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
      key, typeof options[key] === typeof value && (typeof value !== 'number' || Number.isFinite(options[key])) ? options[key] : value,
    ]));
  }
  if (Object.keys(initial).length) configured.set(world, initial);
  const section = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Camera Shake & Fade';
  section.append(summary);
  const names = {
    amplitude: ['Amplitudo', 0, 2], frequency: ['Frekuensi (Hz)', 1, 45],
    duration: ['Durasi (detik)', .02, 5], decay: ['Decay', 0, 8],
    opacity: ['Opasitas', 0, 1], fadeOut: ['Fade ke warna (detik)', 0, 10],
    hold: ['Tahan (detik)', 0, 20], fadeIn: ['Kembali terlihat (detik)', 0, 10],
    color: ['Warna'], includeHud: ['Tutup HUD'],
  };
  for (const [kind, defaults] of Object.entries(cameraCueDefaults)) {
    const group = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = kind === 'shake' ? 'Shake' : 'Fade';
    group.append(title);
    const inputs = [];
    for (const [key, value] of Object.entries(defaults)) {
      const [name, min, max] = names[key];
      const input = document.createElement('input');
      const label = document.createElement('label');
      input.type = typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'color';
      if (input.type === 'number') Object.assign(input, { min, max, step: 'any', value });
      else if (input.type === 'checkbox') input.checked = value;
      else input.value = value;
      const current = configured.get(world)?.[kind]?.[key];
      if (current !== undefined) {
        if (input.type === 'checkbox') input.checked = current;
        else input.value = current;
      }
      label.append(name, input);
      group.append(label);
      inputs.push([key, input]);
    }
    const actions = document.createElement('div');
    actions.className = 'camera-buttons';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const button = (label, action) => {
      const control = document.createElement('button');
      control.type = 'button';
      control.textContent = label;
      control.addEventListener('click', () => {
        const invalid = inputs.find(([, input]) => !input.checkValidity() ||
          (input.type === 'number' && !Number.isFinite(input.valueAsNumber)));
        if (invalid) { invalid[1].focus(); invalid[1].reportValidity(); return; }
        action(Object.fromEntries(inputs.map(([key, input]) =>
          [key, input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value])));
      }, { signal });
      actions.append(control);
    };
    button('Uji ' + title.textContent, options => triggerCameraCue(world, kind, options));
    button('Terapkan Default', options => {
      configured.set(world, { ...configured.get(world), [kind]: options });
      status.textContent = 'Default sesi lokal diterapkan. Opsi event tetap bisa menimpanya.';
    });
    group.append(actions, status);
    section.append(group);
  }
  section.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
  }, { signal });
  world.querySelector('.developer-fields').append(section);
  return { snapshot: () => ({ ...configured.get(world) }) };
}
