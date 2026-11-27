'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P4G = require('../app/src/main/assets/www/p4g-core.js');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'db.json'), 'utf8'));
const { OFF, _internal: I } = P4G;

function rnd(n, seed) { let x = seed >>> 0; const b = new Uint8Array(n); for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; b[i] = x >>> 24; } return b; }
function fakeSave() {
  const b = new Uint8Array(30000);
  const dv = new DataView(b.buffer);
  I.writePString(b, OFF.pSurname, 'Narukami'); I.writePString(b, OFF.pFirstname, 'Yu');
  dv.setUint32(OFF.yen, 123456, true);
  b[92] = 2; b[94] = 3; b[96] = 8;
  b[OFF.inventory + 5] = 7; b[OFF.inventory + 1300] = 99;
  I.writePersona(b, OFF.mcPersonas, { exists: true, unknown0: 0, id: 1, level: 50, totalxp: 777777, skills: [1, 2, 3, 4, 5, 6, 7, 8], st: 10, ma: 20, de: 30, ag: 40, lu: 50 });
  I.writePersona(b, OFF.memberBlock + 132 + 8, { exists: true, unknown0: 0, id: 9, level: 22, totalxp: 1000, skills: [9, 0, 0, 0, 0, 0, 0, 0], st: 1, ma: 2, de: 3, ag: 4, lu: 5 });
  dv.setUint16(OFF.mcEquip, 3, true); dv.setUint16(OFF.memberBlock + 132 * 4 + 2, 260, true);
  b[OFF.mcLevel] = 42; dv.setUint32(OFF.mcXp, 99999, true);
  [20, 100, 5, 90, 60].forEach((v, i) => dv.setUint16(OFF.socialStats + i * 2, v, true));
  b[OFF.day] = 10; b[OFF.dayPhase] = 2; b[OFF.nextDay] = 11; b[OFF.nextDayPhase] = 3;
  [[7, 4, 33, 1], [11, 2, 10, 0]].forEach(([id, lv, pr, fl], i) => { const p = OFF.socialLinks + i * 16; b[p] = id; b[p + 2] = lv; b[p + 4] = pr; b[p + 12] = fl; });
  I.writePersona(b, OFF.compendium + 48 * 0, { exists: true, unknown0: 0, id: 1, level: 5, totalxp: 10, skills: [0, 0, 0, 0, 0, 0, 0, 0], st: 1, ma: 1, de: 1, ag: 1, lu: 1 });
  I.writePersona(b, OFF.compendium + 48 * 99, { exists: true, unknown0: 0, id: 100, level: 60, totalxp: 5, skills: [0, 0, 0, 0, 0, 0, 0, 0], st: 9, ma: 9, de: 9, ag: 9, lu: 9 });
  return P4G.serialize(P4G.parse(b), b); // canonical form (also fills the Japanese-style name copy)
}

