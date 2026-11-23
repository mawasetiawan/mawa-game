import { defaults, parseSettings, DEVELOPER_EMAIL, mountDeveloperPanel } from './game-settings.mjs?v=1';
import { firebaseConfig } from './config.mjs';
import { connectMapReplication } from './map-replication.mjs?v=1';
import { connectParty } from './party.mjs?v=1';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
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
  const settingsRef = ref(db, 'gameSettings');
  fetch('./settings.json?v=1').then(response => {
    if (!response.ok) throw Error('Settings snapshot unavailable');
    return response.json();
  }).then(snapshot => {
    if (!liveSettings) Object.assign(settings, parseSettings(snapshot));
  }).catch(error => console.warn(error));
  let liveSettings = false;
  onValue(settingsRef, snapshot => {
    if (!snapshot.exists()) return;
    liveSettings = true;
    Object.assign(settings, parseSettings(snapshot.val()));
  }, error => console.error('Settings read:', error));

  function composer(active) {
    ui.send.disabled = !active?.connected || !active.chatReady || active.sending === true;
  }

  function closeMap(active) {
    active.exploration?.abort();
    active.exploration = null;
    ui.mapError.hidden = true;
    active.stopChat?.();
    active.stopChat = null;
    active.messages = null;
    active.chatReady = false;
    ui.messages.replaceChildren();
    ui.message.value = '';
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
    if (active.user.emailVerified && active.user.email === DEVELOPER_EMAIL) {
      mountDeveloperPanel(ui.world, next => set(settingsRef, next), settings, exploration.signal);
    }
    import('./explore.mjs?v=3').then(({ mountExploration }) => {
      if (exploration.signal.aborted) return;
      const replication = connectMapReplication(data, db, key, active.user.uid, exploration.signal);
      return mountExploration(ui.world, exploration.signal, replication, settings);
    }).catch(error => {
      if (exploration.signal.aborted) return;
      exploration.abort();
      console.error(error);
      ui.mapError.textContent = 'Map 3D gagal dimuat.';
      ui.mapError.hidden = false;
    });
    active.stopChat = onValue(query(messages, orderByKey(), limitToLast(100)), snapshot => {
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
      ui.messages.replaceChildren(...rows);
      if (nearBottom) ui.messages.scrollTop = ui.messages.scrollHeight;
      active.chatReady = true;
      show(ui.world);
      composer(active);
    }, error => {
      if (active !== session || active.messages !== messages) return;
      console.error(error);
      active.chatReady = false;
      composer(active);
      show(ui.world);
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

  bind(ui.login, () => authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider()), 'Login Google gagal. Coba lagi.');
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
