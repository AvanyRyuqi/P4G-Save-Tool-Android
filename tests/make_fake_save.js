// Generates a synthetic (NOT real) save file for UI testing: node tests/make_fake_save.js out.bin
const fs = require('fs');
const P4G = require('../app/src/main/assets/www/p4g-core.js');
const { OFF, _internal: I } = P4G;
const b = new Uint8Array(30000);
const dv = new DataView(b.buffer);
I.writePString(b, OFF.pSurname, 'Narukami'); I.writePString(b, OFF.pFirstname, 'Yu');
dv.setUint32(OFF.yen, 123456, true); b[92] = 2; b[94] = 3; b[96] = 8;
[[5, 7], [1300, 99], [770, 3], [1540, 2], [20, 1], [260, 1]].forEach(([i, v]) => { b[OFF.inventory + i] = v; });
const mk = (id, lv, sk) => ({ exists: true, unknown0: 0, id, level: lv, totalxp: lv * 1000, skills: sk, st: 20, ma: 30, de: 25, ag: 22, lu: 18 });
for (let i = 0; i < 4; i++) I.writePersona(b, OFF.mcPersonas + i * 48, mk(i + 1, 10 + i * 5, [1, 2, 3, 4, 5, 6, 7, 8]));
for (let m = 1; m < 8; m++) I.writePersona(b, OFF.memberBlock + (m - 1) * 132 + 8, mk(20 + m, 20 + m, [9, 10, 0, 0, 0, 0, 0, 0]));
dv.setUint16(OFF.mcEquip, 3, true);
b[OFF.mcLevel] = 42; dv.setUint32(OFF.mcXp, 99999, true);
[20, 100, 5, 90, 60].forEach((v, i) => dv.setUint16(OFF.socialStats + i * 2, v, true));
b[OFF.day] = 10; b[OFF.dayPhase] = 2; b[OFF.nextDay] = 11; b[OFF.nextDayPhase] = 3;
[[7, 4, 33], [11, 2, 10], [20, 1, 0]].forEach(([id, lv, pr], i) => { const p = OFF.socialLinks + i * 16; b[p] = id; b[p + 2] = lv; b[p + 4] = pr; });
[1, 2, 3, 100, 150, 249].forEach((id) => I.writePersona(b, OFF.compendium + 48 * (id - 1), mk(id, 30, [1, 2, 0, 0, 0, 0, 0, 0])));
fs.writeFileSync(process.argv[2] || 'fake.bin', P4G.serialize(P4G.parse(b), b));