test('parse reads documented offsets', () => {
  const s = P4G.parse(fakeSave());
  assert.strictEqual(s.surname, 'Narukami'); assert.strictEqual(s.firstname, 'Yu');
  assert.strictEqual(s.yen, 123456); assert.deepStrictEqual(s.party, [2, 3, 8]);
  assert.strictEqual(s.inventory[5], 7); assert.strictEqual(s.inventory[1300], 99);
  assert.strictEqual(s.mcSlots[0].id, 1); assert.strictEqual(s.mcSlots[0].level, 50);
  assert.strictEqual(s.mcSlots[0].totalxp, 777777); assert.deepStrictEqual(s.mcSlots[0].skills, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual([s.mcSlots[0].st, s.mcSlots[0].lu], [10, 50]);
  assert.strictEqual(s.memberPersona[2].id, 9); assert.strictEqual(s.memberPersona[2].level, 22);
  assert.strictEqual(s.equip.weapon[0], 3); assert.strictEqual(s.equip.armor[5], 260);
  assert.strictEqual(s.mcLevel, 42); assert.strictEqual(s.mcXp, 99999);
  assert.deepStrictEqual(s.socialStats, [20, 100, 5, 90, 60]);
  assert.deepStrictEqual([s.day, s.dayPhase, s.nextDay, s.nextDayPhase], [10, 2, 11, 3]);
  assert.deepStrictEqual(s.socialLinks, [{ id: 7, level: 4, progress: 33, flag: 1 }, { id: 11, level: 2, progress: 10, flag: 0 }]);
  assert.deepStrictEqual(s.compendium.map((p) => p.id), [1, 100]);
});

test('serialize(parse(x)) is stable and only touches known regions', () => {
  const orig = fakeSave();
  const out = P4G.serialize(P4G.parse(orig), orig);
  assert.strictEqual(out.length, orig.length);
  assert.deepStrictEqual(Buffer.from(out), Buffer.from(orig));
  // random garbage in unknown areas must survive
  const noisy = rnd(30000, 1); noisy.set(orig.subarray(0, 100), 0);
  const base = P4G.serialize(P4G.parse(fakeSave()), noisy);
  const again = P4G.serialize(P4G.parse(base), base);
  assert.deepStrictEqual(Buffer.from(again), Buffer.from(base));
});

test('edits land in the right place and nothing else changes', () => {
  const orig = fakeSave();
  const s = P4G.parse(orig);
  s.yen = 999999; s.mcSlots[3] = P4G.newPersona(20); s.inventory[44] = 3; s.firstname = 'Rei';
  s.socialLinks.push({ id: 20, level: 1, progress: 0, flag: 0 });
  s.compendium.push(P4G.newPersona(249));
  s.equip.armor[5] = 261;
  const out = P4G.serialize(s, orig);
  const s2 = P4G.parse(out);
  assert.strictEqual(s2.yen, 999999); assert.strictEqual(s2.mcSlots[3].id, 20);
  assert.strictEqual(s2.inventory[44], 3); assert.strictEqual(s2.firstname, 'Rei');
  assert.strictEqual(s2.socialLinks.length, 3); assert.strictEqual(s2.compendium.at(-1).id, 249);
  assert.strictEqual(s2.equip.armor[5], 261);
  const diffs = []; for (let i = 0; i < orig.length; i++) if (orig[i] !== out[i]) diffs.push(i);
  const inRange = (i) => [[16, 52], [88, 92], [118, 136], [OFF.inventory, OFF.inventory + 2559], [OFF.mcPersonas, OFF.mcPersonas + 48 * 12],
    [OFF.memberBlock, OFF.memberBlock + 132 * 7], [OFF.socialLinks, OFF.socialLinks + 368], [OFF.compendium, OFF.compendium + 11937]].some(([a, c]) => i >= a && i < c);
  assert.ok(diffs.every(inRange), 'unexpected diff at ' + diffs.filter((i) => !inRange(i)));
});

test('strings', () => {
  const b = new Uint8Array(64);
  for (const n of ['Yu', 'Narukami', 'ABC xyz!?', 'Zz09']) {
    I.writePString(b, 0, n);
    assert.strictEqual(I.readPString(b, 0), n.replace(/ /g, ''), n); // space (0x20) is < '!' => dropped, same as original
  }
  I.writeJString(b, 20, 'Yu'); assert.strictEqual(b[21], 'Y'.charCodeAt(0) + 0x60); assert.strictEqual(b[20], 0x80); assert.strictEqual(b[24], 0);
});

test('social stat thresholds match original', () => {
  const orig = { 0: [15, 16, 39, 40, 79, 80, 139, 140], 1: [29, 30, 79, 80, 149, 150, 239, 240], 4: [12, 13, 32, 33, 52, 53, 84, 85] };
  orig[2] = orig[3] = orig[0];
  for (const st of [0, 1, 2, 3, 4]) {
    const t = orig[st];
    [[0, 1], [t[0], 1], [t[1], 2], [t[2], 2], [t[3], 3], [t[4], 3], [t[5], 4], [t[6], 4], [t[7], 5], [1000, 5]].forEach(([pts, lv]) => assert.strictEqual(P4G.pointsToLevel(st, pts), lv));
    [t[0], t[1], t[3], t[5], t[7]].forEach((pts, i) => assert.strictEqual(P4G.levelToPoints(st, i + 1), pts));
  }
});

test('xp formula', () => {
  assert.strictEqual(P4G.xpForLevel(1), 0);        // (1+4+53-58)/10
  assert.strictEqual(P4G.xpForLevel(99), Math.trunc((99 ** 4 + 4 * 99 ** 3 + 53 * 99 ** 2 - 58 * 99) / 10));
});

test('catalog is consistent with database', () => {
  const c = P4G.buildCatalog(db);
  assert.strictEqual(c.skills.length, 255 + 42 + 46 + 13 + 151);
  assert.strictEqual(c.personae.length, 1 + 42 + 8 + 127 + 32 + 26);
  assert.strictEqual(c.sections.length, 15);
  assert.ok(c.sections.every((s) => s.items.every((i) => typeof i.name === 'string' && i.id >= 0 && i.id < 2560)));
  assert.ok(c.skills.every((s) => typeof s.name === 'string') && c.personae.every((s) => typeof s.name === 'string'));
  assert.strictEqual(c.weaponsByMember[4], undefined);
  assert.strictEqual(c.socialLinkIDs.length, 35);
  assert.strictEqual(c.socialLinkIDs[3].arcana, 'Lovers');
});

test('rejects tiny files', () => assert.throws(() => P4G.parse(new Uint8Array(100))));

test('md5 matches node crypto (various lengths)', () => {
  const crypto = require('crypto');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 217937]) {
    const d = rnd(n, n + 7);
    assert.strictEqual(Buffer.from(P4G.md5(d)).toString('hex'), crypto.createHash('md5').update(d).digest('hex'), 'len ' + n);
  }
});

