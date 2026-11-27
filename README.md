# P4G Save Tool for Android

Port Android dari [P4G Save Tool](https://github.com/Fennec-kun/P4G-Save-Tool) (WPF/C#, oleh Jack P. Fenech / Fennec-kun, lisensi MIT).
Edit file save **Persona 4 Golden** (`.bin`, hasil dump dari PS Vita) langsung dari ponsel.

## Fitur (sama dengan versi desktop)

| Tab | Isi |
|---|---|
| Stats | Yen, level & XP protagonist, 12 slot persona protagonist + persona tiap party member (level, XP, ST/MA/DE/AG/LU, 8 skill), equipment (weapon/armor/accessory/costume), social stats, party configuration |
| Inventory | Semua kategori item (Weapons, Armor, Accessories, Consumables, Materials, Skill Cards, Books, Veggies, Minerals, Social Link, Shelf, Costumes, Bugs, Fish) dengan jumlah per item |
| Social | Tambah/hapus social link, level, progress (maks. 23) |
| Compendium | Tambah/hapus persona, edit level/stat/XP/skill |
| Lainnya | Day, Phase, Next Day, Next Phase, nama protagonist |

Tambahan di versi Android: **pilihan bahasa Indonesia / English** (menu ⋮ ▸ Bahasa / Language, tersimpan di perangkat), pencarian di semua daftar pilihan, buka/simpan lewat file picker sistem, **cadangan otomatis** file asli sebelum ditimpa
(`Android/data/app.p4gsavetool/files/backups/`), dan konfirmasi saat keluar bila ada perubahan belum disimpan.

## Baca folder save langsung

Di layar awal tekan **Buka folder save**. Aplikasi mencari `data*.bin` (beserta `.binslot`) di folder
`/storage/emulated/0/persona 4 golden/user/save` (sampai 6 tingkat subfolder, huruf besar/kecil tidak dipermasalahkan) dan
menampilkan daftar slot dengan nama karakter, level, tanggal game, ukuran, dan waktu ubah. Ketuk slot untuk membukanya;
**Simpan** menulis langsung ke file itu.

* Pertama kali, Android meminta izin **Akses semua file** (layar pengaturan terbuka otomatis; aktifkan lalu kembali ke aplikasi).
* Lokasi folder bisa diubah lewat **Ubah folder** dan diingat. Kalau folder tidak ketemu, kamu bisa mengetik path lain
  atau memakai **Pilih file manual**.
* Cadangan file asli dibuat otomatis sebelum menimpa (`Android/data/app.p4gsavetool/files/backups/`).

## Update tanpa hapus aplikasi

Setiap push ke `main` menjalankan GitHub Actions yang membuat APK dan menerbitkannya di **Releases**
(`P4G-Save-Tool.apk`). Dari ponsel: buka halaman Releases repo ini, unduh APK terbaru, lalu pasang. Android memperlakukannya
sebagai **update** (data dan pengaturan bahasa tetap) karena:

* APK selalu ditandatangani dengan kunci tetap `app/p4g-sideload.keystore`, dan
* `versionCode` naik otomatis (100 + nomor run Actions).

Catatan keamanan: kunci tersebut publik (ada di repo) dan hanya untuk pemakaian pribadi. Untuk dipublikasikan di Play Store,
buat keystore privat sendiri dan simpan sebagai GitHub Secret.
APK yang dibuat *sebelum* kunci tetap ini ada memakai kunci acak, jadi pemasangan pertama dengan kunci tetap
masih perlu menghapus versi lama satu kali.

## Save Nintendo Switch

Save Switch terdiri dari `data0001.bin` **dan** `data0001.binslot`. Di `.binslot` (offset 24) tersimpan MD5 dari `.bin`;
bila tidak cocok setelah diedit, game menolak save-nya. Format `.bin` sendiri sama dengan Vita.

* **Di aplikasi:** saat **Buka**, pilih `data0001.bin` dan `data0001.binslot` sekaligus. Saat **Simpan**, keduanya ditulis,
  MD5 dan teks `Lv:N` di judul slot diperbarui otomatis, dan cadangan keduanya dibuat.
* **Tanpa aplikasi:** `python tools/fix_binslot.py data0001.bin data0001.binslot`.
* 16 byte di offset 8-24 `.binslot` tidak diketahui fungsinya dan dibiarkan apa adanya.
  Fitur ini belum diuji langsung di konsol Switch; laporkan lewat Issues bila save tetap ditolak.

## Arsitektur

```
app/src/main/
  assets/www/
    p4g-core.js   <- port logika baca/tulis save (offset persis dari MainWindow.xaml.cs)
    db.js         <- database nama item/skill/persona (diekstrak dari Database di C#)
    app.js, style.css, index.html  <- UI mobile
    i18n.js       <- teks UI Indonesia & English (tambah bahasa baru di sini)
  java/app/p4gsavetool/MainActivity.kt  <- WebView + file picker (SAF) + backup
tests/core.test.js <- tes logika dengan Node (tanpa Android)
tools/fix_binslot.py <- perbaiki .binslot Switch dari command line
```

Logika save sengaja ditulis sebagai JavaScript murni agar bisa dites tanpa emulator (`npm test`).

## Build

**Android Studio**: File ▸ Open folder ini ▸ Run (butuh JDK 17 dan Android SDK 34).

**Command line**
```
./gradlew assembleDebug
# hasil: app/build/outputs/apk/debug/app-debug.apk
```

**GitHub Actions**: push folder ini ke GitHub; workflow `.github/workflows/build-apk.yml` menjalankan tes lalu membuat
APK debug yang bisa diunduh dari tab *Actions ▸ Artifacts*.

APK debug sudah ditandatangani dengan debug key dan bisa langsung dipasang (aktifkan "install dari sumber tidak dikenal").
Untuk rilis ke Play Store, buat keystore sendiri dan tambahkan `signingConfigs`.

## Perbedaan dari versi desktop (perbaikan bug)

Semua offset dan format data identik dengan aslinya. Beberapa perilaku yang berisiko merusak save diperbaiki:

1. **Equipment Kanji/Naoto/Teddie**: versi asli menulis armor/accessory/costume memakai indeks daftar (bukan ID karakter)
   sehingga masuk ke slot yang salah. Di sini selalu memakai ID karakter yang benar.
2. **Skill di luar daftar** (ID yang tidak ada di dropdown) di versi asli diubah menjadi Blank saat dibuka lalu disimpan.
   Di sini ID aslinya dipertahankan dan ditampilkan sebagai `Unknown (id)`.
3. **Item inventory tanpa nama** (ID bernama "Blank") di versi asli terhapus saat simpan. Di sini nilainya dipertahankan.
4. **Social stats**: versi asli menimpa poin mentah dengan batas bawah level saat file dibuka. Di sini poin hanya berubah
   bila kamu mengganti level-nya.
5. Persona/party member dengan ID di luar daftar tidak lagi membuat pilihan dropdown "nyangkut" ke nilai sebelumnya.

## Catatan

* Selalu simpan salinan file save aslimu. Aplikasi ini mengubah byte save secara langsung.
* Level > 99 diberi tanda merah; game bisa crash atau berperilaku aneh dengan nilai di luar batas normal.
* File harus berukuran minimal 21.625 byte (ukuran area compendium). File lain ditolak.

## Kredit

P4G Save Tool asli: Fennec-kun dengan bantuan TGE, Shrinefox, dan Pan dari [Amicitia](http://s15.zetaboards.com/Amicitia/index/).
Dimungkinkan oleh [HENkaku](https://henkaku.xyz). Lisensi MIT, lihat `LICENSE.txt`.

### Update: manual level entry
Level (protagonist and every Persona) and ST/MA/DE/AG/LU now have a numeric box next to the slider — type the number directly (values clamp to the valid range). Hero name fields only accept printable ASCII, as the game requires.

### Update: more tools
- **Review before saving** – lists every change (old → new) and warns about risky values (level > 99, items > 99, Yen > 9,999,999, duplicate party members…).
- **Undo / Redo / Discard changes** (⋮ menu).
- **Quick presets** – max Yen, protagonist Lv 99, max social stats, all social links Lv 10, all owned items ×99, add a whole item section ×99.
- **Backups** (⋮ menu) – browse the automatic backups of the open save and load one back into the editor.
- **Persona tools** – copy a Persona to another slot/party member, clear skills, text export/import of a build.
- **Compendium → Fill all** at a chosen level (new entries have empty skills/minimal stats).
- **Auto XP sync** (optional), **light/dark/system theme** and **text size** under ⋮ → Display & settings.
- The top bar shows whether a Switch `.binslot` is paired.

Not included: Steam/PC save support (format not verified).

### Update: safety & search
- **Draft autosave** – unsaved edits are kept and offered back on the start screen after the app was closed.
- **Verified saves** – `.binslot` checksums are checked before writing, and the written files are read back and compared (an error is shown instead of a false "saved").
- **Backup manager** – lock / delete backups; the newest 40 unlocked backups are kept automatically.
- **Search save** (⋮) – items, Personas, skills held by Personas, social links; tap a result to jump to it.
- **Compare with another save**, **Save summary**, **Share** (.bin/.binslot/Persona text) and **saved Persona builds**.

Not included (needs data/samples I do not have): default skills per Persona, fusion helper, story-flag editor, Steam/PC saves.
