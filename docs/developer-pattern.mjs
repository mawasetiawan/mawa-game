export function appendPatternNode(path, point) {
  if (path.includes(point)) return;
  const last = path.at(-1);
  if (last !== undefined) {
    const x = last % 3 + point % 3;
    const y = Math.floor(last / 3) + Math.floor(point / 3);
    if (x % 2 === 0 && y % 2 === 0) {
      const between = y / 2 * 3 + x / 2;
      if (!path.includes(between)) path.push(between);
    }
  }
  path.push(point);
}

async function fingerprint(salt, path) {
  const bytes = new TextEncoder().encode(salt + ':' + path.join(','));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createDeveloperPatternGate(world, uid, signal) {
  const key = 'mawa.developer-pattern.v1.' + uid;
  const dialog = document.createElement('dialog');
  dialog.className = 'developer-pattern';
  dialog.setAttribute('aria-label', 'Kunci pola Developer');
  dialog.innerHTML = `
    <h2>Kunci Pola Developer</h2>
    <p role="status" aria-live="polite"></p>
    <div class="pattern-grid" aria-label="Grid pola 3 kali 3">
      <svg viewBox="0 0 300 300" aria-hidden="true"><polyline /></svg>
    </div>
    <div class="pattern-actions">
      <button type="button" data-cancel>Batal</button>
      <button type="button" data-reset>Ulangi</button>
      <button type="button" data-confirm>Lanjut</button>
    </div>`;
  (world.closest('main') ?? world).append(dialog);
  const grid = dialog.querySelector('.pattern-grid');
  const line = grid.querySelector('polyline');
  const status = dialog.querySelector('[role=status]');
  const confirm = dialog.querySelector('[data-confirm]');
  const reset = dialog.querySelector('[data-reset]');
  const centers = Array.from({ length: 9 }, (_, i) => [50 + i % 3 * 100, 50 + Math.floor(i / 3) * 100]);
  const path = [];
  const options = { signal };
  let pointer = null, cursor, previous, unlock, record, first, busy = false, attempt = 0;
  const nodes = centers.map((_, index) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.setAttribute('aria-label', 'Titik ' + (index + 1));
    node.addEventListener('click', event => {
      if (event.detail === 0 && pointer === null && !busy) add(index);
    }, options);
    grid.append(node);
    return node;
  });

  function render() {
    const points = path.map(point => centers[point]);
    if (cursor && points.length) points.push(cursor);
    line.setAttribute('points', points.map(point => point.join(',')).join(' '));
    nodes.forEach((node, i) => node.setAttribute('aria-pressed', String(path.includes(i))));
    confirm.disabled = busy || path.length < 4;
  }

  function clear() {
    pointer = null;
    cursor = previous = undefined;
    path.length = 0;
    render();
  }

  function add(point) {
    appendPatternNode(path, point);
    render();
  }

  function track(event) {
    const box = grid.getBoundingClientRect();
    cursor = [(event.clientX - box.left) * 300 / box.width, (event.clientY - box.top) * 300 / box.height];
    const from = previous ?? cursor;
    const dx = cursor[0] - from[0], dy = cursor[1] - from[1];
    const length = dx * dx + dy * dy;
    const hits = centers.map(([x, y], index) => {
      const t = length ? Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / length)) : 0;
      return { index, t, distance: Math.hypot(x - from[0] - dx * t, y - from[1] - dy * t) };
    }).filter(hit => hit.distance <= 27).sort((a, b) => a.t - b.t);
    for (const hit of hits) appendPatternNode(path, hit.index);
    previous = cursor;
    render();
  }

  async function submit() {
    if (busy || path.length < 4) return;
    const sequence = [...path];
    const request = attempt;
    busy = true;
    clear();
    try {
      const salt = record?.salt ?? first?.salt ?? [...crypto.getRandomValues(new Uint8Array(16))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      const hash = await fingerprint(salt, sequence);
      if (request !== attempt || !dialog.open) return;
      if (!record && !first) {
        first = { salt, hash };
        status.textContent = 'Ulangi pola untuk konfirmasi.';
      } else if (hash !== (record ?? first).hash) {
        status.textContent = record ? 'Pola salah. Coba lagi.' : 'Pola belum cocok. Ulangi pola konfirmasi.';
      } else {
        if (!record) localStorage.setItem(key, JSON.stringify(first));
        const open = unlock;
        dialog.close();
        open?.();
      }
    } catch {
      if (request === attempt) status.textContent = 'Kunci pola tidak bisa dibaca atau disimpan di browser ini.';
    } finally {
      if (request === attempt) { busy = false; render(); }
    }
  }

  grid.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null || busy) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
    pointer = event.pointerId;
    grid.setPointerCapture(pointer);
    track(event);
  }, options);
  grid.addEventListener('pointermove', event => { if (event.pointerId === pointer) track(event); }, options);
  grid.addEventListener('pointerup', event => {
    if (event.pointerId !== pointer) return;
    track(event);
    pointer = null;
    cursor = previous = undefined;
    render();
    if (path.length >= 4) void submit();
    else { clear(); status.textContent = 'Hubungkan minimal 4 titik.'; }
  }, options);
  grid.addEventListener('pointercancel', event => { if (event.pointerId === pointer) clear(); }, options);
  reset.addEventListener('click', clear, options);
  confirm.addEventListener('click', submit, options);
  dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close(), options);
  dialog.addEventListener('close', () => { attempt++; unlock = undefined; first = undefined; busy = false; clear(); }, options);
  signal.addEventListener('abort', () => { attempt++; dialog.remove(); }, { once: true });

  return onUnlock => {
    if (dialog.open) return;
    try { record = JSON.parse(localStorage.getItem(key)); } catch { record = undefined; }
    first = undefined;
    busy = false;
    unlock = onUnlock;
    clear();
    status.textContent = record ? 'Gambar pola untuk membuka Developer Mode.' :
      'Buat pola dengan menghubungkan minimal 4 titik.';
    dialog.showModal();
  };
}
