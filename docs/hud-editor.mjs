const targets = {
  joystick: ['Joystick', '#joystick'],
  jump: ['Lompat', '[data-action=jump]'],
  walk: ['Jalan', '[data-action=walk]'],
  sprint: ['Sprint', '[data-action=sprint]'],
  interact: ['Interaksi', '[data-action=interact]'],
  back: ['Keluar Map', '#back'],
  developer: ['Developer', '#openDeveloper'],
  fullscreen: ['Fullscreen', '#fullscreen'],
  map: ['Judul Map', '.hud-tag'],
  compass: ['Kompas', '.hud-compass'],
  chat: ['Panel Chat', '#chat'],
  chatToggle: ['Preview Chat', '#chatToggle'],
  chatClose: ['Tutup Chat', '#chatClose'],
  send: ['Kirim', '#send'],
  draft: ['Kolom Pesan', '#message'],
  history: ['Riwayat Chat', '#messages'],
  keyboard: ['Keyboard Chat', '#chatKeyboard'],
};

const profiles = { desktop: 'Desktop', portrait: 'Mobile Potret', landscape: 'Mobile Lanskap' };
const fields = {
  x: ['Geser X (%)', -80, 80, 0], y: ['Geser Y (%)', -80, 80, 0],
  sx: ['Lebar (%)', 35, 250, 100], sy: ['Tinggi (%)', 35, 250, 100],
  angle: ['Rotasi (°)', -180, 180, 0],
  border: ['Tebal border (px)', -1, 16, -1], corner: ['Radius sudut (px)', -1, 100, -1],
  radius: ['Radius joystick (px)', -1, 120, -1],
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalizeAngle = value => ((value + 180) % 360 + 360) % 360 - 180;


export function hudFrame(rect, left, top, width, height) {
  return { left: rect.left + left, top: rect.top + top, width, height,
    right: rect.left + left + width, bottom: rect.top + top + height };
}

export function keepHudInFrame(box, frame, gap = 8) {
  const fit = (start, size, min, max) => {
    const available = max - min - 2 * gap;
    return available >= size ? clamp(start, min + gap, max - gap - size) - start :
      (min + max - size) / 2 - start;
  };
  return [fit(box.left, box.width, frame.left, frame.right),
    fit(box.top, box.height, frame.top, frame.bottom)];
}

function screenTranslation(node, dx, dy) {
  // Independent CSS translate uses the parent's axes, before the element's own rotation.
  let basis = new DOMMatrix();
  let zoom = 1;
  for (let item = node; item; item = item.parentElement) {
    const style = getComputedStyle(item);
    zoom *= parseFloat(style.zoom) || 1;
    if (item === node) continue;
    const transform = style.transform === 'none' ? new DOMMatrix() : new DOMMatrix(style.transform);
    const angle = parseFloat(style.rotate) || 0;
    const scales = style.scale === 'none' || !style.scale ? [1,1] : style.scale.split(' ').map(Number);
    const matrix = new DOMMatrix().rotate(angle).scale(scales[0], scales[1] ?? scales[0]).multiply(transform);
    matrix.e = matrix.f = 0;
    basis = matrix.multiply(basis);
  }
  zoom = node.currentCSSZoom || zoom;
  const inverse = basis.inverse();
  const x = (inverse.a * dx + inverse.c * dy) / zoom;
  const y = (inverse.b * dx + inverse.d * dy) / zoom;
  return (Number.isFinite(x) ? x : 0) + 'px ' + (Number.isFinite(y) ? y : 0) + 'px';
}


export function sanitizeHudLayout(value) {
  const result = {};
  for (const profile of Object.keys(profiles)) {
    result[profile] = {};
    for (const key of Object.keys(targets)) {
      const input = value?.[profile]?.[key];
      if (!input || typeof input !== 'object') continue;
      result[profile][key] = Object.fromEntries(Object.entries(fields).map(([id, [, min, max, initial]]) =>
        [id, Number.isFinite(input[id]) ? clamp(input[id], min, max) : initial]));
    }
  }
  return result;
}

export function mountHudEditor(world, signal, namespace, preset) {
  const storageKey = 'mawa.hud-layout.v1.' + namespace;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch { /* Use defaults. */ }
  let layouts = sanitizeHudLayout(preset ?? saved);
  const hud = world.querySelector('.gameplay-hud');
  const panel = world.querySelector('#developerPanel');
  const touch = matchMedia('(pointer: coarse)');
  const landscape = matchMedia('(orientation: landscape)');
  const currentProfile = () => {
    if (!touch.matches) return 'desktop';
    const type = window.screen?.orientation?.type;
    const rotation = window.orientation;
    const wide = type ? type.startsWith('landscape') : typeof rotation === 'number'
      ? Math.abs(rotation) === 90 : landscape.matches;
    return wide ? 'landscape' : 'portrait';
  };
  const nodes = Object.fromEntries(Object.entries(targets).map(([key, [, selector]]) => [key, hud.querySelector(selector)]));
  const originals = new Map();
  const outline = document.createElement('div');
  outline.className = 'hud-gizmo';
  outline.hidden = true;
  world.append(outline);
  const section = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = 'Tata Letak HUD';
  const profile = document.createElement('select');
  profile.setAttribute('aria-label', 'Profil tata letak');
  for (const [key, label] of Object.entries(profiles)) profile.add(new Option(label, key));
  const element = document.createElement('select');
  element.setAttribute('aria-label', 'Elemen HUD');
  for (const [key, [label]] of Object.entries(targets)) {
    if (nodes[key]) element.add(new Option(label, key));
  }
  const controls = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'camera-buttons';
  const hint = document.createElement('p');
  hint.textContent = 'Drag untuk geser. Pinch untuk skala dan rotasi. Border/radius −1 mengikuti tema.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  let active = false;
  let frame;
  let viewportFrame;
  let deviceProfile = currentProfile();
  let baseline;
  const pointers = new Map();
  const inputs = new Map();
  profile.value = currentProfile();

  function restore() {
    for (const [node, original] of originals) {
      for (const [property, value] of Object.entries(original)) node.style[property] = value;
    }
    originals.clear();
  }

  function stageFrame() {
    return hudFrame(world.getBoundingClientRect(), world.clientLeft, world.clientTop,
      world.clientWidth, world.clientHeight);
  }

  function apply() {
    restore();
    const bounds = stageFrame();
    for (const [key, value] of Object.entries(layouts[active ? profile.value : currentProfile()])) {
      const node = nodes[key];
      if (!node) continue;
      const dx = value.x * bounds.width / 100;
      const dy = value.y * bounds.height / 100;
      const edited = {
        rotate: value.angle + 'deg',
        scale: value.sx / 100 + ' ' + value.sy / 100,
        translate: screenTranslation(node, dx, dy),
      };
      if (value.border >= 0) {
        edited.borderWidth = value.border + 'px';
        edited.borderStyle = 'solid';
        edited.borderColor = 'currentColor';
      }
      if (value.corner >= 0) edited.borderRadius = value.corner + 'px';
      if (key === 'joystick' && value.radius >= 8) edited.width = value.radius * 2 + 'px';
      originals.set(node, Object.fromEntries(Object.keys(edited).map(property => [property,node.style[property]])));
      Object.assign(node.style,edited);
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || !bounds.width || !bounds.height) continue;
      const [fixX, fixY] = keepHudInFrame(box, bounds);
      if (fixX || fixY) node.style.translate = screenTranslation(node, dx + fixX, dy + fixY);
    }
  }

  function selected() {
    const key = element.value;
    const layout = layouts[profile.value];
    return layout[key] ??= Object.fromEntries(Object.entries(fields).map(([id, field]) => [id, field[3]]));
  }

  function sync() {
    const value = selected();
    for (const [key, input] of inputs) {
      input.closest('label').hidden = key === 'radius' && element.value !== 'joystick';
      if (document.activeElement !== input) input.value = Math.round(value[key] * 10) / 10;
    }
    apply();
  }

  for (const [key, [text, min, max]] of Object.entries(fields)) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min, max, step: 'any' });
    input.addEventListener('input', () => {
      if (!active || !Number.isFinite(input.valueAsNumber) || !input.checkValidity()) return;
      selected()[key] = input.valueAsNumber;
      apply();
    }, { signal });
    label.append(text,input);
    controls.append(label);
    inputs.set(key,input);
  }

  function placeGizmo() {
    const node = nodes[element.value];
    const bounds = node?.getBoundingClientRect();
    outline.hidden = !bounds?.width || !bounds?.height;
    if (!outline.hidden) {
      const stage = stageFrame();
      outline.style.left = bounds.left - stage.left + 'px';
      outline.style.top = bounds.top - stage.top + 'px';
      outline.style.width = bounds.width + 'px';
      outline.style.height = bounds.height + 'px';
    }
  }

  function draw() {
    placeGizmo();
    frame = requestAnimationFrame(draw);
  }

  function measure() {
    const [a,b] = pointers.values();
    const box = outline.getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    if (!b) return { x: a.x, y: a.y, width: Math.max(8,Math.abs(a.x-cx)), height: Math.max(8,Math.abs(a.y-cy)),
      angle: Math.atan2(a.y-cy,a.x-cx), distance: Math.max(8,Math.hypot(a.x-cx,a.y-cy)) };
    return { x: (a.x+b.x)/2, y: (a.y+b.y)/2, width: 0, height: 0,
      angle: Math.atan2(b.y-a.y,b.x-a.x), distance: Math.max(8,Math.hypot(b.x-a.x,b.y-a.y)) };
  }

  function beginGesture(event) {
    if (pointers.size >= 2 || event.button !== 0) return;
    event.preventDefault();
    outline.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    baseline = { ...measure(), value:{ ...selected() }, tool: event.target.dataset.tool || 'move' };
  }

  outline.addEventListener('pointerdown', beginGesture, { signal });
  outline.addEventListener('pointermove', event => {
    if (!baseline || !pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x:event.clientX,y:event.clientY });
    const now = measure();
    const value = selected();
    const start = baseline.value;
    const size = stageFrame();
    if (baseline.tool === 'move' || pointers.size === 2) {
      value.x = clamp(start.x + 100*(now.x-baseline.x)/Math.max(1,size.width),-80,80);
      value.y = clamp(start.y + 100*(now.y-baseline.y)/Math.max(1,size.height),-80,80);
    }
    if (baseline.tool === 'scale' || pointers.size === 2) {
      const ratio = now.distance / baseline.distance;
      value.sx = clamp(start.sx * ratio,35,250);
      value.sy = clamp(start.sy * ratio,35,250);
    }
    if (baseline.tool === 'rotate' || pointers.size === 2) {
      value.angle = normalizeAngle(start.angle+(now.angle-baseline.angle)*180/Math.PI);
    }
    sync();
  }, { signal });
  for (const event of ['pointerup','pointercancel','lostpointercapture']) {
    outline.addEventListener(event, ({ pointerId }) => {
      if (!pointers.delete(pointerId)) return;
      baseline = pointers.size ? { ...measure(), value:{ ...selected() }, tool:'move' } : undefined;
    }, { signal });
  }
  for (const [tool, label, text] of [['move','Geser','✥'],['scale','Skala','↗'],['rotate','Putar','↻']]) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.dataset.tool = tool;
    handle.textContent = text;
    handle.setAttribute('aria-label',label);
    outline.append(handle);
  }

  function setEditing(next) {
    if (active === next) return;
    active = next;
    world.toggleAttribute('data-edit-hud',active);
    world.dispatchEvent(new Event('mawa:hud-edit'));
    start.textContent = active ? 'Selesai Mengatur' : 'Edit HUD Interaktif';
    controls.hidden = !active;
    profile.disabled = element.disabled = !active;
    if (active) { sync(); draw(); }
    else { cancelGesture(); cancelAnimationFrame(frame); outline.hidden = true; apply(); }
  }

  function button(text, click) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.addEventListener('click',click,{signal});
    actions.append(control);
    return control;
  }

  const start = button('Edit HUD Interaktif', () => setEditing(!active));
  button('Buka/Tutup Chat', () => {
    if (!active) return;
    const open = nodes.chat.hasAttribute('data-open');
    // Use the game's existing chat handler without launching the OS keyboard.
    (open ? nodes.chatClose : nodes.chatToggle)?.click();
    if (!open) document.activeElement?.blur();
  });
  button('Reset Elemen', () => {
    if (!active) return;
    delete layouts[profile.value][element.value];
    sync();
  });
  button('Simpan Layout Lokal', () => {
    try { localStorage.setItem(storageKey,JSON.stringify(layouts)); status.textContent = 'Layout tersimpan di browser ini.'; }
    catch { status.textContent = 'Layout tidak bisa disimpan di browser ini.'; }
  });
  world.addEventListener('pointerdown', event => {
    if (!active || !hud.contains(event.target) || panel.contains(event.target)) return;
    const match = Object.entries(nodes).filter(([, node]) => node?.contains(event.target))
      .find(([, node], _, matches) => !matches.some(([, other]) => node !== other && node.contains(other)));
    if (!match) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    element.value = match[0];
    sync();
    placeGizmo();
    if (!outline.hidden) beginGesture(event);
  }, { capture:true, signal });
  world.addEventListener('click', event => {
    if (!active || !event.isTrusted || !hud.contains(event.target) || panel.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture:true, signal });
  function cancelGesture() {
    for (const id of pointers.keys()) {
      if (outline.hasPointerCapture(id)) outline.releasePointerCapture(id);
    }
    pointers.clear();
    baseline = undefined;
  }

  function reflow() {
    if (viewportFrame !== undefined) return;
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = undefined;
      const next = currentProfile();
      if (next !== deviceProfile) {
        deviceProfile = next;
        profile.value = next;
      }
      cancelGesture();
      if (active) { sync(); placeGizmo(); }
      else apply();
    });
  }

  for (const select of [profile,element]) select.addEventListener('change',() => {
    cancelGesture();
    sync();
  },{signal});
  for (const query of [touch,landscape]) query.addEventListener('change',reflow,{signal});
  for (const event of ['resize','orientationchange','pageshow']) window.addEventListener(event,reflow,{signal});
  for (const event of ['fullscreenchange','webkitfullscreenchange']) document.addEventListener(event,reflow,{signal});
  window.screen?.orientation?.addEventListener('change',reflow,{signal});
  window.visualViewport?.addEventListener('resize',reflow,{signal});
  world.addEventListener('mawa:hud-viewport',reflow,{signal});
  const observer = new ResizeObserver(reflow);
  observer.observe(world);
  const viewportObserver = new MutationObserver(reflow);
  viewportObserver.observe(world,{attributes:true,attributeFilter:['class']});
  controls.hidden = profile.disabled = element.disabled = true;
  section.addEventListener('keydown',event => {
    if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
  }, {signal});
  panel.addEventListener('mawa:developer-tab', event => { if (event.detail !== 'hud') setEditing(false); }, { signal });
  const panelObserver = new MutationObserver(() => { if (panel.hidden) setEditing(false); });
  panelObserver.observe(panel,{attributes:true,attributeFilter:['hidden']});
  section.append(title,hint,profile,element,controls,actions,status);
  world.querySelector('.developer-fields').append(section);
  signal.addEventListener('abort',() => {
    setEditing(false);
    observer.disconnect();
    viewportObserver.disconnect();
    cancelAnimationFrame(viewportFrame);
    panelObserver.disconnect();
    restore();
    outline.remove();
  },{once:true});
  apply();
  return { snapshot: () => sanitizeHudLayout(layouts) };
}
