import { cameraExtension, easeCamera, parseCameraEffects } from './camera-effects.mjs';
export const scriptVersion = 2;
export const scriptLimit = 16384;

const format = 'mawa-camera';
const isNumber = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const isVector = value => Array.isArray(value) && value.length === 3 &&
  value.every(component => isNumber(component, -200, 200));
const extensions = { json: '.json', cpp: '.cpp,.cc,.cxx,.h,.hpp', java: '.java', luau: '.luau' };

export const exampleScript = {
  format, version: scriptVersion, name: 'Orbit sinematik',
  anchor: 'player', space: 'facing', playback: 'loop', interpolation: 'smootherstep',
  blend: { enter: .3, exit: .3, input: .1, state: .18 },
  bindings: [{ source: 'speed', target: 'distance', min: 0, max: 7, from: 1, to: 1.2 }],
  triggers: [{ event: 'onLand', shake: { amplitude: .15, frequency: 11, duration: .32, decay: 3 } }],
  input: { orbit: true, zoom: true },
  frames: [
    { time: 0, position: [0, 5, 10], target: [0, 1.4, 0], fov: 55 },
    { time: 4, position: [8, 6, 6], target: [0, 1.4, 0], fov: 48 },
    { time: 8, position: [0, 5, 10], target: [0, 1.4, 0], fov: 55 },
  ],
};

export function decodeCameraScript(source, language = 'json') {
  if (!Object.hasOwn(extensions, language) || typeof source !== 'string' || source.length > scriptLimit) {
    throw Error('Jenis file tidak didukung atau file melebihi batas.');
  }
  let json = source.replace(/^\uFEFF/, '');
  if (language !== 'json') {
    const blocks = [...json.matchAll(/MAWA_CAMERA_JSON_BEGIN\s*([\s\S]*?)\s*MAWA_CAMERA_JSON_END/g)];
    if (blocks.length !== 1) throw Error('File sumber harus memuat satu blok MAWA_CAMERA_JSON.');
    json = blocks[0][1];
  }
  const data = JSON.parse(json);
  if (data?.format !== format || ![1, scriptVersion].includes(data.version)) throw Error('Format atau versi modul kamera tidak cocok.');
  if (!['player', 'world'].includes(data.anchor) || !['once', 'loop', 'pingpong'].includes(data.playback) ||
      !cameraExtension.easing.includes(data.interpolation)) throw Error('Anchor, playback, atau interpolation tidak valid.');
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 60 ||
      typeof data.input?.orbit !== 'boolean' || typeof data.input?.zoom !== 'boolean' ||
      !Array.isArray(data.frames) || data.frames.length < 1 || data.frames.length > 64) {
    throw Error('Nama, input, atau jumlah keyframe tidak valid.');
  }
  const effects = parseCameraEffects(data);
  let previous = -1;
  const frames = data.frames.map(({ time, position, target, fov }, index) => {
    if (!isNumber(time, 0, 600) || time <= previous || (index === 0 && time !== 0) ||
        !isVector(position) || !isVector(target) || !isNumber(fov, 25, 110) ||
        position.every((value, i) => value === target[i])) {
      throw Error('Keyframe ' + (index + 1) + ' tidak valid.');
    }
    previous = time;
    return { time, position, target, fov };
  });
  return { format, version: scriptVersion, name: data.name, anchor: data.anchor, playback: data.playback,
    interpolation: data.interpolation, input: { orbit: data.input.orbit, zoom: data.input.zoom }, frames, ...effects };
}

export function sampleCameraScript(script, elapsed, pose) {
  const { frames, playback, interpolation } = script;
  const end = frames.at(-1).time;
  let time = Math.min(elapsed, end);
  if (end > 0 && playback === 'loop') time = elapsed % end;
  if (end > 0 && playback === 'pingpong') time = end - Math.abs(elapsed % (2 * end) - end);
  const boundary = frames.findIndex(frame => frame.time > time);
  const left = boundary < 0 ? frames.at(-1) : frames[boundary - 1];
  const right = boundary < 0 ? left : frames[boundary];
  let t = right === left || interpolation === 'step' ? 0 : (time - left.time) / (right.time - left.time);
  t = easeCamera(t, interpolation);
  for (const key of ['position','target']) {
    for (let axis = 0; axis < 3; axis++) pose[key][axis] = left[key][axis] + (right[key][axis] - left[key][axis]) * t;
  }
  pose.fov = left.fov + (right.fov - left.fov) * t;
}

