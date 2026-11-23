import { firebaseConfig } from './config.mjs';

const ui = Object.fromEntries(
  ['gate', 'room', 'login', 'logout', 'member', 'messages', 'composer', 'message', 'send', 'status']
    .map(id => [id, document.getElementById(id)])
);

try {
  if (Object.values(firebaseConfig).some(value => !value)) {
    ui.status.textContent = 'Lobby belum terhubung. Pemilik perlu mengisi konfigurasi Firebase.';
  } else {
    await start();
  }
} catch (error) {
  console.error(error);
  ui.status.textContent = 'Lobby gagal dimuat. Muat ulang halaman untuk mencoba lagi.';
}

async function start() {
  const [{ initializeApp }, authSdk, dbSdk] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.5.0/firebase-database.js')
  ]);
  const app = initializeApp(firebaseConfig);
  const auth = authSdk.getAuth(app);
  const db = dbSdk.getDatabase(app);
  const messages = dbSdk.ref(db, 'rooms/general/messages');
  const recentMessages = dbSdk.query(messages, dbSdk.orderByKey(), dbSdk.limitToLast(100));
  let stopMessages;
  let stopConnection;
  let session;
  let connected = false;
  let ready = false;
  let sending = false;

  function updateComposer() {
    ui.send.disabled = !session || !connected || !ready || sending;
  }

  authSdk.onAuthStateChanged(auth, user => {
    stopMessages?.();
    stopConnection?.();
    session = user;
    connected = false;
    ready = false;
    sending = false;
    updateComposer();
    ui.gate.hidden = Boolean(user);
    ui.room.hidden = !user;
    ui.logout.hidden = !user;
    ui.login.disabled = false;
    ui.messages.replaceChildren();
    ui.message.value = '';
    ui.status.textContent = '';
    if (!user) return;

    ui.member.textContent = `${user.displayName || 'Pemain'} · Anggota`;
    ui.status.textContent = 'Menyambungkan chat…';
    stopConnection = dbSdk.onValue(dbSdk.ref(db, '.info/connected'), snapshot => {
      if (session !== user) return;
      connected = snapshot.val() === true;
      if (!connected) ui.status.textContent = 'Menunggu koneksi chat…';
      else if (ready) ui.status.textContent = '';
      updateComposer();
    });
    stopMessages = dbSdk.onValue(recentMessages, snapshot => {
      if (session !== user) return;
      const list = ui.messages;
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      const existing = new Map(Array.from(list.children, item => [item.dataset.key, item]));
      let previous = null;
      snapshot.forEach(child => {
        const existingItem = existing.get(child.key);
        if (existingItem) {
          existing.delete(child.key);
          previous = existingItem;
          return;
        }
        const message = child.val();
        const item = document.createElement('li');
        const name = document.createElement('strong');
        const body = document.createElement('p');
        item.dataset.key = child.key;
        name.textContent = message.name + (message.uid === user.uid ? ' (kamu)' : '');
        body.textContent = message.text;
        item.append(name, body);
        list.insertBefore(item, previous ? previous.nextSibling : list.firstChild);
        previous = item;
      });
      for (const item of existing.values()) item.remove();
      if (nearBottom) list.scrollTop = list.scrollHeight;
      if (!ready && connected) ui.status.textContent = '';
      ready = true;
      updateComposer();
    }, () => {
      if (session !== user) return;
      ready = false;
      updateComposer();
      ui.status.textContent = 'Chat tidak dapat dibuka. Coba masuk ulang.';
    });
  });

  ui.login.addEventListener('click', async () => {
    ui.login.disabled = true;
    ui.status.textContent = '';
    try {
      await authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      ui.status.textContent = 'Login Google gagal. Izinkan pop-up dan coba lagi.';
    } finally {
      ui.login.disabled = false;
    }
  });

  ui.logout.addEventListener('click', async () => {
    try {
      await authSdk.signOut(auth);
    } catch (error) {
      console.error(error);
      ui.status.textContent = 'Gagal keluar. Coba lagi.';
    }
  });

  ui.composer.addEventListener('submit', async event => {
    event.preventDefault();
    const user = session;
    const draft = ui.message.value;
    const text = draft.trim();
    if (ui.send.disabled || !user || !text || text.length > 500) return;
    sending = true;
    updateComposer();
    ui.status.textContent = 'Mengirim…';
    try {
      await dbSdk.set(dbSdk.push(messages), {
        uid: user.uid,
        name: user.displayName || 'Pemain',
        text
      });
      if (session !== user) return;
      if (ui.message.value === draft) ui.message.value = '';
      ui.status.textContent = '';
    } catch (error) {
      console.error(error);
      if (session === user) ui.status.textContent = 'Pesan gagal dikirim. Coba lagi.';
    } finally {
      if (session === user) {
        sending = false;
        updateComposer();
      }
    }
  });
}
