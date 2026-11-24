export const attackAudioLimit = 256 * 1024;
const mimePattern = /^audio\/(mpeg|mp3|wav|wave|x-wav|ogg|webm|mp4|aac|x-m4a|flac|x-flac)$/i;
export const attackAudioAccept = 'audio/*,.mp3,.wav,.ogg,.m4a';

export function soundData(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(attackAudioLimit / 3) * 4 + 48) return '';
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return match && mimePattern.test(match[1]) ? value : '';
}

export function readAttackSound(file) {
  if (!file.size || file.size > attackAudioLimit) throw Error('Pilih suara berukuran maksimal 256 KiB.');
  const mime = mimePattern.test(file.type) ? file.type : ({
    mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', aac:'audio/aac', flac:'audio/flac',
  })[file.name.split('.').pop().toLowerCase()];
  if (!mime) throw Error('Format suara belum didukung.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error('Suara gagal dimuat.'));
    reader.readAsDataURL(new Blob([file], { type: mime }));
  });
}

export function createAttackAudio(signal) {
  const playing = new Set();
  signal.addEventListener('abort', () => {
    for (const sound of playing) sound.pause();
    playing.clear();
  }, { once: true });
  return (data, volume = .8) => {
    if (!data || signal.aborted || playing.size >= 8) return;
    const sound = new Audio(data);
    sound.volume = Math.max(0, Math.min(1, volume));
    const cleanup = () => playing.delete(sound);
    sound.addEventListener('ended', cleanup, { once: true });
    sound.addEventListener('error', cleanup, { once: true });
    playing.add(sound);
    void sound.play().catch(cleanup);
  };
}