export function downloadCameraModule(cameraModes) {
  const title = '# Mawa Game Scripted Camera API v' + scriptVersion;
  const module = [
    title,
    'Beri file ini ke AI dan minta satu file .json yang valid sesuai deskripsi kamera. Output hanya JSON. Impor di Developer → Mode Kamera → Scripted Camera.',
    'Kontrak: javascript ES modules. docs/camera-rig.mjs membaca actor.x/y/z dari movement.mjs dan menerapkan pose ke Three.js PerspectiveCamera. Sumbu Y ke atas, gerakan maju awal ke -Z, posisi dan jarak dalam unit map. Anchor player menambahkan posisi actor; anchor world memakai origin map. space world menjaga sumbu map, local/facing memakai arah hadap actor, velocity memakai arah gerak terakhir dan memakai facing saat belum bergerak.',
    'Input opsional: orbit mengizinkan left-drag / drag satu jari, zoom mengizinkan wheel / pinch. Kedua pengaturan bertipe boolean. Keyboard WASD tetap untuk pemain. Script tidak menerima akses jaringan, DOM, atau data akun.',
    'Timeline: 1–64 keyframe, time detik mulai 0 dan naik ketat hingga 600. position dan target masing-masing [x,y,z] dari -200 hingga 200 dan harus berbeda. FOV 25–110 derajat. Playback once, loop, atau pingpong. Interpolation: ' + cameraExtension.easing.join(', ') + '. Untuk loop mulus, samakan pose frame pertama dan terakhir.',
    'Runtime v2: ' + JSON.stringify(cameraExtension) + '. Script v1 otomatis diberi default v2.',
    'triggers: onJump saat lepas tanah ke atas, onLand saat mendarat, onImpact jika gameplay memancarkan player-impact, crossAbove/crossBelow saat nilai melintasi threshold. Dua trigger ambang memerlukan source dan threshold. Setiap trigger memuat shake {amplitude (unit), frequency (Hz), duration (detik), decay}, transition {target, value, duration, easing}, atau keduanya. Transition menuju value di tengah durasi lalu kembali ke parameter aktif. Shake berada di layer pose terpisah.',
    'bindings: {source,target,min,max,from,to}. Nilai input dipetakan dari min–max ke from–to dan di-clamp. Jika beberapa binding menargetkan parameter sama, binding terakhir menang. Sumber vy adalah verticalSpeed; speed adalah besar kecepatan horizontal. airborne/crouching bernilai 0 atau 1. yaw/pitch adalah offset derajat, distance adalah pengali jarak, smoothing adalah detik.',
    'blend {enter,exit,input,state}, masing-masing 0–3 detik. enter/exit untuk perpindahan mode, input untuk melunakkan drag/zoom, state untuk binding dan rotasi ruang relatif. Gunakan 0 agar langsung.',
    'Pilihan sumber: JSON dibaca langsung. C++, Java dan Luau diterima sebagai pembawa satu blok JSON, bukan native runtime. Letakkan JSON di antara marker berikut dalam komentar /* ... */ untuk .cpp/.java atau --[[ ... ]] untuk .luau. Kode di luar blok diabaikan. Maksimum file 16384 byte.',
    'MAWA_CAMERA_JSON_BEGIN\n' + JSON.stringify(exampleScript, null, 2) + '\nMAWA_CAMERA_JSON_END',
    'UI kamera dibuat dari cameraModes di docs/camera-settings.mjs. Tombol Apply Setting memakai handler applyLocal. Publikasi setelan memakai developer-settings.json di GitHub. Untuk modifikasi UI game, perlu perubahan source; import hanya memasok timeline. Schema pengaturan aktual dari build ini:',
    JSON.stringify(cameraModes, null, 2),
  ].join('\n\n');
  const url = URL.createObjectURL(new Blob([module], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'Mawa_Scripted_Camera_API_v' + scriptVersion + '.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountScriptImport(host, getDraft, modes, signal) {
  const language = document.createElement('select');
  language.setAttribute('aria-label', 'Format file Scripted Camera');
  for (const [key,label] of Object.entries({json:'JSON',cpp:'C++ (blok JSON)',java:'Java (blok JSON)',luau:'Luau (blok JSON)'})) {
    language.add(new Option(label,key));
  }
  const file = document.createElement('input');
  file.type = 'file';
  file.hidden = true;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const buttons = document.createElement('div');
  buttons.className = 'camera-buttons';
  function button(text, click) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.addEventListener('click', click, { signal });
    buttons.append(control);
  }
  button('Download Module', () => downloadCameraModule(modes));
  button('Import Scripted Camera', () => { file.accept = extensions[language.value]; file.value = ''; file.click(); });
  const refresh = () => {
    const payload = getDraft().script;
    status.textContent = payload ? 'Timeline: ' + decodeCameraScript(payload).name : 'Impor timeline untuk menjalankan Scripted Camera.';
  };
  file.addEventListener('change', async () => {
    const selected = file.files[0];
    if (!selected) return;
    const target = getDraft();
    const kind = language.value;
    try {
      if (selected.size > scriptLimit) throw Error('Ukuran file maksimal 16 KiB.');
      const script = decodeCameraScript(await selected.text(), kind);
      target.script = JSON.stringify(script);
      if (getDraft() === target) refresh();
    } catch (error) {
      if (getDraft() === target) status.textContent = 'Impor gagal: ' + error.message;
    }
  }, { signal });
  host.append(language, buttons, file, status);
  refresh();
}
