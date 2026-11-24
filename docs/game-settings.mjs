import { createDeveloperPatternGate } from './developer-pattern.mjs';
export const DEVELOPER_EMAIL = 'mawadatulsetiawan@gmail.com';

export const fields = {
  hudScale: { label: 'Ukuran HUD', min: 75, max: 125, value: 90, step: 5, unit: '%' },
  autoFov: { label: 'FOV mengikuti jarak zoom', value: true },
  baseFov: { label: 'FOV tetap', min: 35, max: 95, value: 58 },
  minFov: { label: 'Min FOV · kamera dekat', min: 35, max: 95, value: 46 },
  maxFov: { label: 'Max FOV · kamera jauh', min: 35, max: 95, value: 73 },
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

const categories = {
  Tampilan: { HUD: ['hudScale'] },
  Kamera: {
    'Field of View': ['autoFov', 'baseFov', 'minFov', 'maxFov'],
    'Zoom & Orbit': ['zoomMin', 'zoomMax', 'orbitSpeed', 'zoomSpeed'],
    Invert: ['invertPitch', 'invertYaw', 'invertZoom']
  },
  Gerakan: {
    Kecepatan: ['walkSpeed', 'runSpeed', 'sprintSpeed'],
    'Dash & Lompat': ['dashSpeed', 'dashSeconds', 'jumpSpeed', 'gravity']
  }
};

export function resolveFov(settings, distance) {
  if (!settings.autoFov) return settings.baseFov;
  const span = settings.zoomMax - settings.zoomMin;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (distance - settings.zoomMin) / span)) : 0;
  return settings.minFov + (settings.maxFov - settings.minFov) * ratio;
}

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
  if (clean.minFov > clean.maxFov) {
    clean.minFov = defaults.minFov;
    clean.maxFov = defaults.maxFov;
  }
  if (clean.zoomMin > clean.zoomMax || clean.walkSpeed > clean.runSpeed || clean.runSpeed > clean.sprintSpeed) {
    return { ...defaults };
  }
  return clean;
}

export function mountDeveloperPanel(world, save, current, signal, developerUid, canShare = true) {
  const toggle = world.querySelector('#openDeveloper');
  const panel = world.querySelector('#developerPanel');
  const form = panel.querySelector('form');
  const output = panel.querySelector('[role=status]');
  const group = form.querySelector('.developer-fields');
  const inputs = new Map();
  const saveButton = form.querySelector('button[type=submit]');
  const previousSaveText = saveButton.lastChild.textContent;
  if (!canShare) saveButton.lastChild.textContent = 'Simpan Lokal';
  function disclosure(parent, name) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = name;
    details.append(summary);
    parent.append(details);
    return details;
  }

  for (const [category, sections] of Object.entries(categories)) {
    if (category === 'Gerakan' && !canShare) continue;
    const categoryNode = disclosure(group, category);
    for (const [section, keys] of Object.entries(sections)) {
      const sectionNode = disclosure(categoryNode, section);
      for (const key of keys) {
        const field = fields[key];
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = typeof field.value === 'boolean' ? 'checkbox' : 'range';
        if (input.type === 'range') {
          label.className = 'range-field';
          input.min = field.min;
          input.max = field.max;
          input.step = field.step ?? (key === 'dashSeconds' ? '0.05' : key.endsWith('Fov') ? '1' : '0.1');
          const heading = document.createElement('span');
          const value = document.createElement('output');
          const updateValue = () => { value.value = input.value + (field.unit ?? (key.endsWith('Fov') ? '°' : '')); };
          heading.append(field.label, value);
          label.append(heading, input);
          input.addEventListener('input', updateValue, { signal });
          inputs.set(key, { input, updateValue });
        } else {
          label.append(field.label, input);
          inputs.set(key, { input });
        }
        sectionNode.append(label);
      }
    }
  }

  const updateFovFields = () => {
    const automatic = inputs.get('autoFov').input.checked;
    inputs.get('baseFov').input.disabled = automatic;
    inputs.get('minFov').input.disabled = !automatic;
    inputs.get('maxFov').input.disabled = !automatic;
  };
  inputs.get('autoFov').input.addEventListener('change', updateFovFields, { signal });
  const scale = inputs.get('hudScale').input;
  scale.addEventListener('input', () => {
    world.style.setProperty('--hud-preview-scale', scale.valueAsNumber / 100);
  }, { signal });
  const close = () => {
    world.style.removeProperty('--hud-preview-scale');
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  panel.querySelector('[data-close-developer]').addEventListener('click', () => {
    close();
    toggle.focus();
  }, { signal });
  const unlock = developerUid ? createDeveloperPatternGate(world, developerUid, signal) : open => open();
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    if (!panel.hidden) return close();
    unlock(openPanel);
  }, { signal });
  function openPanel() {
    for (const [key, { input, updateValue }] of inputs) {
      if (input.type === 'checkbox') input.checked = current[key];
      else { input.value = current[key]; updateValue(); }
    }
    updateFovFields();
    output.textContent = '';
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const next = Object.fromEntries([...inputs].map(([key, { input }]) => [
      key, input.type === 'checkbox' ? input.checked : input.valueAsNumber
    ]));
    if (next.minFov > next.maxFov) {
      output.textContent = 'Min FOV harus ≤ Max FOV.';
      return;
    }
    if (next.zoomMin > next.zoomMax || (canShare && (next.walkSpeed > next.runSpeed || next.runSpeed > next.sprintSpeed))) {
      output.textContent = 'Zoom minimum harus ≤ maksimum. Kecepatan harus berurutan dari jalan, lari, lalu sprint.';
      return;
    }
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;
    output.textContent = 'Menyimpan…';
    try {
      await save(next);
      if (!signal.aborted) output.textContent = canShare ? 'Tersimpan dan berlaku untuk semua pemain.' : 'Tersimpan untuk sesi ini.';
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
    saveButton.lastChild.textContent = previousSaveText;
    group.replaceChildren();
  }, { once: true });
}

