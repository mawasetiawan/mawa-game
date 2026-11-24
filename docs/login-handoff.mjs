import { randomCode, unseal } from './login-crypto.mjs';

const storageKey = 'mawa.loginHandoff.v1';
const lifetime = 5 * 60_000;

export function createLoginHandoff({ initializeApp, config, authSdk, data, auth, report }) {
  let client;
  let pending;

  function connect() {
    if (!client) {
      client = (async () => {
        const app = initializeApp(config, 'mawa-login-reader');
        const reader = authSdk.getAuth(app);
        await reader.authStateReady();
        const user = reader.currentUser ?? (await authSdk.signInAnonymously(reader)).user;
        if (!user.isAnonymous) throw Error('Unexpected relay identity');
        return { user, database: data.getDatabase(app) };
      })().catch(error => {
        client = null;
        throw error;
      });
    }
    return client;
  }

  function watch(target, request) {
    pending?.stop();
    let active = true;
    let unsubscribe;
    const timer = setTimeout(() => {
      finish();
      report('Link login kedaluwarsa. Buka pilihan login untuk membuat link baru.');
    }, Math.max(0, request.until - Date.now()));
    function stop() {
      active = false;
      clearTimeout(timer);
      unsubscribe?.();
    }
    function finish() {
      stop();
      if (pending?.stop === stop) pending = null;
      localStorage.removeItem(storageKey);
      void data.remove(target).catch(() => {});
    }
    pending = { stop, finish };
    unsubscribe = data.onValue(target, async snapshot => {
      const payload = snapshot.val()?.payload;
      if (!active || !payload) return;
      stop();
      try {
        const { token, type } = await unseal(request.key, request.session, payload);
        if (!auth.currentUser) {
          const credential = authSdk.GoogleAuthProvider.credential(
            type === 'id' ? token : null,
            type === 'access' ? token : null,
          );
          await authSdk.signInWithCredential(auth, credential);
        }
      } catch {
        report('Hasil login tidak bisa dipakai. Buat link baru dan coba lagi.');
      } finally {
        finish();
      }
    }, () => {
      if (!active) return;
      finish();
      report('Permintaan login sudah tidak tersedia. Buat link baru dari Mawa Game.');
    });
  }

  function linkFor(request) {
    const url = new URL('./login-hook.html', location.href);
    url.hash = new URLSearchParams({ session: request.session, key: request.key }).toString();
    return url;
  }

  return {
    async prepare() {
      const { user, database } = await connect();
      pending?.finish();
      const request = { session: randomCode(), key: randomCode(), until: Date.now() + lifetime };
      const target = data.ref(database, 'loginHandoffs/' + request.session);
      await data.set(target, { owner: user.uid, expires: request.until });
      localStorage.setItem(storageKey, JSON.stringify(request));
      watch(target, request);
      return linkFor(request);
    },
    async resume() {
      const request = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (!request || auth.currentUser) return;
      if (request.until <= Date.now()) {
        localStorage.removeItem(storageKey);
        return;
      }
      const { database } = await connect();
      if (!pending && !auth.currentUser) {
        watch(data.ref(database, 'loginHandoffs/' + request.session), request);
      }
    },
    cancel() {
      pending?.finish();
    },
  };
}
