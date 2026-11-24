const filename = 'developer-settings.json';

export async function loadDeveloperConfig() {
  try {
    const response = await fetch('./' + filename, { cache: 'no-cache', signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const value = await response.json();
      if (value?.version === 1) return value;
    }
  } catch (error) { console.warn('Konfigurasi GitHub:', error); }
  return {};
}

export function mountDeveloperConfigPanel(world, signal, snapshot) {
  const section = document.createElement('details');
  const summary = Object.assign(document.createElement('summary'), { textContent: 'Konfigurasi GitHub' });
  const actions = Object.assign(document.createElement('div'), { className: 'camera-buttons' });
  const output = Object.assign(document.createElement('p'), { role: 'status' });
  const save = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Ekspor Pengaturan' });
  const upload = Object.assign(document.createElement('a'), {
    href: 'https://github.com/mawasetiawan/mawa-game/upload/main/docs',
    target: '_blank', rel: 'noopener noreferrer', textContent: 'Upload ke GitHub',
  });
  save.addEventListener('click', () => {
    try {
      const json = JSON.stringify({ version: 1, ...snapshot() }, null, 2) + '\n';
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: filename }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      output.textContent = 'Upload ' + filename + ' ke folder docs. Game memakainya setelah GitHub Pages memperbarui situs.';
    } catch (error) { output.textContent = error.message; }
  }, { signal });
  actions.append(save, upload);
  section.append(summary, actions, output);
  world.querySelector('.developer-fields').append(section);
}
