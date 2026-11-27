/*
 * P4G Save Tool - core (parse / serialize / catalog)
 *
 * JavaScript port of the save-file logic from the original WPF "P4G Save Tool"
 * by Jack P. Fenech (Fennec-kun), MIT licensed. All byte offsets below come
 * from MainWindow.xaml.cs (OpenFile / SaveFile).
 *
 * Runs unchanged in the Android WebView and in Node (see /tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P4G = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- layout
  const OFF = {
    jSurname: 16,        // 9 x uint16 (Japanese-style string, written only)
    jFirstname: 34,
    yen: 88,             // uint32 LE
    party: 92,           // 3 bytes, stride 2
    pSurname: 100,       // 9 x uint16 BE (the "real" name that is read back)
    pFirstname: 118,
    inventory: 136,      // 2559 bytes, one counter per item id
    mcPersonas: 2700,    // 12 personas, stride 48
    mcLevel: 3290,
    socialStats: 3336,   // 5 x uint16 LE
    mcXp: 3348,          // uint32 LE
    mcEquip: 3360,       // weapon, armor, accessory, costume (uint16 each)
    memberBlock: 3492,   // 7 members, stride 132
    day: 6484, dayPhase: 6486,
    nextDay: 6492, nextDayPhase: 6494,
    socialLinks: 6512,   // 23 records, stride 16
    compendium: 9688,    // 249 records, stride 48, record index = persona id - 1
  };
  const INVENTORY_SIZE = 2559;
  const PERSONA_SIZE = 33;
  const COMPENDIUM_COUNT = 249;
  const COMPENDIUM_ZERO = 11937;
  const MIN_FILE_SIZE = OFF.compendium + 48 * (COMPENDIUM_COUNT - 1) + PERSONA_SIZE; // 21625

  // Errors carry a code (+args) so the UI can show them in the selected language.
  function coded(code, message, args) { const e = new Error(message); e.code = code; e.args = args; return e; }

  // ------------------------------------------------------------- byte utils
  const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (b, p) => view(b).getUint16(p, true);
  const u32 = (b, p) => view(b).getUint32(p, true);
  const w16 = (b, p, v) => view(b).setUint16(p, v & 0xffff, true);
  const w32 = (b, p, v) => view(b).setUint32(p, v >>> 0, true);
  const u16be = (b, p) => view(b).getUint16(p, false);
  const w16be = (b, p, v) => view(b).setUint16(p, v & 0xffff, false);

  function readPString(b, p) {
    let s = '';
    for (let i = 0; i < 9; i++) {
      const v = u16be(b, p + i * 2);
      if (v === 0) continue;
      if (v > 33358 && v < 33402) s += String.fromCharCode(v - 33311);
      else if (v > 33408 && v < 33435) s += String.fromCharCode(v - 33312);
      else if (v > 33079) s += String.fromCharCode((v - 33047) & 0xffff);
    }
    return s;
  }
  function writePString(b, p, name) {
    for (let i = 0; i < 9; i++) {
      let v = 0;
      if (i < name.length) {
        const c = name.charCodeAt(i);
        if (c >= 0x30 && c <= 0x5a) v = 33311 + c;          // '0'..'Z'
        else if (c >= 0x61 && c <= 0x7a) v = 33312 + c;     // 'a'..'z'
        else if (c >= 0x21) v = 33047 + c;                  // '!' and above
      }
      w16be(b, p + i * 2, v);
    }
  }
  function writeJString(b, p, name) {
    for (let i = 0; i < 9; i++) {
      let v = 0;
      if (i < name.length) {
        const lo = name.charCodeAt(i) & 0xff;
        if (lo !== 0xa0) v = (((lo + 0x60) << 8) | 0x80) & 0xffff;
      }
      w16(b, p + i * 2, v);
    }
  }

  // ---------------------------------------------------------------- persona
  function blankPersona() {
    return { exists: false, unknown0: 0, id: 0, level: 0, totalxp: 0,
             skills: [0, 0, 0, 0, 0, 0, 0, 0], st: 0, ma: 0, de: 0, ag: 0, lu: 0 };
  }
  function newPersona(id) {
    return { exists: true, unknown0: 0, id, level: 1, totalxp: 0,
             skills: [0, 0, 0, 0, 0, 0, 0, 0], st: 1, ma: 1, de: 1, ag: 1, lu: 1 };
  }
  function readPersona(b, p) {
    const skills = [];
    for (let i = 0; i < 8; i++) skills.push(u16(b, p + 12 + i * 2));
    return {
      exists: b[p] !== 0, unknown0: b[p + 1], id: u16(b, p + 2), level: b[p + 4],
      totalxp: u32(b, p + 8), skills,
      st: b[p + 28], ma: b[p + 29], de: b[p + 30], ag: b[p + 31], lu: b[p + 32],
    };
  }
  function writePersona(b, p, x) {
    b[p] = x.exists ? 1 : 0;
    b[p + 1] = x.unknown0 & 0xff;
    w16(b, p + 2, x.id);
    b[p + 4] = x.level & 0xff;
    // p+5..p+7 are skipped on purpose (kept from the original file)
    w32(b, p + 8, x.totalxp);
    for (let i = 0; i < 8; i++) w16(b, p + 12 + i * 2, x.skills[i]);
    b[p + 28] = x.st & 0xff; b[p + 29] = x.ma & 0xff; b[p + 30] = x.de & 0xff;
    b[p + 31] = x.ag & 0xff; b[p + 32] = x.lu & 0xff;
  }

  // ------------------------------------------------------------------ parse
  function parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < MIN_FILE_SIZE) {
      throw coded('too_small', 'File is too small (' + bytes.length + ' bytes) for a P4G save. Minimum is ' + MIN_FILE_SIZE + ' bytes.', { size: bytes.length, min: MIN_FILE_SIZE });
    }
    const s = {};
    s.surname = readPString(bytes, OFF.pSurname);
    s.firstname = readPString(bytes, OFF.pFirstname);
    s.yen = u32(bytes, OFF.yen);
    s.party = [bytes[OFF.party], bytes[OFF.party + 2], bytes[OFF.party + 4]];
    s.inventory = Array.from(bytes.subarray(OFF.inventory, OFF.inventory + INVENTORY_SIZE));

    // members[0] = protagonist, 1..7 = Yosuke, Chie, Yukiko, Rise, Kanji, Naoto, Teddie
    s.mcSlots = [];
    for (let i = 0; i < 12; i++) s.mcSlots.push(readPersona(bytes, OFF.mcPersonas + i * 48));
    s.memberPersona = [null];
    s.equip = { weapon: new Array(8).fill(0), armor: new Array(8).fill(0),
                accessory: new Array(8).fill(0), costume: new Array(8).fill(0) };
    s.equip.weapon[0] = u16(bytes, OFF.mcEquip);
    s.equip.armor[0] = u16(bytes, OFF.mcEquip + 2);
    s.equip.accessory[0] = u16(bytes, OFF.mcEquip + 4);
    s.equip.costume[0] = u16(bytes, OFF.mcEquip + 6);
    for (let i = 1; i < 8; i++) {
      const p = OFF.memberBlock + (i - 1) * 132;
      s.equip.weapon[i] = u16(bytes, p);
      s.equip.armor[i] = u16(bytes, p + 2);
      s.equip.accessory[i] = u16(bytes, p + 4);
      s.equip.costume[i] = u16(bytes, p + 6);
      s.memberPersona.push(readPersona(bytes, p + 8));
    }
    s.socialStats = [];
    for (let i = 0; i < 5; i++) s.socialStats.push(u16(bytes, OFF.socialStats + i * 2));
    s.mcLevel = bytes[OFF.mcLevel];
    s.mcXp = u32(bytes, OFF.mcXp);
    s.day = bytes[OFF.day]; s.dayPhase = bytes[OFF.dayPhase];
    s.nextDay = bytes[OFF.nextDay]; s.nextDayPhase = bytes[OFF.nextDayPhase];

    s.socialLinks = [];
    for (let i = 0; i < 23; i++) {
      const p = OFF.socialLinks + i * 16;
      if (bytes[p] !== 0) s.socialLinks.push({ id: bytes[p], level: bytes[p + 2], progress: bytes[p + 4], flag: bytes[p + 12] });
    }
    s.compendium = [];
    for (let i = 0; i < COMPENDIUM_COUNT; i++) {
      const pe = readPersona(bytes, OFF.compendium + 48 * i);
      if (pe.id !== 0) s.compendium.push(pe);
    }
    return s;
  }

  // -------------------------------------------------------------- serialize
  const clampByte = (n) => Math.max(0, Math.min(255, n | 0));

  function serialize(state, original) {
    const b = new Uint8Array(original); // copy: unknown regions stay untouched
    writeJString(b, OFF.jSurname, state.surname);
    writeJString(b, OFF.jFirstname, state.firstname);
    w32(b, OFF.yen, state.yen);
    for (let i = 0; i < 3; i++) b[OFF.party + i * 2] = state.party[i] & 0xff;
    writePString(b, OFF.pSurname, state.surname);
    writePString(b, OFF.pFirstname, state.firstname);
    for (let i = 0; i < INVENTORY_SIZE; i++) b[OFF.inventory + i] = clampByte(state.inventory[i]);

    for (let i = 0; i < 12; i++) writePersona(b, OFF.mcPersonas + i * 48, state.mcSlots[i]);
    w16(b, OFF.mcEquip, state.equip.weapon[0]);
    w16(b, OFF.mcEquip + 2, state.equip.armor[0]);
    w16(b, OFF.mcEquip + 4, state.equip.accessory[0]);
    w16(b, OFF.mcEquip + 6, state.equip.costume[0]);
    for (let i = 1; i < 8; i++) {
      const p = OFF.memberBlock + (i - 1) * 132;
      w16(b, p, state.equip.weapon[i]);
      w16(b, p + 2, state.equip.armor[i]);
      w16(b, p + 4, state.equip.accessory[i]);
      w16(b, p + 6, state.equip.costume[i]);
      writePersona(b, p + 8, state.memberPersona[i]);
    }
    b[OFF.mcLevel] = state.mcLevel & 0xff;
    w32(b, OFF.mcXp, state.mcXp);
    for (let i = 0; i < 5; i++) w16(b, OFF.socialStats + i * 2, state.socialStats[i]);
    b[OFF.day] = state.day & 0xff; b[OFF.dayPhase] = state.dayPhase & 0xff;
    b[OFF.nextDay] = state.nextDay & 0xff; b[OFF.nextDayPhase] = state.nextDayPhase & 0xff;

    b.fill(0, OFF.socialLinks, OFF.socialLinks + 368);
    const n = Math.min(23, state.socialLinks.length);
    for (let i = 0; i < n; i++) {
      const l = state.socialLinks[i], p = OFF.socialLinks + i * 16;
      b[p] = l.id & 0xff; b[p + 2] = l.level & 0xff; b[p + 4] = l.progress & 0xff; b[p + 12] = l.flag & 0xff;
    }

    b.fill(0, OFF.compendium, OFF.compendium + COMPENDIUM_ZERO);
    for (const pe of state.compendium) {
      if (pe.id < 1 || pe.id > COMPENDIUM_COUNT) continue; // cannot be addressed
      writePersona(b, OFF.compendium + 48 * (pe.id - 1), pe);
    }
    return b;
  }

  // --------------------------------------------------------- social stats
  // Same thresholds as the original PointsToStatusLevel / StatusLevelToPoints.
  // stat index: 0 Courage, 1 Knowledge, 2 Diligence, 3 Understanding, 4 Expression
  const STAT_BOUNDS = {
    0: [15, 39, 79, 139], 2: [15, 39, 79, 139], 3: [15, 39, 79, 139],
    1: [29, 79, 149, 239], 4: [12, 32, 52, 84],
  };
  function pointsToLevel(stat, pts) {
    const t = STAT_BOUNDS[stat];
    for (let i = 0; i < 4; i++) if (pts <= t[i]) return i + 1;
    return 5;
  }
  function levelToPoints(stat, level) {
    const t = STAT_BOUNDS[stat];
    if (level === 1) return t[0];
    return t[level - 2] + 1;
  }

  // Original XP formula; uint32 wraparound + C# long subtraction preserved.
  function xpForLevel(level) {
    const l = level, M = 4294967296;
    const sum32 = (Math.pow(l, 4) + 4 * Math.pow(l, 3) + 53 * Math.pow(l, 2)) % M;
    const diff = sum32 - 58 * l;
    const q = Math.trunc(diff / 10);
    return ((q % M) + M) % M;
  }


  // ------------------------------------------------- Switch .binslot support
  // The Switch version keeps a "<name>.binslot" next to "<name>.bin". Offset 24
  // of it holds the MD5 of the .bin (offset 24) and a second MD5 over the slot's own data (offset 8,
  // see zarroboogs/p4g-saveconv). The game rejects the save when either does not match.
  function md5(bytes) {
    const K = new Uint32Array(64), R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    const n = bytes.length, padded = new Uint8Array(((n + 8) >> 6 << 6) + 64);
    padded.set(bytes); padded[n] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, (n * 8) >>> 0, true);
    dv.setUint32(padded.length - 4, Math.floor(n / 536870912), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    for (let o = 0; o < padded.length; o += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getUint32(o + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        const r = R[(i >> 4) * 4 + (i & 3)];
        B = (B + ((F << r) | (F >>> (32 - r)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16), ov = new DataView(out.buffer);
    ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
    return out;
  }

  const SLOT_MD5 = 24, SLOT_TITLE = 44;
  function isBinslot(bytes) {
    return bytes.length >= 64 && String.fromCharCode.apply(null, bytes.subarray(0, 8)) === 'SAVE0001';
  }
  /** Returns a copy of the .binslot with the MD5 and the "Lv:N" title text matching the given .bin. */
  function patchBinslot(slot, bin) {
    if (!isBinslot(slot)) throw coded('not_binslot', 'Not a P4G .binslot file (SAVE0001 magic not found).');
    const out = new Uint8Array(slot);
    out.set(md5(bin), SLOT_MD5);
    let end = out.indexOf(0, SLOT_TITLE); if (end < 0) end = out.length;
    const title = String.fromCharCode.apply(null, out.subarray(SLOT_TITLE, end));
    const m = /\sLv:\d+$/.exec(title.replace(/[^\x00-\x7f]/g, '?'));
    if (m && bin.length > OFF.mcLevel) {
      const start = SLOT_TITLE + m.index;
      const text = ' Lv:' + bin[OFF.mcLevel];
      let nxt = end; while (nxt < out.length && out[nxt] === 0 && nxt - start < 16) nxt++;
      if (text.length <= nxt - start) {
        out.fill(0, start, nxt);
        for (let i = 0; i < text.length; i++) out[start + i] = text.charCodeAt(i);
      }
    }
    // SlotFile_MD5 (offset 8) = MD5(slot[0x28:] + "P4GOLDEN"); depends on the title text patched above
    const tail = out.subarray(0x28), buf = new Uint8Array(tail.length + 8);
    buf.set(tail); for (let k = 0; k < 8; k++) buf[tail.length + k] = 'P4GOLDEN'.charCodeAt(k);
    out.set(md5(buf), 8);
    return out;
  }

  /** True when both checksums inside a .binslot match its .bin (what the Switch game checks on load). */
  function verifySlot(slot, bin) {
    if (!isBinslot(slot)) return false;
    const same = (a, b) => { for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; };
    if (!same(slot.subarray(SLOT_MD5, SLOT_MD5 + 16), md5(bin))) return false;
    const tail = slot.subarray(0x28), buf = new Uint8Array(tail.length + 8);
    buf.set(tail); for (let k = 0; k < 8; k++) buf[tail.length + k] = 'P4GOLDEN'.charCodeAt(k);
    return same(slot.subarray(8, 24), md5(buf));
  }

  // ---------------------------------------------------------------- catalog
  function buildCatalog(db) {
    const range = (arr, start, len) => {
      const out = [];
      for (let i = 0; i < len; i++) out.push({ id: start + i, name: arr[start + i] });
      return out;
    };
    const I = (s, l) => range(db.allItems, s, l);
    const blank = (id) => ({ id, name: db.allItems[id] });

    const skills = [].concat(range(db.allSkills, 0, 255), range(db.allSkills, 259, 42),
      range(db.allSkills, 349, 46), range(db.allSkills, 440, 13), range(db.allSkills, 472, 151));

    const personae = [{ id: 0, name: 'Blank' }].concat(range(db.personae, 1, 42), range(db.personae, 44, 8),
      range(db.personae, 53, 127), range(db.personae, 182, 32), range(db.personae, 224, 26));

    const mc = I(1, 36).concat(I(2305, 11)), yo = I(39, 32).concat(I(2326, 9)),
      yu = I(77, 28).concat(I(2345, 11)), ch = I(112, 31).concat(I(2367, 9)),
      ka = I(150, 26).concat(I(2385, 3), I(2389, 8)), na = I(183, 15).concat(I(2407, 8)),
      te = I(217, 22).concat(I(2425, 8));
    mc.push(blank(2434)); yo.push(blank(2435)); yu.push(blank(2437)); ch.push(blank(2436));
    ka.push(blank(2438)); na.push(blank(2439)); te.push(blank(2440));
    const wb = blank(0);
    const allWeapons = [wb].concat(mc, yo, ch, yu, ka, na, te);
    const weaponsByMember = { 0: [wb].concat(mc), 1: [wb].concat(yo), 2: [wb].concat(ch), 3: [wb].concat(yu),
      5: [wb].concat(ka), 6: [wb].concat(na), 7: [wb].concat(te) };

    let armor = I(257, 8);
    [[266, 6], [287, 4], [293, 4], [307, 4], [315, 3], [328, 4], [334, 5], [347, 2], [350, 9], [367, 4],
      [372, 7], [387, 6], [394, 5], [407, 6], [414, 5], [420, 13]].forEach(([s, l]) => { armor = armor.concat(I(s, l)); });
    armor.unshift(blank(256));

    const accessories = [blank(512)].concat(I(513, 96), I(615, 69), I(685, 1), I(687, 8), I(754, 13));
    const consumables = [blank(768)].concat(I(769, 51));
    let materials = I(1281, 128);
    [[1410, 21], [1432, 21], [1454, 20], [1475, 19], [1495, 19], [1513, 21]].forEach(([s, l]) => { materials = materials.concat(I(s, l)); });
    materials.unshift(blank(1280));
    const cards = [blank(1536)].concat(I(1537, 252));
    const otherBlank = blank(1024);
    const books = [otherBlank].concat(I(1136, 5), I(1145, 7), I(1259, 20));
    const veggies = [blank(768)].concat(I(2089, 16), I(2107, 4));
    const minerals = [blank(2048)].concat(I(2128, 29));
    const socialLink = [otherBlank].concat(I(1184, 20), I(1207, 3), I(1224, 3), I(1228, 1));
    const shelf = [otherBlank].concat(I(2056, 5), I(1234, 13));
    const costumes = I(1792, 193).concat(I(2040, 6));
    const bugs = [otherBlank].concat(I(909, 7));
    const fish = [otherBlank].concat(I(1004, 3), I(1008, 7));
    const other = [otherBlank];

    const sections = [
      ['Weapons', allWeapons], ['Armor', armor], ['Accessories', accessories], ['Consumables', consumables],
      ['Materials', materials], ['Skill Cards', cards], ['Books', books], ['Veggies', veggies],
      ['Minerals', minerals], ['Social Link', socialLink], ['Shelf', shelf], ['Costumes', costumes],
      ['Bugs', bugs], ['Fish', fish], ['Other', other],
    ].map(([name, items]) => ({ name, items }));

    const SL = (name, id, tarot) => ({ name, id, tarot });
    const socialLinkIDs = [
      SL('Blank', 0, 0), SL('Investigation Team', 1, 1), SL('Nanako', 2, 9), SL('Rise', 3, 7), SL('Rise (GF)', 4, 7),
      SL('Yukiko', 5, 3), SL('Yukiko (GF)', 6, 3), SL('Yosuke', 7, 2), SL('Dojima', 8, 6), SL('Sayoko', 9, 16),
      SL('Kanji', 10, 5), SL('Chie', 11, 8), SL('Chie (GF)', 12, 3), SL('Fox', 13, 10), SL('Naoto', 14, 11),
      SL('Naoto (GF)', 15, 11), SL('Fellow Athletes (Kou)', 16, 12), SL('Fellow Athletes (Daisuke)', 17, 12),
      SL('Naoki', 18, 13), SL('Hisano', 19, 14), SL('Margaret', 20, 4), SL('Ai', 21, 19), SL('Ai (GF)', 22, 19),
      SL('Shu', 23, 17), SL('Teddie', 24, 18), SL('Yumi', 25, 20), SL('Yumi (GF)', 26, 20), SL('Ayane', 27, 20),
      SL('Ayane (GF)', 28, 20), SL('Eri', 29, 15), SL('The Seekers of Truth', 30, 21), SL('Adachi', 31, 25),
      SL('Adachi (Hunger)', 32, 26), SL('Marie', 33, 22), SL('Marie (GF)', 34, 22),
    ].map((x) => Object.assign(x, { arcana: db.Arcana[x.tarot] }));

    return {
      skills, personae, sections, weaponsByMember, armor, accessories, costumes, socialLinkIDs,
      // names of party in file order; index 0 gets the protagonist's real name
      members: [
        { slot: 0, name: 'Protagonist', equipId: 0 }, { slot: 1, name: db.party[1], equipId: 1 },
        { slot: 2, name: db.party[2], equipId: 2 }, { slot: 3, name: db.party[3], equipId: 3 },
        { slot: 4, name: db.party[4], equipId: 4 }, { slot: 5, name: db.party[5], equipId: 5 },
        { slot: 6, name: db.party[6], equipId: 6 }, { slot: 7, name: db.party[7], equipId: 7 },
      ],
      // value stored in the "active party" bytes of the save
      partyChoices: [
        { id: 0, name: 'Blank' }, { id: 2, name: 'Yosuke' }, { id: 3, name: 'Chie' }, { id: 4, name: 'Yukiko' },
        { id: 6, name: 'Kanji' }, { id: 7, name: 'Naoto' }, { id: 8, name: 'Teddie' },
      ],
      statNames: ['Courage', 'Knowledge', 'Diligence', 'Understanding', 'Expression'],
      statLevels: [
        ['Average', 'Reliable', 'Brave', 'Daring', 'Heroic'],
        ['Aware', 'Informed', 'Expert', 'Professor', 'Sage'],
        ['Callow', 'Persistent', 'Strong', 'Thorough', 'Rock Solid'],
        ['Basic', 'Kindly', 'Generous', 'Motherly', 'Saintly'],
        ['Rough', 'Eloquent', 'Persuasive', 'Touching', 'Enthralling'],
      ],
    };
  }

  /** Sanity checks before saving. Returns [{code, n}] - n = how many entries are affected. */
  function validate(s) {
    const out = [];
    const add = (code, n) => { if (n > 0) out.push({ code, n }); };
    const personas = [].concat(s.mcSlots, s.memberPersona.slice(1), s.compendium).filter((p) => p && p.id !== 0);
    add('mc_level_over_99', s.mcLevel > 99 ? 1 : 0);
    add('mc_level_zero', s.mcLevel < 1 ? 1 : 0);
    add('persona_level_over_99', personas.filter((p) => p.level > 99).length);
    add('persona_level_zero', personas.filter((p) => p.level < 1).length);
    add('stat_over_99', personas.filter((p) => [p.st, p.ma, p.de, p.ag, p.lu].some((v) => v > 99)).length);
    add('item_over_99', s.inventory.filter((c) => c > 99).length);
    add('yen_over_max', s.yen > 9999999 ? 1 : 0);
    add('link_level_range', s.socialLinks.filter((l) => l.level < 1 || l.level > 10).length);
    const pm = s.party.filter((x) => x !== 0);
    add('party_duplicate', pm.length !== new Set(pm).size ? 1 : 0);
    add('name_empty', (s.firstname.trim() === '' && s.surname.trim() === '') ? 1 : 0);
    return out;
  }

  return {
    OFF, INVENTORY_SIZE, MIN_FILE_SIZE, COMPENDIUM_COUNT,
    parse, serialize, buildCatalog, md5, isBinslot, patchBinslot, newPersona, blankPersona,
    pointsToLevel, levelToPoints, xpForLevel, validate, verifySlot,
    _internal: { readPString, writePString, writeJString, readPersona, writePersona },
  };
});
