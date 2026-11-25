import { characterRepository, rawCharacterRoot, packageName, squareThumbnail, validThumbnail, fetchCharacterCard } from './character-gallery.mjs';
import { createInPlaceLock, horizontalRootMotion, rootDelta, rootMotionOptions } from './root-motion.mjs?v=3';
import { packCharacter, resampleCharacter, unpackCharacter } from './character-package.mjs';
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
const movingSlots = new Set(['walk', 'run', 'sprint', 'crouchMove']);
const resolveMapping = asset => ({ ...asset.detected, ...asset.mapping });
function clipKey(mapping, slot) {
  const key = mapping[slot];
  return /^\d+$/.test(key ?? '') ? key : undefined;
}

function playableClip(clip) {
  return Boolean(clip?.tracks?.length && Number.isFinite(clip.duration) && clip.duration > 0);
}

function animationClip(asset, slot) {
  const key = asset.mapping?.[slot] ?? asset.detected?.[slot];
  const clip = /^\d+$/.test(key ?? '') ? asset.clips?.[Number(key)] : undefined;
  return playableClip(clip) ? clip : undefined;
}
const mib = 1024 * 1024;
const maxBytes = 32 * mib;
const githubWebLimit = 25 * mib;
const whiteTexture = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2YAAAAASUVORK5CYII=';
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

