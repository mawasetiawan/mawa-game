const maxPackageBytes = 64 * 1024 * 1024;
const version = '4.3.0';

export async function resampleCharacter(bytes, loadModules = loadGltfTools) {
  const [core, extensions, functions] = await loadModules();
  const io = new core.WebIO().registerExtensions(extensions.ALL_EXTENSIONS);
  const gltf = await io.binaryToJSON(new Uint8Array(bytes));
  const used = gltf.json.extensionsUsed ?? [];
  const supported = new Set(extensions.ALL_EXTENSIONS.map(extension => extension.EXTENSION_NAME));
  if (!gltf.json.animations?.length || used.some(name => !supported.has(name) || /(?:meshopt|draco)_compression/.test(name))) {
    return bytes;
  }
  const document = await io.readJSON(gltf);
  await document.transform(functions.resample({ cleanup: false }));
  const optimized = await io.writeBinary(document);
  return optimized.byteLength < bytes.byteLength ? optimized : bytes;
}

function loadGltfTools() {
  const base = 'https://esm.sh/@gltf-transform/';
  return Promise.all([
    import(base + 'core@' + version + '?target=es2022'),
    import(base + 'extensions@' + version + '?target=es2022&deps=@gltf-transform/core@' + version),
    import(base + 'functions@' + version + '?target=es2022&deps=@gltf-transform/core@' + version),
  ]);
}

export async function packCharacter(payload) {
  const raw = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  if (raw.size > maxPackageBytes) throw Error('Paket karakter melebihi kapasitas editor (64 MiB sebelum gzip).');
  if (typeof CompressionStream === 'function') {
    const stream = raw.stream().pipeThrough(new CompressionStream('gzip'));
    const zip = await new Response(stream, { headers: { 'Content-Type': 'application/gzip' } }).blob();
    if (zip.size < raw.size) return { file: zip, suffix: '.character.json.gz', rawSize: raw.size };
  }
  return { file: raw, suffix: '.character.json', rawSize: raw.size };
}

export async function unpackCharacter(file) {
  if (file.size > maxPackageBytes) throw Error('Paket karakter terlalu besar.');
  const signature = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (signature[0] !== 0x1f || signature[1] !== 0x8b) return JSON.parse(await file.text());
  if (typeof DecompressionStream !== 'function') throw Error('Browser ini belum mendukung paket gzip.');
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPackageBytes) {
        await reader.cancel();
        throw Error('Paket karakter terlalu besar setelah dibuka.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(await new Blob(chunks).text());
}
