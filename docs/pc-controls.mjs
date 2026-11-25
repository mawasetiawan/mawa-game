const storageKey = 'mawa-pc-controls-v1';
const controls = {
  forward: ['Maju', 'KeyW'], back: ['Mundur', 'KeyS'],
  left: ['Geser kiri', 'KeyA'], right: ['Geser kanan', 'KeyD'],
  jump: ['Lompat', 'Space'], sprint: ['Sprint (tahan) / Dash (tekan dua kali)', 'Shift'],
  walk: ['Jalan / Lari (toggle)', 'Control'], crouch: ['Jongkok', 'KeyC'], interact: ['Interaksi', 'KeyE'],
  basic: ['Basic Attack', 'Mouse0'], skill1: ['Skill 1', 'Digit1'], skill2: ['Skill 2', 'Digit2'],
  ultimate: ['Ultimate', 'Digit3'], camera: ['Kamera (tahan dan geser)', 'Mouse2'],
};
const defaults = Object.fromEntries(Object.entries(controls).map(([id, [, code]]) => [id, code]));
const labels = { Mouse0: 'Klik kiri', Mouse1: 'Klik tengah', Mouse2: 'Klik kanan', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5', Space: 'Spasi', Control: 'Ctrl' };
const valid = code => typeof code === 'string' && /^(?:Mouse[0-4]|Key[A-Z]|Digit[0-9]|Numpad\w+|Shift|Control|Space|Arrow(?:Up|Down|Left|Right)|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|BracketLeft|BracketRight|Backquote|Minus|Equal|Comma|Period|Slash|Backslash|Semicolon|Quote|CapsLock|F(?:[1-9]|1[0-2]))$/.test(code);
export const keyBinding = code => /^(Control|Shift)(Left|Right)$/.test(code) ? code.replace(/Left|Right/, '') : code;
export const bindingLabel = code => labels[code] ?? code.replace(/^(Key|Digit)/, '').replace(/^Arrow/, 'Panah ');
export function detectDesktop(navigator, mouseMatches) {
  const appleTouch = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return mouseMatches && !appleTouch && !navigator.userAgentData?.mobile && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}
export function remapBinding(bindings, action, code) {
  if (!Object.hasOwn(controls, action) || !valid(code)) return false;
  const occupied = Object.keys(bindings).find(id => bindings[id] === code);
  if (occupied) bindings[occupied] = bindings[action];
  bindings[action] = code;
  return true;
}

export function mountPcControls(world, signal, reset) {
  const media = matchMedia('(hover: hover) and (pointer: fine)');
  const bindings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const id of Object.keys(controls)) remapBinding(bindings, id, saved?.[id]);
  } catch {}
  const options = { signal };
  const info = Object.assign(document.createElement('button'), { type: 'button', className: 'pc-info' });
  const icon = Object.assign(document.createElement('span'), { className: 'pc-info-icon', textContent: 'i' });
  icon.setAttribute('aria-hidden', 'true');
  info.append(icon, 'Info');
  info.setAttribute('aria-haspopup', 'dialog');
  const dialog = Object.assign(document.createElement('dialog'), { className: 'pc-control-dialog' });
  dialog.setAttribute('aria-label', 'Kontrol PC');
  const title = Object.assign(document.createElement('h2'), { textContent: 'Kontrol PC' });
  const hint = Object.assign(document.createElement('p'), { textContent: 'Pilih tombol di sebelah aksi untuk menggantinya. Roda mouse mengatur zoom.' });
  const status = Object.assign(document.createElement('p'), { role: 'status' });
  const rows = Object.assign(document.createElement('div'), { className: 'pc-control-rows' });
  const footer = Object.assign(document.createElement('div'), { className: 'pc-control-footer' });
  const keyButtons = {};
  let waiting, desktop;

  function setStatus(text) { status.textContent = text; }
  function render() {
    for (const [id, button] of Object.entries(keyButtons)) {
      button.textContent = waiting === id ? 'Tekan tombol…' : bindingLabel(bindings[id]);
      button.setAttribute('aria-label', controls[id][0] + ': ' + button.textContent);
    }
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(bindings)); } catch {}
    reset();
  }
  function remap(code) {
    if (!remapBinding(bindings, waiting, code)) {
      setStatus('Pilih tombol keyboard atau mouse yang didukung. Escape untuk batal.');
      return;
    }
    waiting = undefined;
    save();
    render();
    setStatus('Kontrol diperbarui.');
  }
  for (const [id, [label]] of Object.entries(controls)) {
    const row = document.createElement('div');
    const button = Object.assign(document.createElement('button'), { type: 'button' });
    button.addEventListener('click', () => {
      waiting = id;
      setStatus('Tekan tombol keyboard atau klik area kosong di panel. Escape untuk batal.');
      render();
    }, options);
    keyButtons[id] = button;
    row.append(label, button);
    rows.append(row);
  }
  const restore = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Reset Default' });
  const close = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Tutup' });
  restore.addEventListener('click', () => {
    waiting = undefined;
    Object.assign(bindings, defaults);
    save();
    render();
    setStatus('Kontrol kembali ke default.');
  }, options);
  close.addEventListener('click', () => dialog.close(), options);
  footer.append(restore, close);
  dialog.append(title, hint, rows, status, footer);
  world.querySelector('.world-toolbar').append(info);
  world.append(dialog);
  info.addEventListener('click', () => {
    reset();
    setStatus('');
    render();
    dialog.showModal();
  }, options);
  dialog.addEventListener('close', () => { waiting = undefined; reset(); }, options);
  dialog.addEventListener('keydown', event => {
    if (!waiting) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') { waiting = undefined; render(); setStatus('Penggantian dibatalkan.'); }
    else remap(keyBinding(event.code));
  }, options);
  dialog.addEventListener('pointerdown', event => {
    if (!waiting || event.pointerType !== 'mouse' || event.target.closest('button')) return;
    event.preventDefault();
    remap('Mouse' + event.button);
  }, options);
  dialog.addEventListener('contextmenu', event => event.preventDefault(), options);

  function sync() {
    desktop = detectDesktop(navigator, media.matches);
    world.toggleAttribute('data-pc-controls', desktop);
    info.hidden = !desktop;
    if (!desktop && dialog.open) dialog.close();
    reset();
  }
  sync();
  media.addEventListener('change', sync, options);
  signal.addEventListener('abort', () => {
    world.removeAttribute('data-pc-controls');
    if (dialog.open) dialog.close();
    dialog.remove();
    info.remove();
  }, { once: true });
  return {
    desktop: () => desktop,
    open: () => dialog.open,
    action: code => Object.keys(bindings).find(id => bindings[id] === keyBinding(code)),
    cameraButton: () => bindings.camera.startsWith('Mouse') ? Number(bindings.camera.slice(5)) : null,
  };
}
