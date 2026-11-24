import { firebaseConfig } from './config.mjs';
import { seal } from './login-crypto.mjs';

const message = document.querySelector('#message');
const button = document.querySelector('#google');
const fragment = new URLSearchParams(location.hash.slice(1));
const session = fragment.get('session');
const key = fragment.get('key');
history.replaceState(null, '', location.pathname);
const validCode = value => /^[A-Za-z0-9_-]{43}$/.test(value ?? '');

async function initialize() {
  if (!validCode(session) || !validCode(key)) {
    message.textContent = 'Buka halaman ini dari pilihan login Mawa Game.';
    return;
  }

  const sdk = 'https://www.gstatic.com/firebasejs/12.5.0';
  const [core, authSdk, data] = await Promise.all([
    import(sdk + '/firebase-app.js'),
    import(sdk + '/firebase-auth.js'),
    import(sdk + '/firebase-database.js'),
  ]);
  const app = core.initializeApp(firebaseConfig, 'mawa-login-hook');
  const auth = authSdk.initializeAuth(app, {
    persistence: authSdk.inMemoryPersistence,
    popupRedirectResolver: authSdk.browserPopupRedirectResolver,
  });
  const target = data.ref(data.getDatabase(app), 'loginHandoffs/' + session + '/payload');
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const provider = new authSdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const result = await authSdk.signInWithPopup(auth, provider);
      const credential = authSdk.GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.idToken || credential?.accessToken;
      if (!token) throw Error('Google credential unavailable');
      const encrypted = await seal(key, session, {
        token,
        type: credential.idToken ? 'id' : 'access',
      });
      await data.set(target, encrypted);
      message.textContent = 'Login berhasil. Kembali ke ikon Mawa Game di layar utama.';
      button.hidden = true;
    } catch {
      message.textContent = 'Login belum selesai. Jika link kedaluwarsa, buat link baru dari Mawa Game.';
      button.disabled = false;
    } finally {
      await authSdk.signOut(auth).catch(() => {});
    }
  });
}

initialize().catch(() => {
  message.textContent = 'Halaman login gagal dimuat. Buka ulang dari Mawa Game.';
});
