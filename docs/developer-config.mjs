const filename = 'developer-settings.json';
const repository = 'https://github.com/mawasetiawan/mawa-game';
const raw = 'https://raw.githubusercontent.com/mawasetiawan/mawa-game/main/';
const limit = 1_600_000;
const characterPattern = /^[a-z0-9-]+[.]character[.]json(?:[.]gz)?$/;

async function fetchConfig(path, signal) {
  const response = await fetch(path, { cache: 'no-cache', signal });
  if (response.ok) {
    const value = await response.json();
    if (value?.version === 1) return value;
  }
  return null;
}

export async function loadDeveloperConfig() {
  // Read the branch directly because configuration commits from Actions do not rebuild Pages.
  for (const path of [raw + 'docs/' + filename, './' + filename]) {
    try {
      const value = await fetchConfig(path, AbortSignal.timeout(3500));
      if (value) return value;
    } catch (error) { console.warn('Konfigurasi GitHub:', error); }
  }
  return {};
}

async function checkPackage(character) {
  if (!character) return;
  const name = character.package;
  if (typeof name !== 'string' || name.length > 100 || !characterPattern.test(name)) {
    throw Error('Nama paket karakter tidak valid.');
  }
  const response = await fetch(raw + 'docs/characters/' + encodeURIComponent(name), {
    method: 'HEAD', cache: 'no-cache', signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw Error('Upload paket karakter yang dipilih ke docs/characters sebelum Save All Setting.');
}

async function readReceipt(signal) {
  const response = await fetch(raw + '.github/developer-settings-publication.json?check=' + Math.floor(Date.now() / 15_000),
    { signal, cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw Error('Status publikasi GitHub belum bisa dibaca.');
  return response.json();
}

export function createDeveloperPublication(db, data) {
  const { ref, get, runTransaction } = data;
  const queue = ref(db, 'developerConfigPublication');
  async function submit(entry, deletion) {
    const snapshot = await get(queue);
    const previous = snapshot.val();
    if (previous?.id) {
      const receipt = await readReceipt(AbortSignal.timeout(6000));
      if (receipt?.id !== previous.id) {
        const pending = JSON.parse(previous.payload);
        if (deletion && pending.kind === 'delete-character' && pending.package === deletion.name && pending.sha === deletion.sha) {
          return previous.id;
        }
        throw Error('Permintaan lain sedang diproses di GitHub Actions. Coba lagi setelah selesai.');
      }
    }
    const result = await runTransaction(queue, current => current === null || current.id === previous?.id ? entry : undefined,
      { applyLocally: false });
    if (!result.committed) throw Error('Ada permintaan publikasi lain yang baru masuk.');
    return entry.id;
  }
  return {
    submit,
    async latest() {
      const current = (await get(queue)).val();
      if (!current) return null;
      return JSON.parse(current.payload).kind === 'delete-character' ? null : current.id;
    },
    async remove(name, sha) {
      const id = crypto.randomUUID().replaceAll('-', '');
      return submit({ id, payload: JSON.stringify({ version: 1, kind: 'delete-character', publicationId: id, package: name, sha }) },
        { name, sha });
    },
    async wait(id, signal) {
      for (let i = 0; i < 45 && !signal.aborted; i++) {
        try {
          const receipt = await readReceipt(AbortSignal.timeout(6000));
          if (receipt?.id === id) return receipt;
        } catch {}
        if (!signal.aborted && i < 44) await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 20_000);
          signal.addEventListener('abort', done, { once: true });
        });
      }
      return null;
    },
  };
}

export function mountDeveloperConfigPanel(world, signal, snapshot, publication) {
  const section = document.createElement('details');
  const summary = Object.assign(document.createElement('summary'), { textContent: 'Konfigurasi GitHub' });
  const actions = Object.assign(document.createElement('div'), { className: 'camera-buttons' });
  const output = Object.assign(document.createElement('p'), { role: 'status' });
  const save = Object.assign(document.createElement('button'), {
    type: 'button', textContent: 'Save All Setting', disabled: !publication,
  });
  const hint = Object.assign(document.createElement('p'), {
    textContent: publication ?
      'Setelan yang sudah di-apply akan dipublikasikan otomatis ke GitHub. Sinkronisasi dijadwalkan setiap 5 menit.' :
      'Save All Setting tersedia untuk Game Master.',
  });
  let timer;
  let trackedId;
  let shownPending = false;

  function track(id) {
    if (trackedId === id || signal.aborted) return;
    clearTimeout(timer);
    trackedId = id;
    const started = Date.now();
    shownPending = false;
    async function verify() {
      try {
        const value = await fetchConfig(raw + 'docs/' + filename + '?publication=' + encodeURIComponent(id) + '&check=' + Math.floor(Date.now() / 60000), AbortSignal.timeout(5000));
        if (trackedId !== id || signal.aborted) return;
        if (value?.publicationId === id) {
          output.textContent = 'Tersimpan di GitHub. Setelan baru dipakai pemain saat memuat ulang game.';
          return;
        }
      } catch {}
      if (trackedId !== id || signal.aborted) return;
      if (!shownPending) {
        output.textContent = 'Menunggu sinkronisasi GitHub…';
        shownPending = true;
      }
      if (Date.now() - started >= 15 * 60_000) {
        output.textContent = 'GitHub belum mengonfirmasi publikasi. Cek statusnya di GitHub Actions.';
        return;
      }
      timer = setTimeout(verify, 20_000);
    }
    void verify();
  }

  if (publication) {
    let clicked = false;
    void publication.latest().then(id => {
      if (!clicked && typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) track(id);
    }).catch(() => {});
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    save.addEventListener('click', async () => {
      clicked = true;
      save.disabled = true;
      output.textContent = 'Menyiapkan publikasi…';
      try {
        const id = crypto.randomUUID().replaceAll('-', '');
        const config = { version: 1, ...snapshot(), publicationId: id };
        const payload = JSON.stringify(config);
        if (new TextEncoder().encode(payload).byteLength > limit) {
          throw Error('Paket setelan terlalu besar. Kecilkan file suara lalu coba lagi.');
        }
        await checkPackage(config.character);
        if (!signal.aborted) {
          await publication.submit({ id, payload });
          track(id);
        }
      } catch (error) {
        if (!signal.aborted) output.textContent = error.message || 'Setelan gagal dikirim.';
      } finally { if (!signal.aborted) save.disabled = false; }
    }, { signal });
    const runs = Object.assign(document.createElement('a'), {
      href: repository + '/actions/workflows/publish-developer-settings.yml',
      target: '_blank', rel: 'noopener noreferrer', textContent: 'Status GitHub Actions',
    });
    actions.append(save, runs);
  } else actions.append(save);
  section.append(summary, hint, actions, output);
  world.querySelector('.developer-fields').append(section);
}