test('patchBinslot updates md5 and Lv text only', () => {
  const crypto = require('crypto');
  const bin = fakeSave(); bin[OFF.mcLevel] = 57;
  const slot = new Uint8Array(884);
  slot.set(Buffer.from('SAVE0001')); slot.set(rnd(16, 4), 24);
  slot.set(Buffer.from('Yu Narukami Lv:1'), 44); slot.set(Buffer.from('04/10:Noche:RESERVE'), 108);
  const out = P4G.patchBinslot(slot, bin);
  assert.strictEqual(Buffer.from(out.subarray(24, 40)).toString('hex'), crypto.createHash('md5').update(bin).digest('hex'));
  assert.strictEqual(Buffer.from(out.subarray(44, 70)).toString().replace(/\0+$/, ''), 'Yu Narukami Lv:57');
  assert.deepStrictEqual(Buffer.from(out.subarray(108)), Buffer.from(slot.subarray(108)));
  // second MD5 over the slot data (offset 8) must follow the changed title
  const tail = Buffer.concat([Buffer.from(out.subarray(0x28)), Buffer.from('P4GOLDEN')]);
  assert.strictEqual(Buffer.from(out.subarray(8, 24)).toString('hex'), crypto.createHash('md5').update(tail).digest('hex'));
  assert.throws(() => P4G.patchBinslot(new Uint8Array(100), bin));
});

test('i18n: both languages have identical keys/placeholders and app.js only uses existing keys', () => {
  const win = {}; new Function('window', fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/i18n.js'), 'utf8'))(win);
  const { id, en } = win.P4G_I18N;
  assert.deepStrictEqual(Object.keys(id).sort(), Object.keys(en).sort());
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(id)) assert.strictEqual(ph(id[k]), ph(en[k]), 'placeholders differ: ' + k);
  const app = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/app.js'), 'utf8');
  const used = new Set([...app.matchAll(/\bt\('([a-z_0-9]+)'[,)]/g)].map((m) => m[1]));
  ['tab_stats', 'tab_inv', 'tab_social', 'tab_comp', 'tab_other'].forEach((k) => used.add(k)); // used via TABS
  for (const k of used) assert.ok(k in en, 'missing i18n key: ' + k);
  // error codes thrown by the core / sent by Kotlin need an err_* text
  for (const c of ['too_small', 'not_binslot', 'open_fail', 'save_fail', 'slot_save_fail', 'slot_not_saved', 'invalid_data', 'perm_denied', 'scan_fail']) assert.ok(('err_' + c) in en, c);
});
