export const characterRepository = 'https://github.com/mawasetiawan/mawa-game';
export const rawCharacterRoot = 'https://raw.githubusercontent.com/mawasetiawan/mawa-game/main/';
export const packageName = /^[a-z0-9-]{1,80}\.character\.json(?:\.gz)?$/;
const metadataLimit = 110_000;

export function validThumbnail(src) {
  return typeof src === 'string' && src.length < 95_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(src);
}

export async function squareThumbnail(file) {
  if (!/^(image\/(jpeg|png|webp))$/.test(file.type) || !file.size || file.size > 8 * 1024 * 1024) {
    throw Error('Pilih gambar PNG, JPG, atau WebP maksimal 8 MiB.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw Error('Gambar thumbnail tidak valid.');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#273344';
    ctx.fillRect(0, 0, 256, 256);
    ctx.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    const data = canvas.toDataURL('image/jpeg', .82);
    if (!validThumbnail(data)) throw Error('Thumbnail terlalu besar setelah diproses.');
    return data;
  } finally { URL.revokeObjectURL(url); }
}

const jsonString = '"(?:[^"\\\\]|\\\\.)*"';
const header = new RegExp('^\\s*\\{\\s*"version"\\s*:\\s*1\\s*,\\s*"name"\\s*:\\s*(' + jsonString +
  ')(?:\\s*,\\s*"thumbnail"\\s*:\\s*(' + jsonString + '))?\\s*,\\s*"source"\\s*:');

export async function readCharacterCard(stream, compressed) {
  if (!stream) return null;
  if (compressed) {
    const rawReader = stream.getReader();
    const first = await rawReader.read();
    if (first.done) { rawReader.releaseLock(); return null; }
    const actualGzip = first.value[0] === 0x1f && first.value[1] === 0x8b;
    stream = new ReadableStream({
      start(controller) { controller.enqueue(first.value); },
      async pull(controller) {
        const result = await rawReader.read();
        if (result.done) { controller.close(); rawReader.releaseLock(); }
        else controller.enqueue(result.value);
      },
      cancel(reason) { return rawReader.cancel(reason); },
    });
    if (actualGzip) {
      if (typeof DecompressionStream !== 'function') { await stream.cancel(); return null; }
      stream = stream.pipeThrough(new DecompressionStream('gzip'));
    }
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < metadataLimit) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value.subarray(0, metadataLimit - text.length), { stream: true });
      const match = header.exec(text);
      if (!match) continue;
      const name = JSON.parse(match[1]);
      const thumbnail = match[2] ? JSON.parse(match[2]) : '';
      return { name: name.slice(0, 60), thumbnail: validThumbnail(thumbnail) ? thumbnail : '' };
    }
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchCharacterCard(id, sha, signal) {
  const response = await fetch(rawCharacterRoot + 'docs/characters/' + encodeURIComponent(id) + '?blob=' + encodeURIComponent(sha), { signal });
  if (!response.ok) return null;
  return readCharacterCard(response.body, id.endsWith('.gz'));
}
