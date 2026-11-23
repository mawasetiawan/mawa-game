export const DEVELOPER_EMAIL = 'mawadatulsetiawan@gmail.com';

export const fields = {
  zoomMin: { label: 'Zoom minimum', min: 2, max: 16, value: 3 },
  zoomMax: { label: 'Zoom maksimum', min: 3, max: 30, value: 14 },
  orbitSpeed: { label: 'Sensitivitas orbit', min: 0.1, max: 3, value: 1 },
  zoomSpeed: { label: 'Sensitivitas zoom', min: 0.1, max: 3, value: 1 },
  walkSpeed: { label: 'Kecepatan jalan', min: 0.5, max: 10, value: 2 },
  runSpeed: { label: 'Kecepatan lari', min: 1, max: 15, value: 4.5 },
  sprintSpeed: { label: 'Kecepatan sprint', min: 2, max: 24, value: 7.5 },
  dashSpeed: { label: 'Kecepatan dash', min: 2, max: 36, value: 15 },
  dashSeconds: { label: 'Durasi dash (detik)', min: 0.05, max: 1, value: 0.2 },
  jumpSpeed: { label: 'Kecepatan lompat', min: 2, max: 8, value: 6.6 },
  gravity: { label: 'Gravitasi', min: 10, max: 40, value: 20 },
  invertPitch: { label: 'Invert pitch', value: false },
  invertYaw: { label: 'Invert yaw', value: false },
  invertZoom: { label: 'Invert zoom', value: false }
};

export const defaults = Object.freeze(Object.fromEntries(
  Object.entries(fields).map(([key, field]) => [key, field.value])
));

export function parseSettings(values) {
  const clean = { ...defaults };
  for (const [key, field] of Object.entries(fields)) {
    const value = values?.[key];
    if (typeof field.value === 'boolean') {
      if (typeof value === 'boolean') clean[key] = value;
    } else if (Number.isFinite(value) && value >= field.min && value <= field.max) {
      clean[key] = value;
    }
  }
  if (clean.zoomMin > clean.zoomMax || clean.walkSpeed > clean.runSpeed || clean.runSpeed > clean.sprintSpeed) {
    return { ...defaults };
  }
  return clean;
}

export function mountDeveloperPanel(world, save, current, signal) {
  const toggle = world.querySelector('#openDeveloper');
  const panel = world.querySelector('#developerPanel');
  const form = panel.querySelector('form');
  const output = panel.querySelector('[role=status]');
  const group = form.querySelector('.developer-fields');
  const inputs = new Map();
  for (const [key, field] of Object.entries(fields)) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement('input');
    input.type = typeof field.value === 'boolean' ? 'checkbox' : 'number';
    if (input.type === 'number') {
      input.min = field.min;
      input.max = field.max;
      input.step = 'any';
      input.required = true;
    }
    inputs.set(key, input);
    label.append(input);
    group.append(label);
  }
  const close = () => {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    if (!panel.hidden) return close();
    for (const [key, input] of inputs) {
      if (input.type === 'checkbox') input.checked = current[key];
      else input.value = current[key];
    }
    output.textContent = '';
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }, { signal });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const next = Object.fromEntries([...inputs].map(([key, input]) => [
      key, input.type === 'checkbox' ? input.checked : input.valueAsNumber
    ]));
    if (next.zoomMin > next.zoomMax || next.walkSpeed > next.runSpeed || next.runSpeed > next.sprintSpeed) {
      output.textContent = 'Zoom minimum harus ≤ maksimum. Kecepatan harus berurutan dari jalan, lari, lalu sprint.';
      return;
    }
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    output.textContent = 'Menyimpan…';
    try {
      await save(next);
      if (!signal.aborted) output.textContent = 'Tersimpan dan berlaku untuk semua pemain.';
    } catch (error) {
      console.error(error);
      if (!signal.aborted) output.textContent = 'Gagal menyimpan pengaturan. Coba lagi.';
    } finally {
      submit.disabled = false;
    }
  }, { signal });
  signal.addEventListener('abort', () => {
    close();
    toggle.hidden = true;
    group.replaceChildren();
  }, { once: true });
}