function createCharacterView(THREE, scene) {
  const root = new THREE.Group();
  scene.add(root);
  let active, action, mixer, crouching, airborne, transition, playback, lockedRoot, remaining = 0;

  function clear() {
    mixer?.stopAllAction();
    if (mixer) mixer.uncacheRoot(active.scene);
    root.clear();
    mixer = active = undefined;
  }

  return {
    remove() { clear(); root.removeFromParent(); },
    update(asset, actor, dt, capsule, timeScale = 1, preview = '') {
      if (asset !== active) {
        clear();
        active = asset;
        crouching = airborne = transition = undefined;
        remaining = 0;
        action = playback = lockedRoot = undefined;
        mixer = asset?.scene ? new THREE.AnimationMixer(asset.scene) : undefined;
        if (asset?.fit) root.add(asset.fit);
      }
      root.visible = Boolean(asset?.scene) && capsule.visible;
      if (!asset?.scene) return;
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
      const edgeClip = edge && animationClip(asset, edge);
      if (edgeClip && !preview && !actor.action) {
        transition = edge;
        remaining = edgeClip.duration;
      }
      const clipFor = key => key ? clips[Number(key)] : undefined;
      const slot = actor.action === 'death' || clipKey(mapping, actor.action) ? actor.action : remaining > 0 ? transition : state;
      const selectedPreview = slot === 'death' ? '' : preview;
      const slotKey = clipKey(mapping, slot);
      const fallingWithJump = state === 'fall' && !actor.action && !slotKey && !selectedPreview;
      const key = selectedPreview || slotKey || (fallingWithJump ? clipKey(mapping, 'jump') : undefined) ||
        (slot === 'death' ? undefined : clipKey(mapping, 'idle'));
      const sourceClip = clipFor(key);
      const lockRoot = asset.rootMotion?.locomotion === 'in-place';
      if (lockRoot !== lockedRoot) {
        mixer.stopAllAction();
        action = playback = undefined;
        lockedRoot = lockRoot;
      }
      const locomotionPose = Boolean(selectedPreview) || movingSlots.has(slot);
      const attackPose = !selectedPreview && asset.rootMotion?.enabled && slot === actor.action && /Combo[1-4]$/.test(slot ?? '');
      const motion = !lockRoot && (locomotionPose || attackPose) ? horizontalRootMotion(THREE, asset, sourceClip, locomotionPose) : null;
      const clip = motion?.pose ?? sourceClip;
      const once = !selectedPreview && (slot === 'death' || fallingWithJump || /Combo[1-4]$/.test(slot ?? '') || (slot !== 'fall' &&
        !(asset.loops[slot] ?? loopsByDefault(slot))));
      const playbackKey = [selectedPreview, fallingWithJump ? 'jump' : slot, key, once, slot === actor.action ? actor.actionSerial : ''].join('/');
      if (!clip) {
        if (action) action.paused = true;
        playback = undefined;
        if (lockRoot) asset.lockInPlace(asset.rootMotion.node);
        return;
      }
      if (playback !== playbackKey || action?.getClip() !== clip) {
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
      const phase = actor.locomotionPhase;
      if (!selectedPreview && phase?.clip === sourceClip && phase.slot === slot) action.time = phase.start;
      remaining -= dt * options.speed * timeScale;
      mixer.timeScale = options.speed * timeScale;
      mixer.update(dt);
      if (lockRoot) asset.lockInPlace(asset.rootMotion.node);
    },
  };
}

export function mountCharacterPanel(world, signal, preset, publication) {
  const developerPanel = world.querySelector('#developerPanel');
  let characterTabActive = true;
  developerPanel?.addEventListener('mawa:developer-tab', event => {
    characterTabActive = event.detail === 'character';
  }, { signal });
  const switchActor = world.querySelector('#switchActor');
  const picker = world.querySelector('#actorPicker');
  const playerCards = picker.querySelector('ul');
  const playerStatus = picker.querySelector('[role=status]');
  const playerCount = picker.querySelector('#actorCount');
  const playerRefresh = picker.querySelector('[data-refresh-actors]');
  const section = document.createElement('details');
  section.open = true;
  const title = document.createElement('summary');
  title.textContent = 'Karakter';
  const gallery = document.createElement('div');
  const count = Object.assign(document.createElement('h3'), { textContent: 'Karakter GitHub' });
  const cards = Object.assign(document.createElement('ul'), { className: 'character-cards' });
  const locals = Object.assign(document.createElement('ul'), { className: 'character-cards', hidden: true });
  locals.setAttribute('aria-label', 'Paket lokal');
  const galleryStatus = Object.assign(document.createElement('p'), { className: 'character-gallery-status', role: 'status' });
  const deleteDialog = Object.assign(document.createElement('dialog'), { className: 'actor-picker character-delete-dialog' });
  const deleteTitle = Object.assign(document.createElement('h2'), { id: 'characterDeleteTitle', textContent: 'Hapus dari GitHub' });
  deleteDialog.setAttribute('aria-labelledby', deleteTitle.id);
  const deleteMessage = Object.assign(document.createElement('p'), { role: 'status' });
  const deleteActions = document.createElement('footer');
  const closeDelete = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Batal', autofocus: true });
  const confirmDelete = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Hapus dari GitHub' });
  const workflowLink = Object.assign(document.createElement('a'), {
    href: characterRepository + '/actions/workflows/publish-developer-settings.yml', target: '_blank',
    rel: 'noopener noreferrer', textContent: 'Buka GitHub Actions', hidden: true,
  });
  deleteActions.append(closeDelete, confirmDelete, workflowLink);
  deleteDialog.append(deleteTitle, deleteMessage, deleteActions);
  world.querySelector('.gameplay-hud').append(deleteDialog);
  closeDelete.addEventListener('click', () => deleteDialog.close(), { signal });
  signal.addEventListener('abort', () => deleteDialog.remove(), { once: true });
  const savedActions = Object.assign(document.createElement('div'), { className: 'camera-buttons' });
  const upload = Object.assign(document.createElement('a'), {
    href: characterRepository + '/upload/main/docs/characters', target: '_blank',
    rel: 'noopener noreferrer', textContent: 'Upload ke GitHub',
  });
  const refresh = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Muat Ulang Daftar' });
  savedActions.append(refresh, upload);
  gallery.append(count, savedActions);
  if (!publication) gallery.append(Object.assign(document.createElement('p'), {
    className: 'character-gallery-hint',
    textContent: 'Masuk dengan akun Google Game Master untuk menghapus paket dari GitHub.',
  }));
  gallery.append(galleryStatus, cards, locals);
  section.append(title, gallery);
  const saved = new Map();
  const published = new Map();
  let listEpoch = 0, deletePending = false, lastRefresh = 0;
  let playerAsset, usingPlayer = false, playerLoading = false;
  let deleteTarget;

  function displayName(id) { return id.replace(/\.character\.json(?:\.gz)?$/, '').replaceAll('-', ' '); }

  function showDeleteStatus(title, message, state) {
    deleteTitle.textContent = title;
    deleteMessage.textContent = galleryStatus.textContent = message;
    deleteDialog.dataset.state = galleryStatus.dataset.state = state;
  }

  async function deleteCharacter() {
    if (!publication || !deleteTarget || deletePending) return;
    const { id, name, sha } = deleteTarget;
    if (preset?.package === id || published.get(id)?.sha !== sha) {
      showDeleteStatus('Paket berubah', 'Muat ulang daftar dan pilih paket yang akan dihapus.', 'error');
      confirmDelete.hidden = true;
      return;
    }
    deleteTarget = undefined;
    deletePending = true;
    confirmDelete.hidden = true;
    closeDelete.textContent = 'Tutup';
    showDeleteStatus('Mengirim permintaan', 'Mengirim permintaan hapus untuk ' + name + '…', 'pending');
    renderCards();
    try {
      const request = await publication.remove(id, sha);
      if (signal.aborted) return;
      workflowLink.hidden = false;
      showDeleteStatus('Menunggu GitHub Actions', 'Permintaan hapus ' + name + ' sudah diterima. Daftar diperbarui setelah GitHub mengonfirmasi.', 'pending');
      const receipt = await publication.wait(request, signal);
      if (signal.aborted) return;
      if (!receipt) {
        showDeleteStatus('Konfirmasi belum diterima', 'Permintaan masih menunggu GitHub Actions. Jika memilih Hapus lagi, game akan melanjutkan pengecekan permintaan yang sama.', 'pending');
        return;
      }
      if (receipt.status === 'active-character') throw Error('Ubah karakter default dan publikasikan pengaturannya sebelum menghapus paket ini.');
      if (receipt.status === 'asset-changed') throw Error('File berubah sejak daftar dimuat. Muat ulang daftar sebelum menghapusnya.');
      if (receipt.status !== 'deleted') throw Error('GitHub belum mengonfirmasi penghapusan paket.');
      published.delete(id);
      saved.delete(id);
      remotePackages.delete(id);
      remotePackages.delete(id + '@' + sha);
      renderCards();
      workflowLink.hidden = true;
      const confirmation = name + ' telah dihapus dari GitHub.';
      showDeleteStatus('Karakter telah dihapus', confirmation + ' Memuat ulang daftar…', 'success');
      const refreshed = await refreshCards({ deleted: { id, sha } });
      if (!signal.aborted) showDeleteStatus('Karakter telah dihapus', confirmation + (refreshed ? ' Daftar sudah diperbarui.' : ' Daftar lengkap gagal dimuat. Gunakan Muat Ulang Daftar untuk mencoba lagi.'), 'success');
    } catch (error) {
      if (!signal.aborted) showDeleteStatus('Penghapusan belum berhasil', error.code === 'PERMISSION_DENIED' ?
        'Firebase menolak permintaan. Masuk ulang dengan akun Google Game Master, lalu coba lagi.' : error.message || 'Permintaan gagal dikirim.', 'error');
    } finally {
      deletePending = false;
      if (!signal.aborted) renderCards();
    }
  }

  confirmDelete.addEventListener('click', () => void deleteCharacter(), { signal });

  function renderCards() {
    count.textContent = 'Karakter GitHub (' + published.size + ')';
    cards.replaceChildren(...[...published].map(([id, item]) => makeCard(id, item, true)));
    const local = [...saved].filter(([id, entry]) => entry && !published.has(id));
    locals.hidden = !local.length;
    locals.replaceChildren(...local.map(([id, item]) => makeCard(id, item, false)));
    if (picker.open) renderPlayerCards();
  }

  function makeCardButton(name, image) {
    const thumbnail = Object.assign(document.createElement(validThumbnail(image) ? 'img' : 'span'), {
      className: 'character-card-thumb',
    });
    if (thumbnail.tagName === 'IMG') { thumbnail.alt = ''; thumbnail.src = image; }
    else { thumbnail.textContent = name.slice(0, 1).toUpperCase(); thumbnail.setAttribute('aria-hidden', 'true'); }
    const pick = Object.assign(document.createElement('button'), {
      type: 'button', className: 'character-card-pick',
    });
    pick.append(thumbnail, Object.assign(document.createElement('span'), { textContent: name }));
    return pick;
  }

  function equippedAsset() {
    return usingPlayer ? playerAsset ?? library.get('capsule') : library.get(current);
  }

  function renderPlayerCards() {
    playerCount.textContent = published.size + ' karakter GitHub';
    const active = equippedAsset().packageId;
    const focused = playerCards.contains(document.activeElement) ? document.activeElement.dataset.actor : undefined;
    const entries = [['', library.get('capsule')], ...published];
    playerCards.replaceChildren(...entries.map(([id, item]) => {
      const pick = makeCardButton(item.name || displayName(id), item.thumbnail);
      pick.dataset.actor = id;
      pick.disabled = pending || playerLoading || !runtime;
      pick.setAttribute('aria-pressed', String(id ? active === id : !equippedAsset().scene));
      const row = document.createElement('li');
      row.append(pick);
      return row;
    }));
    if (focused !== undefined) {
      const button = [...playerCards.querySelectorAll('button')].find(item => item.dataset.actor === focused);
      (button && !button.disabled ? button : picker.querySelector('[data-close-actors]')).focus({ preventScroll: true });
    }
  }

  async function chooseActor(id) {
    if (!runtime || pending || playerLoading || (id && !published.has(id))) return;
    playerLoading = true;
    playerStatus.textContent = 'Memuat karakter…';
    renderPlayerCards();
    try {
      const next = id ? await buildAsset(id, await fetchPackage(id), preset?.package === id ? preset : undefined) : undefined;
      if (!picker.open || signal.aborted) { disposeModel(next?.scene); return; }
      const previous = playerAsset;
      playerAsset = next;
      usingPlayer = true;
      disposeModel(previous?.scene);
      picker.close();
    } catch (error) {
      if (!signal.aborted) playerStatus.textContent = error.message || 'Karakter gagal dimuat.';
    } finally {
      playerLoading = false;
      if (picker.open && !signal.aborted) renderPlayerCards();
    }
  }

  function makeCard(id, item, online) {
    const name = item.name || displayName(id);
    const row = document.createElement('li');
    const pick = makeCardButton(name, item.thumbnail);
    pick.disabled = pending || !runtime;
    pick.setAttribute('aria-label', 'Edit ' + name);
    pick.setAttribute('aria-pressed', String(library.get(current).packageId === id));
    if (!online) pick.append(Object.assign(document.createElement('small'), { textContent: 'Lokal' }));
    pick.addEventListener('click', () => void loadSaved(id, preset?.package === id ? preset : undefined), { signal });
    row.append(pick);
    if (online) {
      const isDefault = preset?.package === id;
      const remove = Object.assign(document.createElement('button'), {
        type: 'button', className: 'character-card-delete', textContent: 'Hapus dari GitHub',
        disabled: !publication || deletePending || isDefault,
      });
      remove.setAttribute('aria-label', 'Hapus ' + name + ' dari GitHub');
      if (isDefault) pick.append(Object.assign(document.createElement('small'), { textContent: 'Default' }));
      if (isDefault) remove.title = 'Paket ini masih menjadi karakter default.';
      remove.addEventListener('click', () => {
        if (!publication || isDefault || deletePending || deleteDialog.open) return;
        deleteTarget = { id, name, sha: item.sha };
        deleteTitle.textContent = 'Hapus dari GitHub';
        deleteMessage.textContent = 'Hapus ' + name + ' dari daftar karakter semua pemain?';
        delete deleteDialog.dataset.state;
        workflowLink.hidden = true;
        confirmDelete.hidden = false;
        closeDelete.textContent = 'Batal';
        deleteDialog.showModal();
      }, { signal });
      row.append(remove);
    }
    return row;
  }

  async function refreshCards({ deleted } = {}) {
    if (refresh.disabled && !deleted) return;
    const epoch = ++listEpoch;
    refresh.disabled = playerRefresh.disabled = true;
    playerStatus.textContent = 'Memuat daftar karakter…';
    try {
      const url = 'https://api.github.com/repos/mawasetiawan/mawa-game/contents/docs/characters';
      const response = await fetch(deleted ? url + '?after=' + Date.now() : url, { signal, cache: 'no-store' });
      if (!response.ok) throw Error('Daftar karakter GitHub belum bisa dimuat.');
      const files = await response.json();
      if (signal.aborted || epoch !== listEpoch || !Array.isArray(files)) return;
      const previous = new Map(published);
      published.clear();
      for (const file of files) if (file.type === 'file' && packageName.test(file.name) && /^[a-f0-9]{40}$/.test(file.sha)) {
        if (deleted?.id === file.name && deleted.sha === file.sha) continue;
        const known = previous.get(file.name);
        published.set(file.name, known?.sha === file.sha ? known : { sha: file.sha });
      }
      renderCards();
      const entries = [...published].filter(([, item]) => !item.name);
      for (let i = 0; i < entries.length && epoch === listEpoch && !signal.aborted; i += 4) {
        await Promise.all(entries.slice(i, i + 4).map(async ([id, item]) => {
          try { Object.assign(item, await fetchCharacterCard(id, item.sha, signal)); } catch {}
        }));
        if (!signal.aborted && epoch === listEpoch) renderCards();
      }
      if (!signal.aborted) {
        lastRefresh = Date.now();
        if (!playerLoading) playerStatus.textContent = published.size ? '' : 'Belum ada karakter di GitHub.';
      }
      return !signal.aborted && epoch === listEpoch;
    } catch (error) {
      if (!signal.aborted && epoch === listEpoch) {
        playerStatus.textContent = error.message;
        if (!deleted && !deletePending) galleryStatus.textContent = error.message;
      }
      return false;
    } finally { if (!signal.aborted && epoch === listEpoch) refresh.disabled = playerRefresh.disabled = false; }
  }

  const edit = document.createElement('details');
  const editTitle = document.createElement('summary');
  editTitle.textContent = 'Edit Karakter';
  edit.append(editTitle);
  section.append(edit);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.className = 'character-import-status';
  const clipSummary = Object.assign(document.createElement('p'), { className: 'character-gallery-hint', hidden: true });
  const model = document.createElement('select');
  model.setAttribute('aria-label', 'Pilih karakter');
  const modelLabel = document.createElement('label');
  modelLabel.append('Karakter', model);
  edit.append(modelLabel);
  const controls = document.createElement('div');
  const library = new Map([['capsule', { name: 'Capsule bawaan' }]]);
  let current = 'capsule', serial = 0, runtime, preview = '', pending = false, exporting = false;
  const stateInputs = new Map();
  let draftThumbnail = '';
  let draft;
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
    item.accept = '.glb,.fbx,model/gltf-binary';
    item.hidden = true;
    section.append(item);
    return item;
  }
  const meshFile = fileInput(), clipsFile = fileInput();
  const importMesh = button('Impor Karakter GLB / FBX', () => meshFile.click());
  const importClips = button('Tambah Animasi Terpisah', () => clipsFile.click());
  const remove = button('Lepas dari editor', () => {
    const asset = library.get(current);
    if (!asset.scene) return;
    library.delete(current);
    model.querySelector('option:checked')?.remove();
    current = model.value = 'capsule';
    render();
    disposeModel(asset.scene);
    status.textContent = 'Karakter dilepas dari editor sesi ini. Paket GitHub tetap tersedia.';
  });
  remove.title = 'Keluarkan karakter dari editor di sesi ini.';
  edit.append(collection, status, clipSummary, controls);
  const sizeWarning = document.createElement('p');
  sizeWarning.className = 'character-size-warning';
  sizeWarning.setAttribute('role', 'status');
  sizeWarning.hidden = true;
  collection.after(sizeWarning);
  function showSizeWarning(bytes) {
    sizeWarning.hidden = bytes <= githubWebLimit;
    sizeWarning.textContent = sizeWarning.hidden ? '' :
      'Paket akhir ' + formatSize(bytes) +
      '. Batas upload GitHub lewat browser 25 MiB per file. Kecilkan mesh, tekstur, atau animasi untuk upload lewat browser.';
  }
  const save = button('Save as Character', async () => {
    if (pending || exporting) return;
    const asset = library.get(current);
    const name = nameField.value.trim();
    if (!asset?.source || !name) { status.textContent = 'Isi nama karakter terlebih dahulu.'; return; }
    const thumbnail = draftThumbnail;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'karakter';
    exporting = save.disabled = true;
    sizeWarning.hidden = false;
    const optimize = asset.sourceFormat === 'glb' && asset.embeddedCount > 0;
    sizeWarning.textContent = optimize ? 'Mengoptimalkan animasi dan mengompres paket…' : 'Mengompres paket…';
    try {
      // Preserve the source bytes if a library is unavailable or the GLB uses an unsupported extension.
      const sourceBytes = optimize ? await resampleCharacter(asset.source).catch(() => asset.source) : asset.source;
      if (signal.aborted) return;
      const reader = new FileReader();
      const source = await new Promise((resolve,reject) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob([sourceBytes]));
      });
      if (signal.aborted) return;
      const payload = { version: 1, name, thumbnail, source, sourceFormat: asset.sourceFormat,
        options: { ...asset.options }, mapping: { ...asset.mapping }, loops: { ...asset.loops },
        rootMotion: asset.rootMotion, extra: asset.clips.slice(asset.embeddedCount).map(clip => runtime.serializeClip(clip)) };
      const { file, suffix, rawSize } = await packCharacter(payload);
      if (signal.aborted) return;
      const id = slug + suffix;
      if (asset === library.get(current)) showSizeWarning(file.size);
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href: url, download: id });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // A locally exported package becomes shareable once it is available in the repository.
      asset.packageId = id;
      asset.name = name;
      asset.thumbnail = thumbnail;
      saved.set(id, payload);
      renderCards();
      status.textContent = (file.size < rawSize ? formatSize(rawSize) + ' → ' + formatSize(file.size) + '. ' : formatSize(file.size) + '. ') +
        (file.size > githubWebLimit ? 'Paket diunduh untuk penggunaan lokal.' : 'Paket siap diunggah lewat browser GitHub.');
    } catch (error) {
      if (asset === library.get(current)) {
        sizeWarning.hidden = false;
        sizeWarning.textContent = error.message || 'Paket karakter gagal disimpan.';
      }
    } finally {
      exporting = false;
      if (!signal.aborted) save.disabled = pending || !library.get(current)?.scene;
    }
  });
  const nameField = document.createElement('input');
  nameField.maxLength = 60;
  nameField.placeholder = 'Nama karakter';
  nameField.setAttribute('aria-label', 'Nama karakter');
  const nameLabel = document.createElement('label');
  nameLabel.append('Nama karakter', nameField);
  const thumbnailLabel = document.createElement('label');
  const thumbnailInput = Object.assign(document.createElement('input'), {
    type: 'file', accept: 'image/png,image/jpeg,image/webp',
  });
  thumbnailLabel.append('Thumbnail 1:1', thumbnailInput);
  const thumbnailPreview = Object.assign(document.createElement('img'), {
    className: 'character-card-thumb', alt: 'Preview thumbnail 1:1', hidden: true,
  });
  function showThumbnail() {
    thumbnailPreview.hidden = !draftThumbnail;
    if (draftThumbnail) thumbnailPreview.src = draftThumbnail;
    else thumbnailPreview.removeAttribute('src');
  }
  thumbnailInput.addEventListener('change', async () => {
    const file = thumbnailInput.files?.[0];
    if (!file) return;
    const asset = library.get(current);
    save.disabled = thumbnailInput.disabled = true;
    try {
      const thumbnail = await squareThumbnail(file);
      if (!signal.aborted && library.get(current) === asset) {
        draftThumbnail = thumbnail;
        showThumbnail();
      }
    } catch (error) { if (!signal.aborted) status.textContent = error.message; }
    finally {
      thumbnailInput.value = '';
      thumbnailInput.disabled = false;
      if (!signal.aborted) save.disabled = pending || exporting || !library.get(current)?.scene;
    }
  }, { signal });
  controls.append(nameLabel, thumbnailLabel, thumbnailPreview);
  refresh.addEventListener('click', () => void refreshCards(), { signal });
  playerRefresh.addEventListener('click', () => void refreshCards(), { signal });
  switchActor.addEventListener('click', () => {
    if (picker.open) return;
    renderPlayerCards();
    picker.showModal();
    switchActor.setAttribute('aria-expanded', 'true');
    if (Date.now() - lastRefresh > 60_000) void refreshCards();
  }, { signal });
  picker.querySelector('[data-close-actors]').addEventListener('click', () => picker.close(), { signal });
  picker.addEventListener('close', () => {
    switchActor.setAttribute('aria-expanded', 'false');
    playerStatus.textContent = playerRefresh.disabled ? 'Memuat daftar karakter…' : '';
  }, { signal });
  playerCards.addEventListener('click', event => {
    const card = event.target.closest('button[data-actor]');
    if (card) void chooseActor(card.dataset.actor);
  }, { signal });
  signal.addEventListener('abort', () => {
    if (picker.open) picker.close();
    switchActor.setAttribute('aria-expanded', 'false');
    playerCards.replaceChildren();
    playerStatus.textContent = '';
    playerRefresh.disabled = false;
    disposeModel(playerAsset?.scene);
  }, { once: true });
  const remotePackages = new Map();
  function fetchPackage(id) {
    const sha = published.get(id)?.sha;
    const key = sha ? id + '@' + sha : id;
    if (!remotePackages.has(key)) {
      if (remotePackages.size >= 12) remotePackages.delete(remotePackages.keys().next().value);
      const promise = (async () => {
        const url = rawCharacterRoot + 'docs/characters/' + encodeURIComponent(id) + (sha ? '?blob=' + sha : '');
        const response = await fetch(url, { signal });
        if (!response.ok) throw Error('Karakter belum bisa dimuat dari GitHub.');
        return unpackCharacter(await response.blob());
      })();
      remotePackages.set(key, promise);
      void promise.catch(() => { if (remotePackages.get(key) === promise) remotePackages.delete(key); });
    }
    return remotePackages.get(key);
  }

  async function buildAsset(id, data, overrides) {
    if (data.version !== 1 || typeof data.source !== 'string' || data.source.length > Math.ceil(maxBytes / 3) * 4) throw Error('Paket karakter tidak valid.');
    const buffer = Uint8Array.from(atob(data.source), character => character.charCodeAt(0)).buffer;
    const sourceFormat = data.sourceFormat === undefined ? 'glb' : data.sourceFormat;
    const payload = await runtime.read(buffer, sourceFormat);
    if (signal.aborted) { disposeModel(payload.scene); return null; }
    try {
      const next = runtime.prepare(payload);
      next.source = buffer;
      next.sourceFormat = sourceFormat;
      next.packageId = id;
      next.rootMotion = rootMotionOptions(overrides?.rootMotion ?? data.rootMotion);
      next.name = String(data.name ?? id).slice(0,60);
      next.thumbnail = validThumbnail(data.thumbnail) ? data.thumbnail : '';
      for (const [key, field] of Object.entries(settings)) {
        const value = overrides?.options?.[key] ?? data.options?.[key];
        if (Number.isFinite(value) && value >= Number(field.min) && value <= Number(field.max)) next.options[key] = value;
      }
      for (const entry of (Array.isArray(data.extra) ? data.extra : []).slice(0, 64-next.clips.length)) {
        next.clips.push(runtime.parseClip(entry));
      }
      next.detected = detectAnimations(next.clips);
      for (const key of Object.keys(states)) {
        const value = overrides?.mapping ? overrides.mapping[key] : data.mapping?.[key];
        if (value === 'off') next.mapping[key] = value;
        const loop = overrides?.loops ? overrides.loops[key] : data.loops?.[key];
        if (typeof loop === 'boolean') next.loops[key] = loop;
        if (typeof value === 'string' && /^\d+$/.test(value) && next.clips[Number(value)]) next.mapping[key] = value;
      }
      return next;
    } catch (error) {
      disposeModel(payload.scene);
      throw error;
    }
  }

  async function loadSaved(id, overrides) {
    if (!runtime || pending || !id) return;
    const sha = published.get(id)?.sha;
    for (const [key, asset] of library) {
      if (asset.packageId === id && asset.packageSha === sha) {
        current = model.value = key;
        usingPlayer = false;
        render();
        return;
      }
    }
    if (library.size >= 6) {
      galleryStatus.textContent = 'Lepas karakter yang tidak dipakai dari editor sebelum memuat paket lain.';
      return;
    }
    pending = true;
    render();
    try {
      const data = published.has(id) ? await fetchPackage(id) : saved.get(id) ?? await fetchPackage(id);
      const next = await buildAsset(id, data, overrides);
      if (!next) return;
      next.packageSha = sha;
      current = String(++serial);
      library.set(current, next);
      model.add(new Option(next.name, current));
      model.value = current;
      usingPlayer = false;
      galleryStatus.textContent = next.name + ' dipakai oleh pemain.';
    } catch(error) { if (!signal.aborted) galleryStatus.textContent = error.message; }
    finally { pending = false; if (!signal.aborted) render(); }
  }
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
      if (field.checkValidity() && Number.isFinite(field.valueAsNumber)) draft.options[key] = field.valueAsNumber;
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
          const { mapping } = draft;
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
        loop.addEventListener('change', () => { draft.loops[key] = loop.checked; }, { signal });
        loopLabel.append(key === 'fall' ? 'Loop sampai mendarat' : 'Loop', loop);
        group.append(loopLabel);
        stateInputs.set(key, { select, loop });
      }
    }
  }
  addAnimationGroups('Locomotion', groups);
  addAnimationGroups('Aksi', actionGroups);
  const audition = document.createElement('select');
  audition.setAttribute('aria-label', 'Preview animasi');
  audition.addEventListener('change', () => {
    preview = audition.value;
    if (preview) usingPlayer = false;
  }, { signal });
  const previewLabel = document.createElement('label');
  previewLabel.append('Preview animasi', audition);
  controls.prepend(previewLabel);
  section.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault();
  }, { signal });
  world.querySelector('.developer-fields').append(section);

  function fill(select, asset, value, empty) {
    select.replaceChildren(new Option(empty, ''), ...asset.clips.flatMap((clip, index) =>
      playableClip(clip) ? [new Option(clip.name || 'Klip ' + (index + 1), String(index))] : []));
    select.value = value;
  }

  const rootToggle = document.createElement('input');
  rootToggle.type = 'checkbox';
  const rootSelect = document.createElement('select');
  const locomotionSelect = document.createElement('select');
  locomotionSelect.add(new Option('In-Place · capsule', 'in-place'));
  locomotionSelect.add(new Option('Root Motion · animasi', 'root'));
  const locomotionLabel = document.createElement('label');
  locomotionLabel.append('Sumber gerakan', locomotionSelect);
  const rootSpeed = Object.assign(document.createElement('input'), { type: 'checkbox' });
  const rootSpeedLabel = document.createElement('label');
  rootSpeedLabel.append('Hitung kecepatan capsule dari root', rootSpeed);
  const rootSettings = document.createElement('details');
  const rootTitle = Object.assign(document.createElement('summary'), { textContent: 'Root Motion & In-Place' });
  const rootLabel = document.createElement('label');
  rootLabel.append('Root motion serangan (X/Z)', rootToggle);
  const rootNodeLabel = document.createElement('label');
  rootNodeLabel.append('Node root motion', rootSelect);
  rootSettings.append(rootTitle, locomotionLabel, rootSpeedLabel, rootNodeLabel, rootLabel);
  controls.append(rootSettings);
  locomotionSelect.addEventListener('change', () => {
    draft.rootMotion.locomotion = locomotionSelect.value;
    rootSpeed.disabled = locomotionSelect.value === 'root';
  }, { signal });
  rootSpeed.addEventListener('change', () => { draft.rootMotion.useRootSpeed = rootSpeed.checked; }, { signal });
  rootToggle.addEventListener('change', () => {
    draft.rootMotion.enabled = rootToggle.checked;
  }, { signal });
  rootSelect.addEventListener('change', () => {
    draft.rootMotion.node = rootSelect.value;
  }, { signal });

  const apply = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Apply Setting' });
  apply.addEventListener('click', () => {
    const asset = library.get(current);
    if (!asset.scene || pending) return;
    const invalid = Object.values(settings).find(input => !input.checkValidity() || !Number.isFinite(input.valueAsNumber));
    if (invalid) { invalid.reportValidity(); return; }
    Object.assign(asset, structuredClone(draft));
    usingPlayer = false;
    status.textContent = 'Karakter dan animasi diterapkan ke pemain lokal.';
  }, { signal });
  controls.append(apply);

  function render() {
    const asset = library.get(current);
    controls.hidden = !asset.scene;
    clipSummary.hidden = !asset.scene;
    if (asset.scene) {
      const bundled = asset.clips.slice(0, asset.embeddedCount).filter(playableClip).length;
      const extra = asset.clips.slice(asset.embeddedCount).filter(playableClip).length;
      clipSummary.textContent = bundled + ' klip bawaan dari file karakter' +
        (extra ? ' · ' + extra + ' klip tambahan' : '') + '.';
    }
    importMesh.disabled = pending || !runtime || library.size >= 6;
    importClips.disabled = pending || !runtime || !asset.scene || asset.clips.length >= 64;
    remove.disabled = pending || !asset.scene;
    model.disabled = pending;
    save.disabled = pending || exporting || !asset.scene;
    nameField.value = asset.name ?? '';
    draftThumbnail = asset.thumbnail ?? '';
    showThumbnail();
    renderCards();
    showSizeWarning(0);
    preview = '';
    if (!asset.scene) return;
    draft = structuredClone({ options: asset.options, mapping: asset.mapping, loops: asset.loops, rootMotion: asset.rootMotion });
    rootToggle.checked = asset.rootMotion.enabled;
    locomotionSelect.value = asset.rootMotion.locomotion;
    rootSpeed.checked = asset.rootMotion.useRootSpeed;
    rootSpeed.disabled = locomotionSelect.value === 'root';
    rootSelect.replaceChildren(new Option('Otomatis (Root / Armature / Hips)', ''),
      ...runtime.motionNodes(asset).map(name => new Option(name, name)));
    rootSelect.value = asset.rootMotion.node;
    for (const [key,field] of Object.entries(settings)) field.value = asset.options[key];
    for (const [key, { select, loop }] of stateInputs) {
      const detected = animationClip({ clips: asset.clips, detected: asset.detected }, key);
      const disabled = asset.mapping[key] === 'off';
      const automatic = detected ? 'Otomatis · ' + detected.name : disabled ? 'Otomatis' : 'No Animation';
      fill(select, asset, asset.mapping[key] ?? '', automatic);
      if (detected || disabled) select.add(new Option('No Animation', 'off'), 1);
      select.value = asset.mapping[key] ?? '';
      loop.checked = key === 'fall' || (key !== 'death' && (asset.loops[key] ?? loopsByDefault(key)));
    }
    const canPreview = asset.clips.some(playableClip);
    audition.disabled = pending || !canPreview;
    fill(audition, asset, '', canPreview ? 'Ikuti gerakan' : 'Tidak ada klip animasi');
  }
  model.add(new Option('Capsule bawaan','capsule'));
  model.addEventListener('change', () => { current = model.value; usingPlayer = false; render(); }, {signal});

  async function load(input, animationsOnly) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || pending || !runtime) return;
    const asset = library.get(current);
    pending = true;
    render();
    status.dataset.state = 'pending';
    status.textContent = 'Memuat ' + file.name + '…';
    let payload, firstPreview = -1;
    try {
      const extension = /\.(glb|fbx)$/i.exec(file.name);
      if (!extension || file.size > maxBytes || file.size < 12) throw Error('Pilih file GLB atau FBX valid berukuran maksimal 32 MiB.');
      const sourceFormat = extension[1].toLowerCase();
      const source = await file.arrayBuffer();
      payload = await runtime.read(source, sourceFormat);
      if (signal.aborted) return;
      if (animationsOnly) {
        const clips = payload.animations.filter(clip => runtime.compatible(clip, asset.scene));
        if (!clips.length) throw Error('Tidak ada klip yang cocok dengan rig dan nama tulang mesh ini.');
        const count = Math.min(64 - asset.clips.length, clips.length);
        asset.clips.push(...clips.slice(0, count));
        asset.packageId = undefined;
        asset.detected = detectAnimations(asset.clips);
        status.textContent = count + ' klip dipasang ke daftar animasi.';
      } else {
        const next = runtime.prepare(payload);
        next.source = source;
        next.sourceFormat = sourceFormat;
        next.name = file.name.slice(0, -extension[0].length);
        current = String(++serial);
        library.set(current,next);
        model.add(new Option(file.name, current));
        model.value = current;
        const clipCount = next.clips.filter(playableClip).length;
        firstPreview = next.clips.findIndex(playableClip);
        status.textContent = file.name + ' berhasil dimuat. ' +
          (clipCount ? clipCount + ' klip bawaan terbaca. Memutar preview klip pertama.' : 'File ini tidak berisi klip animasi yang terbaca.') +
          (payload.externalTextures ? ' Tekstur eksternal dilewati. Sematkan tekstur saat ekspor FBX agar tampil di game.' : '');
        payload = null;
      }
      status.dataset.state = 'success';
      usingPlayer = false;
    } catch (error) {
      if (!signal.aborted) {
        status.dataset.state = 'error';
        status.textContent = 'Gagal impor ' + file.name + '. ' + (error.message || 'File karakter gagal dimuat.');
      }
    } finally {
      if (payload) disposeModel(payload.scene);
      pending = false;
      if (!signal.aborted) {
        render();
        if (firstPreview >= 0) audition.value = preview = String(firstPreview);
      }
    }
  }
  meshFile.addEventListener('change', () => void load(meshFile, false), { signal });
  clipsFile.addEventListener('change', () => void load(clipsFile, true), { signal });
  render();
  void refreshCards();

  return {
    networkState() {
      const id = equippedAsset().packageId;
      return id && (published.has(id) || id === preset?.package) ? { id } : undefined;
    },
    createPeer(THREE, scene) {
      const view = createCharacterView(THREE, scene);
      let activeId, asset, epoch = 0;
      function reset() {
        epoch++;
        if (asset) {
          view.update(null, null, 0, { visible: false });
          disposeModel(asset.scene);
          asset = null;
        }
      }
      return {
        update(id, actor, dt, capsule) {
          if (id !== activeId) {
            activeId = id;
            reset();
            const requested = epoch;
            if (typeof id === 'string' && id.length <= 100 && packageName.test(id)) {
              void (async () => {
                try {
                  const data = await fetchPackage(id);
                  if (requested !== epoch || signal.aborted) return;
                  const model = await buildAsset(id, data, preset?.package === id ? preset : undefined);
                  if (!model) return;
                  if (requested === epoch && !signal.aborted) asset = model;
                  else disposeModel(model.scene);
                } catch (error) {
                  if (requested === epoch && !signal.aborted) console.warn('Karakter pemain tidak tersedia:', id, error.message);
                }
              })();
            }
          }
          view.update(asset, actor, dt, capsule);
        },
        height() { return asset ? 1.8 * asset.options.scale + asset.options.height : null; },
        remove() { reset(); view.remove(); },
      };
    },
    snapshot() {
      if (pending) throw Error('Tunggu sampai karakter selesai dimuat sebelum ekspor.');
      const asset = library.get(current);
      if (!asset.scene) return null;
      if (!asset.packageId) throw Error('Ekspor karakter aktif lewat Save as Character dan upload paketnya sebelum menyimpan pengaturan.');
      return { package: asset.packageId, options: asset.options, mapping: asset.mapping, loops: asset.loops, rootMotion: asset.rootMotion };
    },
    hasAnimation(slot) {
      const asset = equippedAsset();
      return !asset.scene || Boolean(animationClip(asset, slot));
    },
    attackMotion(slot) {
      const asset = equippedAsset();
      const clip = animationClip(asset, slot);
      return asset.rootMotion?.enabled && clip && runtime ? runtime.attackMotion(asset, clip) : null;
    },
    locomotionDelta(actor, slot, previousPhase, dt, strength, directionX, directionZ) {
      const asset = equippedAsset();
      const options = asset.rootMotion;
      const clip = animationClip(asset, slot);
      if (!clip || !runtime || (options.locomotion !== 'root' && !options.useRootSpeed)) return null;
      return runtime.locomotionDelta(asset, clip, actor, slot, previousPhase, dt, strength, directionX, directionZ);
    },
    animationSpeed() { return equippedAsset().options?.speed ?? 1; },
    duration(slot) {
      const asset = equippedAsset();
      const clip = animationClip(asset, slot);
      return clip ? clip.duration / asset.options.speed : undefined;
    },
    height() {
      const { options } = equippedAsset();
      return options ? 1.8 * options.scale + options.height : null;
    },
    attach(THREE, scene) {
      const view = createCharacterView(THREE, scene);
      runtime = {
        async read(buffer, format) {
          if (buffer.byteLength < 12 || buffer.byteLength > maxBytes) throw Error('Ukuran file karakter tidak valid.');
          if (format === 'fbx') {
            const { FBXLoader } = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/FBXLoader.js');
            const manager = new THREE.LoadingManager();
            const blobs = new Set();
            let externalTextures = false;
            // FBXLoader creates blob URLs for embedded binary images. Loaded images remain available after revocation.
            manager.onLoad = () => { for (const url of blobs) URL.revokeObjectURL(url); blobs.clear(); };
            manager.setURLModifier(url => {
              if (/^blob:/i.test(url)) { blobs.add(url); return url; }
              if (/^data:image\//i.test(url)) return url;
              externalTextures = true;
              return whiteTexture;
            });
            try {
              const scene = new FBXLoader(manager).parse(buffer, '');
              return { scene, animations: scene.animations, externalTextures };
            } catch (error) {
              manager.onLoad();
              throw Error('FBX gagal dibaca. Ekspor ulang FBX dari Blender, Maya, atau Unreal.', { cause: error });
            }
          }
          if (format !== 'glb') throw Error('Format paket karakter harus GLB atau FBX.');
          if (new DataView(buffer).getUint32(0,true) !== 0x46546c67) throw Error('File ini bukan GLB.');
          const { GLTFLoader } = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/GLTFLoader.js');
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (!/^(blob:|data:)/i.test(url)) throw Error('GLB harus menyertakan tekstur dan aset di dalam file.');
            return url;
          });
          return new GLTFLoader(manager).parseAsync(buffer,'');
        },
        parseClip(data) { return THREE.AnimationClip.parse(data); },
        serializeClip(clip) {
          const copy = clip.clone();
          for (const track of copy.tracks) {
            if (!track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline) track.optimize();
          }
          return THREE.AnimationClip.toJSON(copy);
        },
        compatible(clip, mesh) {
          return clip.tracks.length > 0 && clip.tracks.every(track => {
            const binding = THREE.PropertyBinding.parseTrackName(track.name);
            return Boolean(THREE.PropertyBinding.findNode(mesh,binding.nodeName));
          });
        },
        motionNodes(asset) {
          const names = new Set();
          for (const clip of asset.clips) for (const track of clip.tracks) {
            if (!track.name.endsWith('.position')) continue;
            const binding = THREE.PropertyBinding.parseTrackName(track.name);
            const name = binding.objectName === 'bones' ? binding.objectIndex : binding.nodeName;
            if (name) names.add(name);
          }
          return [...names].sort();
        },
        attackMotion(asset, clip) {
          const motion = horizontalRootMotion(THREE, asset, clip);
          if (!motion) return null;
          const scale = asset.fit.scale.x * asset.options.scale;
          const speed = asset.options.speed;
          const yaw = asset.options.yaw * Math.PI / 180;
          const [sin, cos] = [Math.sin(yaw), Math.cos(yaw)];
          return seconds => {
            const { x, z } = motion.offset(seconds * speed);
            return { x: (x * cos + z * sin) * scale, z: (z * cos - x * sin) * scale };
          };
        },
        locomotionDelta(asset, clip, actor, slot, previous, dt, strength, directionX, directionZ) {
          const motion = horizontalRootMotion(THREE, asset, clip, true);
          if (!motion) return null;
          const scale = asset.fit.scale.x * asset.options.scale;
          const advance = dt * asset.options.speed;
          if (asset.rootMotion.locomotion === 'in-place') {
            const stride = motion.offset(clip.duration);
            const distance = Math.hypot(stride.x, stride.z) * scale;
            if (distance < .001) return null;
            const step = distance / clip.duration * advance * strength;
            return { x: directionX * step, z: directionZ * step };
          }
          const loop = asset.loops[slot] ?? loopsByDefault(slot);
          const sameMotion = previous?.clip === clip && previous.slot === slot && previous.motion === motion;
          const start = sameMotion ? previous.end : 0;
          const end = start + advance;
          actor.locomotionPhase = { clip, slot, motion, start, end: loop ? end % clip.duration : Math.min(end, clip.duration) };
          const { x, z } = rootDelta(motion.offset, clip.duration, start, end, loop);
          const angle = Math.atan2(actor.facingX, actor.facingZ) + asset.options.yaw * Math.PI / 180;
          const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
          return { x: (x * cos + z * sin) * scale * strength, z: (z * cos - x * sin) * scale * strength };
        },
        prepare(payload) {
          let meshCount = 0;
          payload.scene.traverse(node => { if (node.isMesh) meshCount++; });
          const bounds = new THREE.Box3().setFromObject(payload.scene);
          const height = bounds.max.y - bounds.min.y;
          if (!meshCount || !Number.isFinite(height) || height <= 0) throw Error('File karakter perlu berisi mesh 3D.');
          const center = bounds.getCenter(new THREE.Vector3());
          const fit = new THREE.Group();
          fit.scale.setScalar(1.8 / height);
          const offset = new THREE.Group();
          offset.position.set(-center.x,-bounds.min.y,-center.z);
          offset.add(payload.scene);
          fit.add(offset);
          const clips = payload.animations.slice(0, 64);
          return { scene: payload.scene, fit, clips, mapping: {}, detected: detectAnimations(clips), loops: {}, embeddedCount: clips.length,
            lockInPlace: createInPlaceLock(THREE, fit, payload.scene),
            rootMotion: rootMotionOptions(), options: {scale:1,height:0,yaw:0,speed:1,blend:.16} };
        },
      };
      render();
      if (typeof preset?.package === 'string' && packageName.test(preset.package)) {
        void loadSaved(preset.package, preset);
      }
      signal.addEventListener('abort', () => {
        view.remove();
        const images = new Set();
        for (const asset of library.values()) disposeModel(asset.scene, images);
      }, {once:true});
      return (actor, dt, capsule, timeScale) => {
        const previewVisible = !usingPlayer && characterTabActive && !developerPanel?.hidden && section.open && edit.open;
        view.update(equippedAsset(), actor, dt, capsule, timeScale, previewVisible ? preview : '');
      };
    },
  };
}
