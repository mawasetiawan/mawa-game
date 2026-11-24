import { decodeCameraScript, mountScriptImport } from './scripted-camera.mjs?v=2';

export const cameraModes = {
  scripted: { label: 'Scripted Camera', fields: { smoothing: ['Smoothing', 0, 2, 0.12] } },
  follow: { label: 'Third Person', fields: { smoothing: ['Smoothing', 0, 2, 0.14] } },
  side: { label: 'Side Scroller', fields: {
    fov: ['FOV', 25, 110, 48], distance: ['Jarak kamera', 2, 40, 12],
    yaw: ['Sudut horizontal', -180, 180, 90], pitch: ['Kemiringan', 0, 80, 10],
    height: ['Tinggi titik fokus', 0, 5, 1], smoothing: ['Smoothing', 0, 2, 0.18],
  } },
  fps: { label: 'First Person (FPS)', fields: {
    fov: ['FOV', 25, 110, 78], height: ['Tinggi mata', 0.3, 3, 1.55],
    offset: ['Offset maju mata', 0, 1, 0], look: ['Sensitivitas lihat', 0.2, 4, 1],
    smoothing: ['Smoothing', 0, 2, 0.07],
  } },
  top: { label: 'Top Down', fields: {
    fov: ['FOV', 25, 110, 48], distance: ['Jarak kamera', 2, 40, 15],
    yaw: ['Sudut horizontal', -180, 180, 0], pitch: ['Kemiringan', 30, 89, 85],
    height: ['Tinggi titik fokus', 0, 5, 0], smoothing: ['Smoothing', 0, 2, 0.22],
  } },
  drone: { label: 'Drone Follow', fields: {
    fov: ['FOV', 25, 110, 58], altitude: ['Ketinggian drone', 2, 35, 9],
    distance: ['Jarak horizontal', 2, 40, 11], yaw: ['Sudut awal', -180, 180, 25],
    height: ['Tinggi titik fokus', 0, 5, 1], lead: ['Antisipasi gerakan (detik)', 0, 1, 0.22],
    zoom: ['Sensitivitas zoom', 0.2, 4, 1],
    smoothing: ['Smoothing', 0, 2, 0.28],
  } },
  rts: { label: 'RTS · Free Camera', fields: {
    fov: ['FOV', 25, 110, 52], distance: ['Jarak awal', 2, 40, 17],
    yaw: ['Sudut horizontal', -180, 180, 0], pitch: ['Kemiringan', 25, 89, 55],
    minZoom: ['Jarak zoom minimum', 2, 40, 4], maxZoom: ['Jarak zoom maksimum', 2, 60, 40],
    orbitLook: ['Enable Orbital Look', null, null, false],
    orbitLookSpeed: ['Sensitivitas orbit', 0.2, 4, 1],
    grab: ['Grab strength', 0.2, 4, 1], zoom: ['Sensitivitas zoom', 0.2, 4, 1],
    smoothing: ['Smoothing', 0, 2, 0.23],
  } },
};

export function parseCamera(value) {
  const mode = Object.hasOwn(cameraModes, value?.mode) ? value.mode : 'follow';
  const clean = { mode };
  for (const [key, [, min, max, fallback]] of Object.entries(cameraModes[mode].fields)) {
    const number = value?.[key];
    if (typeof fallback === 'boolean') {
      clean[key] = typeof number === 'boolean' ? number : fallback;
      continue;
    }
    clean[key] = Number.isFinite(number) && number >= min && number <= max ? number : fallback;
  }
  if (mode === 'scripted' && typeof value.script === 'string') {
    try { clean.script = JSON.stringify(decodeCameraScript(value.script)); } catch { /* Ignore invalid saved timelines. */ }
  }
  if (mode === 'rts') {
    clean.maxZoom = Math.max(clean.minZoom, clean.maxZoom);
    clean.distance = Math.max(clean.minZoom, Math.min(clean.maxZoom, clean.distance));
  }
  return clean;
}

export function mountCameraPanel(world, { current, presets, applyLocal, clearLocal }, signal) {
  const host = world.querySelector('.developer-fields');
  const section = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = 'Mode Kamera';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Mode kamera');
  for (const [mode, { label }] of Object.entries(cameraModes)) select.add(new Option(label, mode));
  const controls = document.createElement('div');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const buttons = document.createElement('div');
  buttons.className = 'camera-buttons';
  const applied = new Map(Object.keys(cameraModes).filter(mode => presets?.[mode]?.mode === mode)
    .map(mode => [mode, parseCamera(presets[mode])]));
  const drafts = new Map([...applied].map(([mode, value]) => [mode, { ...value }]));
  let active = parseCamera(current());
  drafts.set(active.mode, active);
  applied.set(active.mode, { ...active });
  select.value = active.mode;

  function render() {
    active = drafts.get(select.value) ?? parseCamera({ mode: select.value });
    drafts.set(active.mode, active);
    controls.replaceChildren();
    if (active.mode === 'scripted') mountScriptImport(controls, () => active, cameraModes, signal);
    for (const [key, [name, min, max]] of Object.entries(cameraModes[active.mode].fields)) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      if (typeof active[key] === 'boolean') {
        input.type = 'checkbox';
        input.checked = active[key];
        input.addEventListener('change', () => { active[key] = input.checked; }, { signal });
        label.append(name, input);
        controls.append(label);
        continue;
      }
      input.type = 'number';
      input.min = min;
      input.max = max;
      input.step = 'any';
      input.value = active[key];
      input.addEventListener('input', () => { active[key] = input.valueAsNumber; }, { signal });
      label.append(name, input);
      controls.append(label);
    }
  }

  function action(label, run, success) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', async () => {
      const inputs = [...controls.querySelectorAll('input[type=number]')];
      if (!inputs.every(input => Number.isFinite(input.valueAsNumber) && input.checkValidity())) {
        status.textContent = 'Isi semua pengaturan kamera sesuai batasnya.';
        return;
      }
      if (active.mode === 'rts' && active.minZoom > active.maxZoom) {
        status.textContent = 'Jarak zoom minimum harus di bawah atau sama dengan maksimum.';
        return;
      }
      if (active.mode === 'scripted' && !active.script) {
        status.textContent = 'Impor script terlebih dahulu.';
        return;
      }
      button.disabled = true;
      try {
        await run(parseCamera(active));
        status.textContent = success;
      } catch {
        status.textContent = 'Pengaturan kamera gagal diterapkan.';
      } finally {
        button.disabled = false;
      }
    }, { signal });
    buttons.append(button);
  }

  select.addEventListener('change', render, { signal });
  controls.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  }, { signal });
  const snapshot = () => Object.fromEntries(applied);
  action('Apply Setting', next => {
    applied.set(next.mode, next);
    return applyLocal(next, snapshot());
  }, 'Kamera diterapkan ke pemain lokal.');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Ikuti Kamera Bersama';
  reset.addEventListener('click', () => {
    clearLocal();
    const next = parseCamera(current());
    applied.set(next.mode, { ...next });
    drafts.set(next.mode, next);
    select.value = next.mode;
    render();
    status.textContent = 'Sekarang mengikuti pengaturan bersama.';
  }, { signal });
  buttons.append(reset);
  section.append(title, select, controls, buttons, status);
  host.prepend(section);
  render();
  return { snapshot };
}
