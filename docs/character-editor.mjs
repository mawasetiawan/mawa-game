import { attackSlot, combatActions, comboLimit, detectAnimations, loopsByDefault } from './animation-slots.mjs';

const groups = {
  'Berdiri': { idle: 'Idle', walk: 'Jalan', run: 'Lari', sprint: 'Sprint' },
  'Jongkok': { crouchEnter: 'Enter Crouch', crouchIdle: 'Idle Crouch', crouchMove: 'Move Crouch', crouchExit: 'Exit Crouch' },
  'Di Udara': { jump: 'Lompat', fall: 'Jatuh', land: 'Mendarat' },
};
const actionGroups = {
  'Umum': { dash: 'Dash', interact: 'Interaksi', death: 'Death' },
  ...Object.fromEntries(Object.entries(combatActions).map(([id, title]) => [title,
    Object.fromEntries(Array.from({ length: comboLimit }, (_, index) => [attackSlot(id, index + 1), 'Combo ' + (index + 1)])),
  ])),
};
const states = Object.assign({}, ...Object.values(groups), ...Object.values(actionGroups));
const resolveMapping = asset => ({ ...asset.detected, ...asset.mapping });
function clipKey(mapping, slot) {
  if (mapping[slot] === 'off') return undefined;
  const firstCombo = slot?.replace(/Combo[2-4]$/, 'Combo1');
  const key = mapping[slot] ?? mapping[firstCombo];
  return /^\d+$/.test(key ?? '') ? key : undefined;
}
const mib = 1024 * 1024;
const maxBytes = 32 * mib;
const githubWebLimit = 25 * mib;
const formatSize = bytes => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(bytes / mib) + ' MiB';

export function characterAnimationState(actor) {
  if (actor.state === 'falling') return 'fall';
  if (actor.state === 'in air') return 'jump';
  if (actor.gait === 'dash' || actor.dashLeft > 0) return 'dash';
  if (actor.stance === 'crouch') return actor.gait === 'stop' ? 'crouchIdle' : 'crouchMove';
  return Object.hasOwn(states, actor.gait) ? actor.gait : 'idle';
}

function disposeModel(scene, closedImages = new Set()) {
  const resources = new Set();
  scene?.traverse(node => {
    if (node.geometry) resources.add(node.geometry);
    if (node.skeleton) resources.add(node.skeleton);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) continue;
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) {
    const image = resource.isTexture ? resource.source.data : null;
    if (image?.close && !closedImages.has(image)) { image.close(); closedImages.add(image); }
    resource.dispose();
  }
}