export function mountDeveloperTabs(world, signal) {
  const panel = world.querySelector('#developerPanel');
  const form = panel.querySelector('form');
  const group = form.querySelector('.developer-fields');
  const save = form.querySelector('button[type=submit]');
  const output = form.querySelector(':scope > [role=status]');
  const groups = {
    camera: ['◉', 'Kamera', ['Mode Kamera', 'Kamera']],
    effects: ['✦', 'Efek', ['Camera Shake & Fade']],
    hud: ['▦', 'HUD', ['Tata Letak HUD', 'Tampilan']],
    character: ['◇', 'Karakter', ['Edit Karakter']],
    movement: ['↗', 'Gerak', ['Gerakan']],
  };
  const sections = [...group.children];
  const tabs = document.createElement('div');
  tabs.className = 'developer-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Kategori Developer');
  const pages = new Map();

  for (const [id, [symbol, name, headings]] of Object.entries(groups)) {
    const matches = sections.filter(node => headings.includes(node.querySelector('summary')?.textContent));
    if (!matches.length) continue;
    const page = document.createElement('div');
    page.className = 'developer-tab-page';
    page.id = 'developer-page-' + id;
    page.setAttribute('role', 'tabpanel');
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'developer-tab-' + id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', page.id);
    page.setAttribute('aria-labelledby', button.id);
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = symbol;
    button.append(icon, name);
    page.append(...matches);
    pages.set(id, { button, page });
    tabs.append(button);
    group.append(page);
    button.addEventListener('click', () => select(id), { signal });
  }
  const order = [...pages.keys()];
  if (!order.length) return;
  tabs.style.setProperty('--developer-tab-count', order.length);

  function select(id) {
    for (const [key, { button, page }] of pages) {
      const active = key === id;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      page.hidden = !active;
    }
    save.hidden = id === 'effects' || id === 'character';
    if (output) output.hidden = id === 'effects' || id === 'character';
    group.scrollTop = 0;
    panel.dispatchEvent(new CustomEvent('mawa:developer-tab', { detail: id }));
  }

  tabs.addEventListener('keydown', event => {
    const index = order.findIndex(key => pages.get(key).button === event.target);
    if (index < 0) return;
    const offsets = { ArrowLeft: order.length - 1, ArrowRight: 1 };
    let next = offsets[event.key] !== undefined ? (index + offsets[event.key]) % order.length : -1;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = order.length - 1;
    if (next < 0) return;
    event.preventDefault();
    select(order[next]);
    pages.get(order[next]).button.focus();
  }, { signal });

  group.addEventListener('toggle', event => {
    const detail = event.target;
    if (!(detail instanceof HTMLDetailsElement) || !detail.open) return;
    for (const sibling of detail.parentElement.children) {
      if (sibling !== detail && sibling instanceof HTMLDetailsElement) sibling.open = false;
    }
  }, { capture: true, signal });
  for (const { page } of pages.values()) {
    if (page.firstElementChild instanceof HTMLDetailsElement) page.firstElementChild.open = true;
  }
  group.before(tabs);
  panel.classList.add('developer-compact');
  select(order[0]);
  signal.addEventListener('abort', () => {
    tabs.remove();
    panel.classList.remove('developer-compact');
    save.hidden = false;
    if (output) output.hidden = false;
  }, { once: true });
}
