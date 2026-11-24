# Lobby Game

Prototipe browser dengan login Google dan satu Ruang umum. Semua pemain mendapat akses Anggota yang sama. Riwayat menampilkan maksimal 100 pesan terakhir. Email akun tidak disimpan di chat.

## Firebase

1. Buat project Firebase dan daftarkan Web App.
2. Di **Authentication → Sign-in method**, aktifkan **Google** dan pilih email dukungan.
3. Di **Realtime Database**, buat database dalam mode terkunci. Buka tab **Rules**, salin isi `database.rules.json`, lalu klik **Publish**.
4. Salin konfigurasi Web App ke `docs/config.mjs` dan isi `databaseURL` dengan URL Realtime Database. Gunakan konfigurasi klien dari Web App.
5. Di **Authentication → Settings → Authorized domains**, tambahkan hostname GitHub Pages, misalnya `mawasetiawan.github.io`. Tambahkan `localhost` jika akan menguji secara lokal.

## GitHub Pages

Unggah isi folder ini ke repo baru. Buka **Settings → Pages → Deploy from a branch**, lalu pilih **main /docs** dan klik **Save**. Setelah penerbitan berhasil, bagikan URL GitHub Pages yang muncul di pengaturan tersebut.

## Uji dua akun

1. Buka URL di dua profil browser dengan akun Google berbeda. Kedua akun akan melihat label Anggota dan masuk ke Ruang umum.
2. Kirim pesan dari masing-masing akun dan pastikan keduanya melihat pesan secara langsung.
3. Muat ulang halaman untuk memeriksa riwayat. Klik Keluar dan pastikan halaman meminta login lagi.

## Camera cue architecture

Use the active map element as the event target. These cues are client-side and work with every camera mode. No gameplay event is wired by default.

```js
import { triggerCameraCue } from './camera-cues.mjs';
triggerCameraCue(world, 'shake', { amplitude: 0.16, frequency: 11, duration: 0.35, decay: 3 });
triggerCameraCue(world, 'fade', {
  color: '#000000', opacity: 1, fadeOut: 0.25, hold: 0.15, fadeIn: 0.35, includeHud: false
});
```

A gameplay module can also dispatch `mawa:camera-shake` or `mawa:camera-fade` with the equivalent options in `CustomEvent.detail`. Fade times are seconds. Shake amplitude is in map units and frequency is in hertz. Multiple shakes blend; a new fade starts from the current opacity. The developer panel can preview both cues without a gameplay trigger. Its Apply Default button updates client-side defaults for the current page session; explicit event options take precedence.
