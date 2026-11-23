import { firebaseConfig } from './config.mjs';

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

  function composer(active) {
    ui.send.disabled = !active?.connected || !active.chatReady || active.sending === true;
  }

  function closeMap(active) {
    active.stopChat?.();
    active.stopChat = null;
    active.messages = null;
    active.chatReady = false;
    ui.messages.replaceChildren();
    ui.message.value = '';
    composer(active);
  }

  function hostedMap(active) {
    if (!active.hostedMap) {
      const key = push(ref(db, 'maps')).key;
      active.hostedMap = set(ref(db, 'maps/' + key + '/meta'), {
        host: active.user.uid, name: active.profile.name
      }).then(() => key).catch(error => {
        active.hostedMap = null;
        throw error;
      });
    }
    return active.hostedMap;
  }

  async function openMap(active, key) {
    const meta = await get(ref(db, 'maps/' + key + '/meta'));
    if (active !== session) return;
    if (!meta.exists()) throw new Error('Map not found');
    closeMap(active);
    status('');
    show(ui.world);
    const messages = ref(db, 'maps/' + key + '/messages');
    active.messages = messages;
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
      composer(active);
    }, error => {
      if (active !== session || active.messages !== messages) return;
      console.error(error);
      active.chatReady = false;
      composer(active);
      status('Chat grup gagal dimuat.');
    });
  }

  bind(ui.login, () => authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider()), 'Login Google gagal. Coba lagi.');
  bind(ui.logout, async () => {
    if (session?.onlineRef && session.connected) await remove(session.onlineRef);
    await authSdk.signOut(auth);
  }, 'Gagal keluar. Coba lagi.');
  bind(ui.play, async () => {
    const active = session;
    if (active) await openMap(active, await hostedMap(active));
  }, 'Map belum bisa dibuka.');
  ui.back.addEventListener('click', () => {
    if (!session) return;
    closeMap(session);
    show(ui.menu);
    status('');
  });

  authSdk.onAuthStateChanged(auth, user => {
    session?.stop.forEach(stop => stop());
    if (session) closeMap(session);
    session = null;
    for (const list of [ui.account, ui.players, ui.invites]) list.replaceChildren();
    ui.count.textContent = '';
    ui.invitations.hidden = true;
    ui.account.hidden = ui.logout.hidden = !user;
    ui.login.disabled = false;
    status('');
    show(user ? ui.loading : ui.gate);
    if (!user) return;
    const profile = { name: user.displayName || 'Pemain', photo: user.photoURL || '' };
    const active = { user, profile, stop: [], connected: false };
    session = active;
    identity(ui.account, profile);
    const lobbyError = error => {
      if (active !== session) return;
      console.error(error);
      status('Lobby belum bisa terhubung. Muat ulang untuk mencoba lagi.');
    };

    active.stop.push(onValue(ref(db, '.info/connected'), async snapshot => {
      if (active !== session) return;
      active.connected = snapshot.val() === true;
      composer(active);
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
      const rows = [];
      snapshot.forEach(player => {
        let online;
        player.forEach(connection => { online = connection.val(); });
        if (!online) return;
        const row = document.createElement('li');
        row.className = 'player';
        identity(row, online);
        if (player.key !== user.uid) {
          row.append(button('Undang', async () => {
            const key = await hostedMap(active);
            if (active !== session) return;
            await set(ref(db, 'invites/' + player.key + '/' + key), { from: user.uid });
            status('Undangan dikirim ke ' + online.name + '. Pilih Buka Map untuk bergabung.');
          }, 'Undangan gagal dikirim.'));
        }
        rows.push(row);
      });
      ui.count.textContent = '(' + rows.length + ')';
      ui.players.replaceChildren(...rows);
      if (!ui.loading.hidden) show(ui.menu);
    }, lobbyError));

    active.stop.push(onValue(ref(db, 'invites/' + user.uid), snapshot => {
      if (active !== session) return;
      const rows = [];
      snapshot.forEach(invitation => {
        const row = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = 'Undangan map';
        row.className = 'player';
        row.append(label, button('Gabung', () => openMap(active, invitation.key), 'Map undangan belum bisa dibuka.'));
        rows.push(row);
        void get(ref(db, 'maps/' + invitation.key + '/meta')).then(meta => {
          if (meta.exists()) label.textContent = meta.val().name;
        }).catch(console.error);
      });
      ui.invites.replaceChildren(...rows);
      ui.invitations.hidden = !rows.length;
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