export function mountCharacterPanel(world, signal) {
  const section = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = 'Edit Karakter';
  const savedList = document.createElement('select');
  savedList.setAttribute('aria-label', 'Karakter tersimpan');
  const savedLabel = document.createElement('label');
  savedLabel.append('Karakter tersimpan', savedList);
  const savedActions = document.createElement('div');
  savedActions.className = 'camera-buttons';
  section.append(title, savedLabel, savedActions);
  const saved = new Map();
  const owner = 'mawasetiawan/mawa-game';
  const upload = document.createElement('a');
  upload.href = 'https://github.com/' + owner + '/upload/main/docs/characters';
  upload.target = '_blank';
  upload.rel = 'noopener noreferrer';
  upload.textContent = 'Upload ke GitHub';
  savedActions.append(upload);
  const use = document.createElement('button');
  use.type = 'button';
  use.textContent = 'Use Character';
  use.disabled = true;
  savedActions.prepend(use);
  savedList.add(new Option('Pilih karakter tersimpan', ''));
  savedList.addEventListener('change', () => { use.disabled = !savedList.value || pending || !runtime; }, { signal });
  function listCharacter(id, name, payload) {
    if (!saved.has(id)) savedList.add(new Option(name, id));
    saved.set(id, payload);
  }
  fetch('https://api.github.com/repos/' + owner + '/contents/docs/characters', { signal })
    .then(response => response.ok ? response.json() : [])
    .then(files => {
      for (const file of Array.isArray(files) ? files : []) {
        if (file.type === 'file' && /^[a-z0-9-]+\.character\.json$/.test(file.name)) {
          listCharacter(file.name, file.name.replace('.character.json', '').replaceAll('-', ' '), null);
        }
      }
    }).catch(() => {});
  const edit = document.createElement('details');
  const editTitle = document.createElement('summary');
  editTitle.textContent = 'Edit Karakter';
  edit.append(editTitle);
  section.append(edit);
  title.textContent = 'Karakter';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const model = document.createElement('select');
  model.setAttribute('aria-label', 'Pilih karakter');
  const modelLabel = document.createElement('label');
  modelLabel.append('Karakter', model);
  edit.append(modelLabel);
  const controls = document.createElement('div');
  const library = new Map([['capsule', { name: 'Capsule bawaan' }]]);
  let current = 'capsule', serial = 0, runtime, preview = '', pending = false;
  const stateInputs = new Map();
  const collection = document.createElement('div');
  collection.className = 'camera-buttons';
  function button(text, action) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = text;
    item.addEventListener('click', action, { signal });
    collection.append(item);
    return item;
  }
  function fileInput() {
    const item = document.createElement('input');
    item.type = 'file';
    item.accept = '.glb,model/gltf-binary';
    item.hidden = true;
    section.append(item);
    return item;
  }
  const meshFile = fileInput(), clipsFile = fileInput();
  const importMesh = button('Impor Mesh .glb', () => meshFile.click());
  const importClips = button('Impor Animasi .glb', () => clipsFile.click());
  const remove = button('Hapus dari sesi', () => {
    const asset = library.get(current);
    if (!asset.scene) return;
    library.delete(current);
    model.querySelector('option:checked')?.remove();
    current = model.value = 'capsule';
    render();
    disposeModel(asset.scene);
  });
  edit.append(collection, controls);
  const sizeWarning = document.createElement('p');
  sizeWarning.className = 'character-size-warning';
  sizeWarning.setAttribute('role', 'status');
  sizeWarning.hidden = true;
  collection.after(sizeWarning);
  function showSizeWarning(bytes, minimum = false) {
    sizeWarning.hidden = bytes <= githubWebLimit;
    sizeWarning.textContent = sizeWarning.hidden ? '' :
      'Paket ' + (minimum ? 'minimal ' : '') + formatSize(bytes) +
      '. Batas upload GitHub lewat browser 25 MiB per file. Kecilkan mesh, tekstur, atau animasi untuk upload lewat browser.';
  }
  const save = button('Save as Character', async () => {
    const asset = library.get(current);
    const name = nameField.value.trim();
    if (!asset?.source || !name) { status.textContent = 'Isi nama karakter terlebih dahulu.'; return; }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'karakter';
    const id = slug + '.character.json';
    try {
      const reader = new FileReader();
      const source = await new Promise((resolve,reject) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([asset.source]));
      });
      if (signal.aborted) return;
      const payload = { version: 1, name, source, options: { ...asset.options }, mapping: { ...asset.mapping }, loops: { ...asset.loops },
        extra: asset.clips.slice(asset.embeddedCount).map(clip => runtime.serializeClip(clip)) };
      const file = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (asset === library.get(current)) showSizeWarning(file.size);
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href: url, download: id });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      listCharacter(id, name, payload);
      savedList.value = id;
      use.disabled = false;
      status.textContent = file.size > githubWebLimit ? 'Paket diunduh untuk penggunaan lokal.' :
        'Paket diunduh. Pilih Upload ke GitHub untuk menyimpannya di repo.';
    } catch { status.textContent = 'Paket karakter gagal disimpan.'; }
  });
  const nameField = document.createElement('input');
  nameField.maxLength = 60;
  nameField.placeholder = 'Nama karakter';
  nameField.setAttribute('aria-label', 'Nama karakter');
  controls.append(nameField);

  use.addEventListener('click', async () => {
    if (!runtime || pending || library.size >= 6 || !savedList.value) return;
    const id = savedList.value;
    pending = true;
    render();
    let payload;
    try {
      let data = saved.get(id);
      if (!data) {
        const response = await fetch('https://raw.githubusercontent.com/' + owner + '/main/docs/characters/' + encodeURIComponent(id), { signal });
        if (!response.ok) throw Error('Karakter belum bisa dimuat dari GitHub.');
        const blob = await response.blob();
        if (blob.size > maxBytes * 2) throw Error('Paket karakter terlalu besar.');
        data = JSON.parse(await blob.text());
      }
      if (data.version !== 1 || typeof data.source !== 'string' || data.source.length > Math.ceil(maxBytes / 3) * 4) throw Error('Paket karakter tidak valid.');
      const buffer = Uint8Array.from(atob(data.source), character => character.charCodeAt(0)).buffer;
      payload = await runtime.read(buffer);
      if (signal.aborted) return;
      const next = runtime.prepare(payload);
      next.source = buffer;
      next.name = String(data.name ?? id).slice(0,60);
      for (const [key, field] of Object.entries(settings)) {
        const value = data.options?.[key];
        if (Number.isFinite(value) && value >= Number(field.min) && value <= Number(field.max)) next.options[key] = value;
      }
      for (const entry of (Array.isArray(data.extra) ? data.extra : []).slice(0, 64-next.clips.length)) {
        next.clips.push(runtime.parseClip(entry));
      }
      next.detected = detectAnimations(next.clips);
      for (const key of Object.keys(states)) {
        const value = data.mapping?.[key];
        if (value === 'off') next.mapping[key] = value;
        if (typeof data.loops?.[key] === 'boolean') next.loops[key] = data.loops[key];
        if (typeof value === 'string' && /^\d+$/.test(value) && next.clips[Number(value)]) next.mapping[key] = value;
      }
      current = String(++serial);
      library.set(current, next);
      model.add(new Option(next.name, current));
      model.value = current;
      payload = null;
      status.textContent = 'Karakter dipakai.';
    } catch(error) { if (!signal.aborted) status.textContent = error.message; }
    finally { if (payload) disposeModel(payload.scene); pending = false; if (!signal.aborted) render(); }
  }, { signal });
  const settings = Object.fromEntries([
    ['scale', 'Skala', .25, 4, .05],
    ['height', 'Offset tinggi', -3, 3, .05],
    ['yaw', 'Koreksi arah (°)', -180, 180, 5],
    ['speed', 'Kecepatan animasi', .25, 3, .05],
    ['blend', 'Blend (detik)', 0, 1, .05],
  ].map(([key, name, min, max, step]) => {
    const label = document.createElement('label');
    const field = document.createElement('input');
    Object.assign(field, {type:'number', min, max, step});
    field.addEventListener('input', () => {
      if (field.checkValidity() && Number.isFinite(field.valueAsNumber)) library.get(current).options[key] = field.valueAsNumber;
    },{signal});
    label.append(name, field);
    controls.append(label);
    return [key, field];
  }));
  function addAnimationGroups(title, entries) {
    const branch = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    branch.append(summary);
    controls.append(branch);
    for (const [groupName, slots] of Object.entries(entries)) {
      const group = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = groupName;
      group.append(heading);
      branch.append(group);
      for (const [key, name] of Object.entries(slots)) {
        const label = document.createElement('label');
        const select = document.createElement('select');
        select.setAttribute('aria-label', 'Animasi ' + groupName + ' ' + name);
        select.addEventListener('change', () => {
          const { mapping } = library.get(current);
          if (select.value === '') delete mapping[key];
          else mapping[key] = select.value;
          preview = '';
          audition.value = '';
        }, { signal });
        label.append(name, select);
        group.append(label);
        const loopLabel = document.createElement('label');
        const loop = document.createElement('input');
        loop.type = 'checkbox';
        loop.setAttribute('aria-label', 'Loop ' + groupName + ' ' + name);
        loop.disabled = ['fall', 'death'].includes(key);
        loop.addEventListener('change', () => { library.get(current).loops[key] = loop.checked; }, { signal });
        loopLabel.append(key === 'fall' ? 'Loop sampai mendarat' : 'Loop', loop);
        group.append(loopLabel);
        stateInputs.set(key, { select, loop });
      }
    }
  }
  addAnimationGroups('Locomotion', groups);
  addAnimationGroups('Aksi', actionGroups);
  const audition = document.createElement('select');
  audition.setAttribute('aria-label', 'Preview klip');
  audition.addEventListener('change', () => { preview = audition.value; }, { signal });
  const previewLabel = document.createElement('label');
  previewLabel.append('Preview klip', audition);
  controls.append(previewLabel);
  section.append(status);
  section.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
  }, { signal });
  world.querySelector('.developer-fields').append(section);

  function fill(select, asset, value, empty) {
    select.replaceChildren(new Option(empty, ''), ...asset.clips.map(({ name }, index) =>
      new Option(name || 'Klip ' + (index + 1), String(index))));
    select.value = value;
  }

  function render() {
    const asset = library.get(current);
    controls.hidden = !asset.scene;
    importMesh.disabled = pending || !runtime || library.size >= 6;
    importClips.disabled = pending || !runtime || !asset.scene || asset.clips.length >= 64;
    remove.disabled = pending || !asset.scene;
    model.disabled = pending;
    save.disabled = pending || !asset.scene;
    use.disabled = pending || !runtime || !savedList.value || library.size >= 6;
    nameField.value = asset.name ?? '';
    showSizeWarning(asset.source ? Math.ceil(asset.source.byteLength / 3) * 4 : 0, true);
    preview = '';
    if (!asset.scene) return;
    for (const [key,field] of Object.entries(settings)) field.value = asset.options[key];
    for (const [key, { select, loop }] of stateInputs) {
      const detected = asset.clips[Number(clipKey(asset.detected, key))];
      fill(select, asset, asset.mapping[key] ?? '', detected ? 'Otomatis · ' + detected.name : 'Otomatis · Belum cocok');
      select.add(new Option('Tanpa klip khusus', 'off'), 1);
      select.value = asset.mapping[key] ?? '';
      loop.checked = key === 'fall' || (key !== 'death' && (asset.loops[key] ?? loopsByDefault(key)));
    }
    fill(audition,asset,'','Ikuti gerakan');
  }
  model.add(new Option('Capsule bawaan','capsule'));
  model.addEventListener('change', () => { current = model.value; render(); }, {signal});

  async function load(input, animationsOnly) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || pending || !runtime) return;
    const asset = library.get(current);
    pending = true;
    render();
    status.textContent = 'Memuat ' + file.name + '…';
    let payload;
    try {
      if (!/\.glb$/i.test(file.name) || file.size > maxBytes || file.size < 12) throw Error('Pilih GLB valid berukuran maksimal 32 MiB.');
      const source = await file.arrayBuffer();
      payload = await runtime.read(source);
      if (signal.aborted) return;
      if (animationsOnly) {
        const clips = payload.animations.filter(clip => runtime.compatible(clip, asset.scene));
        if (!clips.length) throw Error('Tidak ada klip yang cocok dengan rig dan nama tulang mesh ini.');
        const count = Math.min(64 - asset.clips.length, clips.length);
        asset.clips.push(...clips.slice(0, count));
        asset.detected = detectAnimations(asset.clips);
        status.textContent = count + ' klip dipasang ke daftar animasi.';
      } else {
        const next = runtime.prepare(payload);
        next.source = source;
        next.name = file.name.replace(/\.glb$/i, '');
        current = String(++serial);
        library.set(current,next);
        model.add(new Option(file.name, current));
        model.value = current;
        payload = null;
        status.textContent = Object.keys(next.detected).length + ' slot terdeteksi dari nama klip.';
      }
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message || 'GLB gagal dimuat.';
    } finally {
      if (payload) disposeModel(payload.scene);
      pending = false;
      if (!signal.aborted) render();
    }
  }
  meshFile.addEventListener('change', () => void load(meshFile, false), { signal });
  clipsFile.addEventListener('change', () => void load(clipsFile, true), { signal });
  render();

  return {
    duration(slot) {
      const asset = library.get(current);
      const key = clipKey(resolveMapping(asset), slot);
      return key ? asset.clips[Number(key)]?.duration / asset.options.speed : undefined;
    },
    height() {
      const { options } = library.get(current);
      return options ? 1.8 * options.scale + options.height : null;
    },
    attach(THREE, scene) {
      const root = new THREE.Group();
      scene.add(root);
      let active, action, mixer, crouching, airborne, transition, playback, remaining = 0;
      runtime = {
        async read(buffer) {
          if (new DataView(buffer).getUint32(0,true) !== 0x46546c67) throw Error('File ini bukan GLB.');
          const { GLTFLoader } = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/GLTFLoader.js');
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (!/^(blob:|data:)/i.test(url)) throw Error('GLB harus menyertakan tekstur dan aset di dalam file.');
            return url;
          });
          return new GLTFLoader(manager).parseAsync(buffer,'');
        },
        parseClip: THREE.AnimationClip.parse,
        serializeClip: THREE.AnimationClip.toJSON,
        compatible(clip, mesh) {
          return clip.tracks.length > 0 && clip.tracks.every(track => {
            const binding = THREE.PropertyBinding.parseTrackName(track.name);
            return Boolean(THREE.PropertyBinding.findNode(mesh,binding.nodeName));
          });
        },
        prepare(payload) {
          let meshCount = 0;
          payload.scene.traverse(node => { if (node.isMesh) meshCount++; });
          const bounds = new THREE.Box3().setFromObject(payload.scene);
          const height = bounds.max.y - bounds.min.y;
          if (!meshCount || !Number.isFinite(height) || height <= 0) throw Error('GLB perlu berisi mesh 3D.');
          const center = bounds.getCenter(new THREE.Vector3());
          const fit = new THREE.Group();
          fit.scale.setScalar(1.8 / height);
          const offset = new THREE.Group();
          offset.position.set(-center.x,-bounds.min.y,-center.z);
          offset.add(payload.scene);
          fit.add(offset);
          const clips = payload.animations.slice(0, 64);
          return { scene: payload.scene, fit, clips, mapping: {}, detected: detectAnimations(clips), loops: {}, embeddedCount: clips.length,
            options: {scale:1,height:0,yaw:0,speed:1,blend:.16} };
        },
      };
      render();
      signal.addEventListener('abort', () => {
        mixer?.stopAllAction();
        scene.remove(root);
        const images = new Set();
        for (const asset of library.values()) disposeModel(asset.scene, images);
      }, {once:true});
      return (actor, dt, capsule, timeScale = 1) => {
        const asset = library.get(current);
        if (asset !== active) {
          mixer?.stopAllAction();
          if (mixer) mixer.uncacheRoot(active.scene);
          root.clear();
          active = asset;
          crouching = airborne = transition = undefined;
          remaining = 0;
          action = playback = undefined;
          mixer = asset.scene ? new THREE.AnimationMixer(asset.scene) : undefined;
          if (asset.fit) root.add(asset.fit);
        }
        root.visible = Boolean(asset.scene) && capsule.visible;
        if (!asset.scene) return;
        capsule.visible = false;
        const { options, clips } = asset;
        const mapping = resolveMapping(asset);
        root.position.set(actor.x,actor.y + options.height,actor.z);
        root.rotation.y = Math.atan2(actor.facingX,actor.facingZ) + options.yaw * Math.PI / 180;
        root.scale.setScalar(options.scale);
        const state = characterAnimationState(actor);
        const nextCrouch = actor.stance === 'crouch';
        const nextAir = state === 'jump' || state === 'fall';
        const edge = nextAir ? undefined : airborne ? 'land' :
          crouching !== undefined && crouching !== nextCrouch ? (nextCrouch ? 'crouchEnter' : 'crouchExit') : undefined;
        crouching = nextCrouch;
        airborne = nextAir;
        if (nextAir || preview || actor.action) remaining = 0;
        if (edge && !preview && !actor.action && clips[Number(mapping[edge])]) {
          transition = edge;
          remaining = clips[Number(mapping[edge])].duration;
        }
        const clipFor = key => key ? clips[Number(key)] : undefined;
        const slot = actor.action === 'death' || clipKey(mapping, actor.action) ? actor.action : remaining > 0 ? transition : state;
        const selectedPreview = slot === 'death' ? '' : preview;
        const key = selectedPreview || clipKey(mapping, slot) || (slot === 'death' ? undefined : clipKey(mapping, 'idle'));
        const clip = clipFor(key);
        const once = !selectedPreview && (slot === 'death' || (slot !== 'fall' &&
          !(asset.loops[slot] ?? loopsByDefault(slot))));
        const playbackKey = [selectedPreview, slot, key, once, slot === actor.action ? actor.actionSerial : ''].join('/');
        if (playback !== playbackKey) {
          const previous = action;
          action = clip ? mixer.clipAction(clip).reset() : undefined;
          playback = playbackKey;
          if (action) {
            action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
            action.clampWhenFinished = once;
            action.play();
          }
          if (previous && previous !== action) {
            if (options.blend <= 0) previous.stop();
            else if (action) action.crossFadeFrom(previous, options.blend, false);
            else previous.fadeOut(options.blend);
          }
        }
        remaining -= dt * options.speed * timeScale;
        mixer.timeScale = options.speed * timeScale;
        mixer.update(dt);
      };
    },
  };
}
