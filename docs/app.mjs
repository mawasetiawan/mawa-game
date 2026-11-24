import { mountCameraCuePanel } from './camera-cues.mjs';
import { mountHudEditor } from './hud-editor.mjs?v=2';
import { mountCameraPanel, parseCamera } from './camera-settings.mjs';
import { defaults, parseSettings, DEVELOPER_EMAIL, mountDeveloperPanel, mountDeveloperTabs } from './game-settings.mjs?v=5';
import { createLoginHandoff } from './login-handoff.mjs';
import { firebaseConfig } from './config.mjs';
import { connectMapReplication } from './map-replication.mjs?v=2';
import { connectParty } from './party.mjs?v=1';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt;
ui.installGame.hidden = installed || !ios;
window.addEventListener('beforeinstallprompt', event => {
  if (installed) return;
  event.preventDefault();
  installPrompt = event;
  ui.installGame.hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  ui.installGame.hidden = true;
});
ui.installGame.addEventListener('click', async () => {
  if (!installPrompt) return ui.installHelp.showModal();
  const prompt = installPrompt;
  installPrompt = null;
  try {
    await prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') ui.installGame.hidden = true;
  } catch {
    ui.installHelp.showModal();
  }
});

const status = text => { ui.status.textContent = text; };
function show(view) {
  for (const node of [ui.gate, ui.loading, ui.menu, ui.world]) node.hidden = node !== view;
}

