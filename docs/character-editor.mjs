const states = { idle: 'Idle', walk: 'Jalan', run: 'Lari', sprint: 'Sprint', jump: 'Lompat', fall: 'Jatuh', crouch: 'Jongkok', dash: 'Dash' };
const maxBytes = 32 * 1024 * 1024;

export function characterAnimationState(actor) {
  if (actor.state === 'falling') return 'fall';
  if (actor.state === 'in air') return 'jump';
  if (actor.gait === 'dash' || actor.dashLeft > 0) return 'dash';
  if (actor.stance === 'crouch') return 'crouch';
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
  section.append(title);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const model = document.createElement('select');
  model.setAttribute('aria-label', 'Pilih karakter');
  const modelLabel = document.createElement('label');
  modelLabel.append('Karakter', model);
  section.append(modelLabel);
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
  section.append(collection, controls);
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
  for (const [key,name] of Object.entries(states)) {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Animasi ' + name);
    select.addEventListener('change', () => { library.get(current).mapping[key] = select.value; preview = ''; }, { signal });
    label.append(name, select);
    controls.append(label);
    stateInputs.set(key, select);
  }
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
    preview = '';
    if (!asset.scene) return;
    for (const [key,field] of Object.entries(settings)) field.value = asset.options[key];
    for (const [key,select] of stateInputs) fill(select, asset, asset.mapping[key] ?? '', 'Otomatis / Idle');
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
      if (!/\.glb$/i.test(file.name) || file.size > maxBytes || file.size < 12) throw Error('Pilih GLB valid berukuran maksimal 32 MB.');
      payload = await runtime.read(await file.arrayBuffer());
      if (signal.aborted) return;
      if (animationsOnly) {
        const clips = payload.animations.filter(clip => runtime.compatible(clip, asset.scene));
        if (!clips.length) throw Error('Tidak ada klip yang cocok dengan rig dan nama tulang mesh ini.');
        const count = Math.min(64 - asset.clips.length, clips.length);
        asset.clips.push(...clips.slice(0, count));
        status.textContent = count + ' klip dipasang ke daftar animasi.';
      } else {
        const next = runtime.prepare(payload);
        current = String(++serial);
        library.set(current,next);
        model.add(new Option(file.name, current));
        model.value = current;
        payload = null;
        status.textContent = 'Mesh tampil di layar ini. Pilih klip untuk tiap gerakan.';
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
    attach(THREE, scene) {
      const root = new THREE.Group();
      scene.add(root);
      let active, action, mixer;
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
          return { scene: payload.scene, fit, clips: payload.animations.slice(0,64), mapping: {},
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
      return (actor, dt, capsule) => {
        const asset = library.get(current);
        if (asset !== active) {
          mixer?.stopAllAction();
          if (mixer) mixer.uncacheRoot(active.scene);
          root.clear();
          active = asset;
          action = undefined;
          mixer = asset.scene ? new THREE.AnimationMixer(asset.scene) : undefined;
          if (asset.fit) root.add(asset.fit);
        }
        root.visible = Boolean(asset.scene) && capsule.visible;
        if (!asset.scene) return;
        capsule.visible = false;
        const { options, clips, mapping } = asset;
        root.position.set(actor.x,actor.y + options.height,actor.z);
        root.rotation.y = Math.atan2(actor.facingX,actor.facingZ) + options.yaw * Math.PI / 180;
        root.scale.setScalar(options.scale);
        const key = preview || mapping[characterAnimationState(actor)] || mapping.idle;
        const clip = key === undefined || key === '' ? undefined : clips[Number(key)];
        if (action?.getClip() !== clip) {
          const previous = action;
          action = clip ? mixer.clipAction(clip).reset().play() : undefined;
          if (previous && action && options.blend > 0) action.crossFadeFrom(previous, options.blend, false);
          else previous?.stop();
        }
        mixer.timeScale = options.speed;
        mixer.update(dt);
      };
    },
  };
}
