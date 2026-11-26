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

Tambahan di versi Android: buka/simpan lewat file picker sistem, **cadangan otomatis** file asli sebelum ditimpa
(`Android/data/app.p4gsavetool/files/backups/`), dan konfirmasi saat keluar bila ada perubahan belum disimpan.

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