function identity(container, profile) {
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = Array.from(profile.name)[0]?.toUpperCase() || '?';
  const name = document.createElement('span');
  name.textContent = profile.name;
  container.append(avatar, name);
  if (!/^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//i.test(profile.photo)) return;
  const image = new Image();
  image.alt = '';
  image.className = 'avatar';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', () => avatar.replaceWith(image), { once: true });
  image.src = profile.photo;
}

function bind(control, action, failure) {
  control.addEventListener('click', async () => {
    control.disabled = true;
    try { await action(); }
    catch (error) {
      console.error(error);
      status(failure);
    } finally { control.disabled = false; }
  });
}

function button(label, action, failure) {
  const control = document.createElement('button');
  control.textContent = label;
  bind(control, action, failure);
  return control;
}

async function start() {
  const sdk = 'https://www.gstatic.com/firebasejs/12.5.0';
  const [{ initializeApp }, authSdk, data] = await Promise.all([
    import(sdk + '/firebase-app.js'),
    import(sdk + '/firebase-auth.js'),
    import(sdk + '/firebase-database.js')
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  const db = data.getDatabase(app);
  const { ref, push, set, remove, get, onValue, onDisconnect, query, orderByKey, limitToLast } = data;
  let session;
  const settings = { ...defaults };
  const applySettings = values => {
    Object.assign(settings, parseSettings(values));
    ui.world.style.setProperty('--hud-scale', settings.hudScale / 100);
  };
  applySettings(defaults);
  const settingsRef = ref(db, 'gameSettings');
  const cameraRef = ref(db, 'cameraSettings');
  let sharedCamera = parseCamera();
  const developerCameras = new Map();
  const isDeveloper = user => user?.emailVerified && user.email === DEVELOPER_EMAIL;
  const getCamera = () => {
    const user = auth.currentUser;
    return (isDeveloper(user) ? developerCameras.get(user.uid) : null) ?? sharedCamera;
  };
  onValue(cameraRef, snapshot => { sharedCamera = parseCamera(snapshot.val()); },
    error => console.warn('Camera settings:', error));
  fetch('./settings.json?v=hud1').then(response => {
    if (!response.ok) throw Error('Settings snapshot unavailable');
    return response.json();
  }).then(snapshot => {
    if (!liveSettings) applySettings(snapshot);
  }).catch(error => console.warn(error));
  let liveSettings = false;
  onValue(settingsRef, snapshot => {
    if (!snapshot.exists()) return;
    liveSettings = true;
    applySettings(snapshot.val());
  }, error => console.error('Settings read:', error));

  const fullscreen = ui.fullscreen;
  const nativeFullscreen = () => document.fullscreenElement === ui.world || document.webkitFullscreenElement === ui.world;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  const themeColor = document.querySelector('meta[name=theme-color]');
  function setImmersive(enabled) {
    themeColor.content = enabled ? '#48677d' : '#101e26';
    ui.world.classList.toggle('immersive-map', enabled);
    document.documentElement.classList.toggle('immersive-game', enabled);
    updateFullscreen();
    ui.world.dispatchEvent(new Event('mawa:hud-viewport'));
  }

  function updateFullscreen() {
    const active = nativeFullscreen() || ui.world.classList.contains('immersive-map');
    const label = active ? 'Keluar Fullscreen' : 'Fullscreen';
    fullscreen.querySelector('span').textContent = label;
    fullscreen.setAttribute('aria-label', label);
    fullscreen.setAttribute('aria-pressed', String(active));
  }

  function exitMapFullscreen() {
    setImmersive(false);
    if (!nativeFullscreen()) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) return exit.call(document);
  }

  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(name, updateFullscreen);
  }
  fullscreen.addEventListener('click', async () => {
    ui.mapNotice.textContent = '';
    if (nativeFullscreen() || ui.world.classList.contains('immersive-map')) {
      try { await exitMapFullscreen(); } catch (error) { console.warn(error); }
      return;
    }

    const request = ui.world.requestFullscreen || ui.world.webkitRequestFullscreen;
    if (request && !iphone && !standalone) {
      try { await request.call(ui.world); return; }
      catch (error) { console.warn(error); }
    }

    setImmersive(true);
    if (iphone && !standalone) {
      ui.mapNotice.textContent = 'Tanpa bilah Safari: Bagikan → Tambah ke Layar Utama → buka dari ikon Mawa Game.';
    }
  });
  function stopBrowserGesture(event) {
    if (!event.target.closest('input, textarea, [contenteditable]')) event.preventDefault();
  }
  for (const name of ['selectstart', 'contextmenu', 'dragstart', 'copy']) {
    ui.world.addEventListener(name, stopBrowserGesture);
  }

  const touchChat = matchMedia('(pointer: coarse)').matches;
  if (!touchChat) {
    ui.chat.dataset.desktop = '';
    ui.chatClose.before(ui.send);
  }

  function updateChatPreview(latest) {
    const text = latest?.textContent?.trim();
    ui.chatLatest.replaceChildren(...(latest ? [...latest.childNodes].map(node => node.cloneNode(true)) : ['Open Chat']));
    ui.chatToggle.title = text || 'Buka chat room';
    ui.chatToggle.setAttribute('aria-label', text ? 'Buka chat: ' + text : 'Buka chat room');
  }
  updateChatPreview();
  let keyboardPage = 'letters';
  let uppercase = false;

  function showKeyboard(open) {
    ui.chatKeyboard.hidden = !open;
    ui.chat.toggleAttribute('data-keyboard', open);
    ui.message.inputMode = open || touchChat ? 'none' : 'text';
  }
  showKeyboard(false);

  function renderKeys() {
    const rows = keyboardPage === 'letters'
      ? ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map(row => [...(uppercase ? row.toUpperCase() : row)])
      : ['1234567890', '@#%&*()-_', '.,!?/:+='].map(row => [...row]);
    rows[2].push('⌫');
    if (keyboardPage === 'letters') rows[2].unshift('⇧');
    ui.chatKeyMode.dataset.key = ui.chatKeyMode.textContent = keyboardPage === 'letters' ? '123' : 'ABC';
    ui.chatKeyboard.replaceChildren(...rows.map(keys => {
      const row = document.createElement('div');
      for (const key of keys) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.key = key;
        button.textContent = key;
        if (key === '⌫') button.setAttribute('aria-label', 'Hapus karakter');
        if (key === '⇧') button.setAttribute('aria-label', 'Huruf kapital');
        row.append(button);
      }
      return row;
    }));
  }
  if (touchChat) {
    renderKeys();
    ui.message.addEventListener('focus', () => showKeyboard(true));
    ui.message.addEventListener('click', () => showKeyboard(true));
    ui.composer.addEventListener('pointerdown', event => {
      if (event.target.closest('button[data-key]')) event.preventDefault();
    });
    ui.composer.addEventListener('click', event => {
      const key = event.target.closest('button')?.dataset.key;
      if (!key) return;
      if (key === '123' || key === 'ABC' || key === '⇧') {
        keyboardPage = key === '123' ? 'symbols' : 'letters';
        uppercase = key === '⇧' && !uppercase;
        renderKeys();
        return;
      }
      const { selectionStart: start, selectionEnd: end, value, maxLength } = ui.message;
      if (key === '⌫') {
        const previous = Array.from(value.slice(0, start)).at(-1)?.length ?? 0;
        ui.message.setRangeText('', start === end ? start - previous : start, end, 'end');
      } else {
        const character = key === 'Spasi' ? ' ' : key;
        if (value.length - (end - start) + character.length > maxLength) return;
        ui.message.setRangeText(character, start, end, 'end');
      }
      ui.message.focus({ preventScroll: true });
      ui.message.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  let composerFrame;
  function resizeComposer() {
    cancelAnimationFrame(composerFrame);
    if (!ui.chat.hasAttribute('data-open')) return;
    composerFrame = requestAnimationFrame(() => {
      ui.message.style.height = 'auto';
      ui.message.style.height = Math.min(100, Math.max(44, ui.message.scrollHeight)) + 'px';
    });
  }

  function composer(active) {
    const hasText = Boolean(ui.message.value.trim());
    ui.chat.toggleAttribute('data-composing', hasText);
    ui.send.disabled = !hasText || !active?.connected || !active.chatReady || active.sending === true;
    resizeComposer();
  }

  function setChat(open) {
    ui.chat.toggleAttribute('data-open', open);
    ui.chatToggle.setAttribute('aria-expanded', String(open));
    if (!open) {
      showKeyboard(false);
      return;
    }
    ui.message.focus({ preventScroll: true });
    ui.messages.scrollTop = ui.messages.scrollHeight;
    composer(session);
  }

  ui.chatToggle.addEventListener('click', () => setChat(!ui.chat.hasAttribute('data-open')));
  ui.chatClose.addEventListener('click', () => {
    setChat(false);
    ui.chatToggle.focus({ preventScroll: true });
  });
  ui.message.addEventListener('input', () => composer(session));
  ui.chat.addEventListener('transitionend', event => {
    if (event.target === ui.chat && event.propertyName === 'width') resizeComposer();
  });
  window.addEventListener('resize', resizeComposer);
  ui.message.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!ui.send.disabled) ui.composer.requestSubmit();
  });
  ui.chat.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !ui.chat.hasAttribute('data-open')) return;
    event.preventDefault();
    setChat(false);
    ui.chatToggle.focus();
  });

  function closeMap(active) {
    Promise.resolve(exitMapFullscreen()).catch(console.warn);
    ui.mapNotice.textContent = '';
    active.exploration?.abort();
    active.exploration = null;
    ui.mapError.hidden = true;
    active.stopChat?.();
    active.stopChat = null;
    active.messages = null;
    active.chatReady = false;
    ui.messages.replaceChildren();
    updateChatPreview();
    ui.message.value = '';
    setChat(false);
    composer(active);
  }

  function openMap(active, key) {
    closeMap(active);
    active.map = key;
    ui.mapTitle.textContent = 'Map Kosong';
    ui.loadingText.textContent = 'Masuk ke map bersama party…';
    show(ui.loading);
    const messages = ref(db, 'partyRooms/' + key + '/messages');
    active.messages = messages;
    const exploration = new AbortController();
    active.exploration = exploration;
    if (isDeveloper(active.user)) {
      mountDeveloperPanel(ui.world, next => set(settingsRef, next), settings, exploration.signal);
      mountCameraCuePanel(ui.world, exploration.signal);
      mountHudEditor(ui.world, exploration.signal, active.user.uid);
      mountCameraPanel(ui.world, {
        current: getCamera,
        applyLocal: next => developerCameras.set(active.user.uid, next),
        applyShared: async next => {
          await set(cameraRef, next);
          developerCameras.delete(active.user.uid);
        },
        clearLocal: () => developerCameras.delete(active.user.uid),
      }, exploration.signal);
      mountDeveloperTabs(ui.world, exploration.signal);
    }
    import('./explore.mjs?v=8').then(({ mountExploration }) => {
      if (exploration.signal.aborted) return;
      const replication = connectMapReplication(data, db, key, active.user.uid, exploration.signal);
      return mountExploration(ui.world, exploration.signal, replication, settings, getCamera);
    }).catch(error => {
      if (exploration.signal.aborted) return;
      exploration.abort();
      console.error(error);
      ui.mapError.textContent = 'Map 3D gagal dimuat.';
      ui.mapError.hidden = false;
    });
    active.stopChat = onValue(query(messages, orderByKey(), limitToLast(20)), snapshot => {
      if (active !== session || active.messages !== messages) return;
      const nearBottom = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 45;
      const rows = [];
      snapshot.forEach(child => {
        const { name, text } = child.val();
        const row = document.createElement('li');
        const author = document.createElement('strong');
        author.textContent = name + ': ';
        row.append(author, document.createTextNode(text));
        rows.push(row);
      });
      ui.messages.replaceChildren(...rows.slice(-3));
      updateChatPreview(rows.at(-1));
      if (nearBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
      active.chatReady = true;
      const enteringMap = ui.world.hidden;
      show(ui.world);
      if (standalone && enteringMap) setImmersive(true);
      composer(active);
    }, error => {
      if (active !== session || active.messages !== messages) return;
      console.error(error);
      active.chatReady = false;
      composer(active);
      const enteringMap = ui.world.hidden;
      show(ui.world);
      if (standalone && enteringMap) setImmersive(true);
      status('Chat grup gagal dimuat.');
    });
  }

  function renderLobby(active) {
    const state = active.partyState;
    if (!state?.ready || !active.playersReady) return;
    const { key, room, offers, roster, busy } = state;
    if (room?.phase === 'playing') {
      if (active.map !== key) openMap(active, key);
      return;
    }
    if (active.map) {
      closeMap(active);
      active.map = null;
    }
    show(ui.menu);
    const host = room?.host === active.user.uid;
    const waiting = room?.phase === 'waiting';
    const canInvite = !key || (host && waiting);
    const canAccept = !key || (host && waiting && Object.keys(roster).every(id => id === active.user.uid));
    ui.createParty.hidden = Boolean(key);
    ui.createParty.disabled = busy || !active.connected;
    ui.party.hidden = !key;
    ui.play.hidden = !host || !waiting;
    ui.play.disabled = busy || !active.connected;
    ui.leaveParty.disabled = busy || !active.connected;
    ui.partyTitle.textContent = room?.name ? 'Party · ' + room.name : 'Party';
    ui.partyHint.textContent = room?.phase === 'closed' ? 'Party ditutup.' :
      host ? 'Undang pemain online, lalu mulai saat party siap.' : 'Menunggu host memulai map.';
    const rosterRows = Object.entries(roster).map(([id, profile]) => {
      const row = document.createElement('li');
      row.className = 'player';
      identity(row, profile);
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = id === room?.host ? 'Host' : 'Anggota';
      row.append(role);
      return row;
    });
    ui.roster.replaceChildren(...rosterRows);

    const online = Object.entries(active.players);
    ui.count.textContent = '(' + online.length + ')';
    ui.players.replaceChildren(...online.map(([id, profile]) => {
      const row = document.createElement('li');
      row.className = 'player';
      identity(row, profile);
      if (id !== active.user.uid && !roster[id] && canInvite) {
        const invite = button('Undang', async () => {
          await active.party.invite(id);
          status('Undangan dikirim ke ' + profile.name + '.');
        }, 'Undangan gagal dikirim.');
        invite.disabled = busy || !active.connected;
        row.append(invite);
      }
      return row;
    }));

    const invitations = Object.entries(offers).map(([id, offer]) => {
      const row = document.createElement('li');
      row.className = 'player';
      const label = document.createElement('span');
      label.textContent = offer.name;
      const accept = button('Terima', async () => {
        await active.party.accept(id);
        status('');
      }, 'Undangan sudah tidak tersedia atau host sudah mulai.');
      const decline = button('Tolak', () => active.party.decline(id), 'Undangan gagal ditolak.');
      accept.disabled = busy || !active.connected || !canAccept;
      decline.disabled = busy || !active.connected;
      row.append(label, accept, decline);
      return row;
    });
    ui.invites.replaceChildren(...invitations);
    ui.invitations.hidden = !invitations.length;
  }

  const gameUrl = new URL('./', window.location.href);
  ui.gameLink.value = gameUrl.href;
  if (standalone) {
    ui.loginChoiceHint.textContent = 'Pilih tempat bermain. Login di app ini dan login di browser lain memakai sesi terpisah.';
    ui.loginHere.textContent = 'Lanjut di app Mawa Game';
    try {
      await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    } catch (error) {
      console.warn('Penyimpanan sesi login tidak dapat diatur:', error);
    }
  }

  const agent = navigator.userAgent;
  const appleMobile = /iPhone|iPad|iPod/.test(agent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (appleMobile && (standalone || !/CriOS/.test(agent)) && gameUrl.protocol === 'https:') {
    ui.loginChrome.href = 'googlechromes:' + gameUrl.href.slice('https:'.length);
    ui.loginChrome.hidden = false;
  }

  const handoff = appleMobile && standalone && gameUrl.protocol === 'https:'
    ? createLoginHandoff({ initializeApp, config: firebaseConfig, authSdk, data, auth, report: status })
    : null;
  let browserLink = gameUrl;
  if (handoff) {
    ui.loginChoiceHint.textContent = 'Siapkan link login, pilih browser, lalu kembali ke ikon Mawa Game.';
    ui.loginChrome.hidden = true;
    ui.loginOther.disabled = true;
    void handoff.resume().catch(() => {});
  }
  ui.login.addEventListener('click', async () => {
    ui.loginChoice.showModal();
    if (!handoff || ui.login.disabled) return;
    ui.login.disabled = true;
    ui.loginChrome.hidden = true;
    ui.loginOther.disabled = true;
    ui.loginLink.hidden = true;
    ui.loginOther.setAttribute('aria-expanded', 'false');
    ui.loginChoiceHint.textContent = 'Menyiapkan link login…';
    try {
      browserLink = await handoff.prepare();
      ui.gameLink.value = browserLink.href;
      ui.loginChrome.href = 'googlechromes:' + browserLink.href.slice('https:'.length);
      ui.loginChrome.hidden = false;
      ui.loginOther.disabled = false;
      ui.loginChoiceHint.textContent = 'Pilih browser untuk login. Setelah selesai, kembali ke ikon Mawa Game.';
    } catch {
      ui.loginChoiceHint.textContent = 'Link browser belum tersedia. Coba lagi atau lanjut di app ini.';
    } finally {
      ui.login.disabled = false;
    }
  });
  ui.loginOther.addEventListener('click', () => {
    ui.loginLink.hidden = !ui.loginLink.hidden;
    ui.loginOther.setAttribute('aria-expanded', String(!ui.loginLink.hidden));
  });
  ui.copyGameLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(browserLink.href);
      ui.copyGameStatus.textContent = 'Link disalin.';
    } catch {
      ui.gameLink.select();
      ui.copyGameStatus.textContent = 'Salin link yang dipilih.';
    }
  });
  ui.loginHere.addEventListener('click', async () => {
    ui.login.disabled = true;
    ui.loginChoice.close();
    status('');
    try {
      const provider = new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await authSdk.signInWithPopup(auth, provider);
      handoff?.cancel();
    } catch (error) {
      console.warn('Login Google:', error);
      const blocked = error.code === 'auth/popup-blocked';
      const closed = error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request';
      status(blocked ? 'Jendela login diblokir. Izinkan pop-up lalu coba lagi.' :
        closed ? 'Login belum selesai. Buka lagi dan pilih akun Google.' : 'Login Google gagal. Coba lagi.');
    } finally {
      ui.login.disabled = false;
    }
  });
  bind(ui.logout, async () => {
    if (session?.connected) {
      await session.party.leave();
      if (session.onlineRef) await remove(session.onlineRef);
    }
    await authSdk.signOut(auth);
  }, 'Gagal keluar. Coba lagi.');
  bind(ui.createParty, () => session?.party.create(), 'Party gagal dibuat.');
  bind(ui.play, () => session?.party.begin(), 'Host belum bisa memulai map.');
  bind(ui.leaveParty, () => session?.party.leave(), 'Gagal keluar dari party.');
  bind(ui.back, () => session?.party.leave(), 'Gagal keluar dari map.');

  authSdk.onAuthStateChanged(auth, user => {
    session?.stop.forEach(stop => stop());
    if (session) closeMap(session);
    session = null;
    for (const list of [ui.account, ui.players, ui.invites, ui.roster]) list.replaceChildren();
    ui.count.textContent = '';
    ui.invitations.hidden = true;
    ui.account.hidden = ui.logout.hidden = !user;
    ui.login.disabled = false;
    if (user && ui.loginChoice.open) ui.loginChoice.close();
    status('');
    ui.loadingText.textContent = 'Menyiapkan koneksi lobby…';
    show(user ? ui.loading : ui.gate);
    if (!user) return;
    const profile = { name: user.displayName || 'Pemain', photo: user.photoURL || '' };
    const active = { user, profile, stop: [], players: {}, connected: false };
    session = active;
    identity(ui.account, profile);
    const lobbyError = error => {
      if (active !== session) return;
      console.error(error);
      status('Lobby belum bisa terhubung. Muat ulang untuk mencoba lagi.');
    };

    active.party = connectParty(data, db, user, profile, {
      change(state) {
        if (active !== session) return;
        active.partyState = state;
        renderLobby(active);
      },
      error: lobbyError
    });
    active.stop.push(() => active.party.dispose());

    active.stop.push(onValue(ref(db, '.info/connected'), async snapshot => {
      if (active !== session) return;
      active.connected = snapshot.val() === true;
      composer(active);
      renderLobby(active);
      if (!active.connected) return;
      const connection = push(ref(db, 'presence/' + user.uid));
      active.onlineRef = connection;
      try {
        await onDisconnect(connection).remove();
        if (active === session && active.onlineRef === connection && active.connected) await set(connection, profile);
      } catch (error) { lobbyError(error); }
    }));

    active.stop.push(onValue(ref(db, 'presence'), snapshot => {
      if (active !== session) return;
      active.players = {};
      snapshot.forEach(player => {
        player.forEach(connection => { active.players[player.key] = connection.val(); });
      });
      active.playersReady = true;
      renderLobby(active);
    }, lobbyError));
  }, error => {
    console.error(error);
    status('Status login gagal diperiksa.');
  });

  ui.composer.addEventListener('submit', async event => {
    event.preventDefault();
    const active = session;
    const messages = active?.messages;
    const draft = ui.message.value;
    const text = draft.trim();
    if (ui.send.disabled || !messages || !text || text.length > 500) return;
    active.sending = true;
    composer(active);
    try {
      await set(push(messages), { uid: active.user.uid, name: active.profile.name, text });
      if (active === session && active.messages === messages && ui.message.value === draft) ui.message.value = '';
    } catch (error) {
      console.error(error);
      if (active === session && active.messages === messages) status('Pesan gagal dikirim.');
    } finally {
      active.sending = false;
      if (active === session) composer(active);
    }
  });
}

start().catch(error => {
  console.error(error);
  status('Game gagal dimuat. Coba muat ulang halaman.');
});
