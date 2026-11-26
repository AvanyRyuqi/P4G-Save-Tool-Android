#!/usr/bin/env python3
"""Perbaiki file .binslot (save P4G Switch) setelah data0001.bin diedit.

Pemakaian:  python fix_binslot.py data0001.bin data0001.binslot [output.binslot]

Yang dilakukan:
  1. Mengganti MD5 di offset 24 (checksum isi .bin) dengan MD5 .bin yang baru.
  2. Memperbarui teks judul slot "... Lv:N" sesuai level protagonist di .bin.
File .binslot asli dicadangkan sebagai <nama>.orig bila output = file yang sama.
"""
import hashlib, sys, shutil, re

MD5_OFF, TITLE_OFF, LEVEL_OFF = 24, 44, 3290

def fix(bin_bytes: bytes, slot: bytes) -> bytes:
    if slot[:8] != b'SAVE0001' or len(slot) < 64:
        raise SystemExit('Bukan file .binslot P4G (magic SAVE0001 tidak ditemukan).')
    slot = bytearray(slot)
    slot[MD5_OFF:MD5_OFF + 16] = hashlib.md5(bin_bytes).digest()
    if len(bin_bytes) > LEVEL_OFF:
        end = slot.index(b'\0', TITLE_OFF) if b'\0' in slot[TITLE_OFF:] else len(slot)
        m = re.search(rb' Lv:\d+$', bytes(slot[TITLE_OFF:end]))
        if m:
            new = b' Lv:%d' % bin_bytes[LEVEL_OFF]
            start = TITLE_OFF + m.start()
            gap = end - start                      # bytes currently used by " Lv:N"
            nxt = end
            while nxt < len(slot) and slot[nxt] == 0 and nxt - start < 16: nxt += 1
            if len(new) <= nxt - start:
                slot[start:nxt] = new + b'\0' * (nxt - start - len(new))
    return bytes(slot)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    bin_path, slot_path = sys.argv[1], sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else slot_path
    data = open(bin_path, 'rb').read(); slot = open(slot_path, 'rb').read()
    if out_path == slot_path: shutil.copyfile(slot_path, slot_path + '.orig')
    open(out_path, 'wb').write(fix(data, slot))
    print('OK  MD5 =', hashlib.md5(data).hexdigest(), '->', out_path)
