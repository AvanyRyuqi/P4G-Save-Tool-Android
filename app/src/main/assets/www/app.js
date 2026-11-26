/* P4G Save Tool - UI layer (mobile). Logic lives in p4g-core.js */
(function () {
  'use strict';
  const DB = window.P4G_DB;
  const CAT = P4G.buildCatalog(DB);
  const bridge = window.AndroidBridge || null;

  // ----------------------------------------------------------------- state
  let S = null;            // parsed save
  let orig = null;         // original bytes (base for serialize)
  let fileName = '';
  let slotBytes = null;    // Switch: companion .binslot (optional)
  let slotName = '';
  let dirty = false;
  let tab = 'stats';
  let memberIdx = 0;       // 0 = protagonist, 1..7 = party in file order
  let slotIdx = 0;         // persona slot of protagonist (0..11)
  let invSection = 0;
  let invFilter = '';
  let compFilter = '';
  const root = document.getElementById('app');

  // --------------------------------------------------------------- helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const nameOf = (list, id, unknownPrefix) => { const f = list.find((x) => x.id === id); return f ? f.name : (unknownPrefix || 'Unknown') + ' (' + id + ')'; };
  const personaName = (id) => id === 0 ? 'Blank' : (DB.personae[id] != null ? DB.personae[id] : 'Unknown (' + id + ')');
  const skillName = (id) => DB.allSkills[id] != null ? DB.allSkills[id] : 'Unknown (' + id + ')';
  const itemName = (id) => DB.allItems[id] != null ? DB.allItems[id] : 'Unknown (' + id + ')';
  const protagName = () => (S && (S.firstname + ' ' + S.surname).trim()) || 'Protagonist';
  const memberName = (i) => i === 0 ? protagName() : DB.party[i];

  function markDirty() {
    if (!dirty) { dirty = true; updateTopbar(); }
  }
  function toast(msg, err) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), err ? 4500 : 2200);
  }

  // ------------------------------------------------------------ modal stack
  const modals = [];
  function openSheet(title, bodyEl, opts) {
    opts = opts || {};
    const scrim = h('div', { class: 'scrim' });
    const close = () => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); if (opts.onClose) opts.onClose(); };
    const sheet = h('div', { class: 'sheet' + (opts.full ? ' full' : '') },
      h('header', null, h('h4', null, title), h('button', { class: 'iconbtn', onclick: close, 'aria-label': 'Tutup' }, '✕')),
      h('div', { class: 'body' }, bodyEl));
    scrim.append(sheet);
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    const entry = { close };
    modals.push(entry);
    document.body.append(scrim);
    return { close, sheet };
  }
  function confirmDialog(message, okLabel, danger) {
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim center' });
      const entry = { close: () => done(false) };
      const done = (v) => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); resolve(v); };
      scrim.append(h('div', { class: 'dialog' }, h('p', null, message),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Batal'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'accent'), onclick: () => done(true) }, okLabel || 'OK'))));
      modals.push(entry);
      document.body.append(scrim);
    });
  }

  /** Full-screen searchable list. Resolves with the chosen id, or undefined.
   *  Search: every word must match the name (any order) or the id, e.g. "agi lv", "mara", "#134". */
  function pick(title, options, currentId) {
    return new Promise((resolve) => {
      const PAGE = 100;
      let chosen, limit = PAGE, handle;
      const list = h('div');
      const count = h('small', { class: 'hint', style: 'display:block;margin:2px 2px 0' });
      const search = h('input', { type: 'text', placeholder: 'Cari nama atau ID…', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' });
      const clear = h('button', { class: 'clearbtn', type: 'button', 'aria-label': 'Hapus pencarian', hidden: true, onclick: () => { search.value = ''; limit = PAGE; render(); search.focus(); } }, '✕');
      const bar = h('div', { class: 'searchbar' }, h('div', { class: 'searchwrap' }, search, clear), count);
      const lower = options.map((o) => o.name.toLowerCase());
      const matches = () => {
        const tokens = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) return options;
        const hit = [];
        options.forEach((o, i) => {
          const n = lower[i], id = String(o.id);
          if (tokens.every((t) => n.includes(t) || id === t.replace(/^#/, '') || (/^#?\d+$/.test(t) && id.startsWith(t.replace(/^#/, ''))))) hit.push([n.startsWith(tokens[0]) ? 0 : 1, i]);
        });
        return hit.sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => options[x[1]]); // prefix matches first
      };
      const render = () => {
        const res = matches();
        clear.hidden = !search.value;
        count.textContent = search.value.trim() ? res.length + ' hasil' : options.length + ' pilihan';
        list.replaceChildren();
        res.slice(0, limit).forEach((o) => list.append(h('button', { class: 'opt' + (o.id === currentId ? ' on' : ''), onclick: () => { chosen = o.id; handle.close(); } },
          h('span', null, o.name), h('small', null, o.sub != null ? o.sub : '#' + o.id))));
        if (res.length > limit) list.append(h('button', { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => { limit += PAGE; render(); } }, 'Tampilkan lebih banyak (' + (res.length - limit) + ')'));
        if (!res.length) list.append(h('p', { class: 'empty' }, 'Tidak ada hasil untuk "' + search.value.trim() + '"'));
      };
      search.addEventListener('input', () => { limit = PAGE; render(); });
      handle = openSheet(title, h('div', null, bar, list), { full: true, onClose: () => resolve(chosen) });
      render();
      const cur = list.querySelector('.opt.on');
      if (cur) cur.scrollIntoView({ block: 'center' });
      if (options.length > 12) setTimeout(() => search.focus(), 50); // open the keyboard right away for long lists
    });
  }
  const withUnknown = (list, id, prefix) => list.some((x) => x.id === id) ? list : list.concat([{ id, name: (id === 0 ? 'Blank' : (prefix || 'Unknown')) + ' (' + id + ')' }]);

  /** A tappable "select" that opens the picker. */
  function selectField(options, getId, setId, title) {
    const label = h('span', { class: 'v' });
    const btn = h('button', { class: 'select', type: 'button' }, label);
    const refresh = () => {
      const id = getId(); const o = withUnknown(options, id).find((x) => x.id === id);
      label.textContent = o.name; btn.classList.toggle('unknown', id !== 0 && !options.some((x) => x.id === id));
    };
    btn.addEventListener('click', async () => {
      const id = getId();
      const r = await pick(title || 'Pilih', withUnknown(options, id), id);
      if (r !== undefined && r !== id) { setId(r); markDirty(); refresh(); }
    });
    refresh();
    return btn;
  }
  function numField(get, set, min, max, cls) {
    const inp = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'num ' + (cls || ''), value: String(get()) });
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('change', () => {
      const n = parseInt(inp.value, 10);
      const v = clamp(Number.isFinite(n) ? n : get(), min, max);
      inp.value = String(v);
      if (v !== get()) { set(v); markDirty(); }
    });
    return inp;
  }
  function slider(label, get, set, min, max, warnOver) {
    const val = h('span', { class: 'val' }, String(get()));
    const r = h('input', { type: 'range', min, max, step: 1, value: get() });
    const paint = () => { val.textContent = r.value; val.classList.toggle('warn', warnOver != null && +r.value > warnOver); };
    r.addEventListener('input', () => { set(+r.value); markDirty(); paint(); });
    paint();
    return h('div', { class: 'sliderrow' }, h('span', { class: 'lbl' }, label), r, val);
  }
  const row = (label, ctl, hint) => h('div', { class: 'row' }, h('label', null, label), h('div', { class: 'grow' }, ctl));
  const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h3', null, title) : null, kids);

  // --------------------------------------------------------- persona editor
  function personaEditor(p, opts) {
    const el = h('div');
    if (opts.idPicker) {
      el.append(row('Persona', selectField(CAT.personae, () => p.id, (id) => {
        p.id = id;
        if (p.level === 0 && id !== 0 && !p.exists) p.level = 1;
        p.exists = id !== 0;
        opts.onIdChange && opts.onIdChange();
      }, 'Persona')));
    }
    const lvWrap = h('div');
    lvWrap.append(slider('Lv', () => p.level, (v) => { p.level = v; }, 1, 255, 99));
    el.append(lvWrap);
    const xpInput = numField(() => p.totalxp, (v) => { p.totalxp = v; }, 0, 4294967295);
    xpInput.style.maxWidth = 'none';
    el.append(h('div', { class: 'row' }, h('label', null, 'Total XP'), h('div', { class: 'grow' }, xpInput),
      h('button', { class: 'btn small', onclick: () => { p.totalxp = P4G.xpForLevel(p.level); xpInput.value = String(p.totalxp); markDirty(); } }, 'Dari level')));
    [['ST', 'st'], ['MA', 'ma'], ['DE', 'de'], ['AG', 'ag'], ['LU', 'lu']].forEach(([lbl, k]) =>
      el.append(slider(lbl, () => p[k], (v) => { p[k] = v; }, 0, 255)));
    el.append(h('p', { class: 'hint' }, 'Skill'));
    for (let i = 0; i < 8; i++) {
      el.append(row('Skill ' + (i + 1), selectField(CAT.skills, () => p.skills[i], (id) => { p.skills[i] = id; }, 'Skill ' + (i + 1))));
    }
    return el;
  }

  // ------------------------------------------------------------------- tabs
  function statsTab() {
    const wrap = h('div');
    // member chips
    const chips = h('div', { class: 'chips' });
    for (let i = 0; i < 8; i++) {
      chips.append(h('button', { class: 'chip' + (i === memberIdx ? ' on' : ''), onclick: () => { memberIdx = i; slotIdx = 0; render(); } }, memberName(i).split(' ')[0] || memberName(i)));
    }
    wrap.append(chips);

    if (memberIdx === 0) {
      wrap.append(card('Protagonist',
        row('Yen', numField(() => S.yen, (v) => { S.yen = v; }, 0, 4294967295)),
        slider('Lv', () => S.mcLevel, (v) => { S.mcLevel = v; }, 1, 255, 99),
        (() => {
          const xp = numField(() => S.mcXp, (v) => { S.mcXp = v; }, 0, 4294967295);
          return h('div', { class: 'row' }, h('label', null, 'Total XP'), h('div', { class: 'grow' }, xp),
            h('button', { class: 'btn small', onclick: () => { S.mcXp = P4G.xpForLevel(S.mcLevel); xp.value = String(S.mcXp); markDirty(); } }, 'Dari level'));
        })()));
    }

    // persona
    let p;
    const slotRow = [];
    if (memberIdx === 0) {
      const chipsSlot = h('div', { class: 'chips' });
      for (let i = 0; i < 12; i++) chipsSlot.append(h('button', { class: 'chip' + (i === slotIdx ? ' on' : ''), onclick: () => { slotIdx = i; render(); } }, 'Slot ' + (i + 1)));
      slotRow.push(chipsSlot);
      p = S.mcSlots[slotIdx];
    } else {
      p = S.memberPersona[memberIdx];
    }
    wrap.append(card('Persona', slotRow, personaEditor(p, { idPicker: true, onIdChange: render })));

    // equipment
    const eq = CAT.members[memberIdx].equipId;
    if (memberIdx === 4) {
      wrap.append(card('Equipment', h('p', { class: 'hint' }, 'Rise tidak memiliki slot equipment di save file.')));
    } else {
      const wl = CAT.weaponsByMember[eq];
      wrap.append(card('Equipment',
        row('Weapon', selectField(wl, () => S.equip.weapon[eq], (id) => { S.equip.weapon[eq] = id; }, 'Weapon')),
        row('Armor', selectField(CAT.armor, () => S.equip.armor[eq], (id) => { S.equip.armor[eq] = id; }, 'Armor')),
        row('Accessory', selectField(CAT.accessories, () => S.equip.accessory[eq], (id) => { S.equip.accessory[eq] = id; }, 'Accessory')),
        row('Costume', selectField(CAT.costumes, () => S.equip.costume[eq], (id) => { S.equip.costume[eq] = id; }, 'Costume'))));
    }

    if (memberIdx === 0) {
      // social stats
      const sc = card('Social Stats');
      CAT.statNames.forEach((nm, st) => {
        const lvls = CAT.statLevels[st].map((n, i) => ({ id: i + 1, name: n, sub: 'Lv ' + (i + 1) }));
        const pts = h('small', { class: 'hint' });
        const paint = () => { pts.textContent = S.socialStats[st] + ' poin'; };
        const sel = selectField(lvls, () => P4G.pointsToLevel(st, S.socialStats[st]),
          (lv) => { S.socialStats[st] = P4G.levelToPoints(st, lv); paint(); }, nm);
        paint();
        sc.append(row(nm, sel), h('div', { style: 'margin:-4px 0 6px 106px' }, pts));
      });
      // party config
      wrap.append(sc, card('Party Configuration', [0, 1, 2].map((i) =>
        row('Member ' + (i + 1), selectField(CAT.partyChoices, () => S.party[i], (id) => { S.party[i] = id; }, 'Member ' + (i + 1))))));
    }
    return wrap;
  }

  function inventoryTab() {
    const wrap = h('div');
    const sec = CAT.sections[invSection];
    const chips = h('div', { class: 'chips' });
    CAT.sections.forEach((s, i) => chips.append(h('button', { class: 'chip' + (i === invSection ? ' on' : ''), onclick: () => { invSection = i; render(); } }, s.name)));
    wrap.append(chips);

    const search = h('input', { class: 'search', type: 'text', placeholder: 'Cari item di inventory…', value: invFilter });
    const listEl = h('div', { class: 'list' });
    const addBtn = h('button', { class: 'btn accent', onclick: async () => {
      const opts = sec.items.filter((i) => i.name !== 'Blank' && i.id !== 1792).map((i) => ({ id: i.id, name: i.name, sub: S.inventory[i.id] > 0 ? '×' + S.inventory[i.id] : '#' + i.id }));
      if (!opts.length) { toast('Section ini kosong'); return; }
      const id = await pick('Tambah ' + sec.name, opts);
      if (id === undefined) return;
      if (S.inventory[id] > 0) { toast('Sudah ada di inventory (×' + S.inventory[id] + ')'); return; }
      S.inventory[id] = 1; markDirty(); invFilter = ''; renderList(); toast('Ditambahkan: ' + itemName(id));
    } }, '+ Tambah ' + sec.name);
    wrap.append(h('div', { class: 'toolbar' }, search), h('div', { class: 'toolbar' }, addBtn));
    wrap.append(listEl);

    function renderList() {
      listEl.replaceChildren();
      const q = invFilter.trim().toLowerCase();
      let n = 0;
      for (let id = 0; id < S.inventory.length; id++) {
        const c = S.inventory[id];
        if (c === 0 || id === 1792 || DB.allItems[id] == null || DB.allItems[id] === 'Blank') continue;
        const nm = DB.allItems[id];
        if (q && !nm.toLowerCase().includes(q)) continue;
        n++;
        const inp = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: String(c) });
        const setVal = (v) => { v = clamp(v, 1, 255); S.inventory[id] = v; inp.value = String(v); markDirty(); };
        inp.addEventListener('focus', () => inp.select());
        inp.addEventListener('change', () => { const x = parseInt(inp.value, 10); setVal(Number.isFinite(x) ? x : S.inventory[id]); });
        listEl.append(h('div', { class: 'item' },
          h('div', { class: 'name' }, h('b', null, nm), h('small', null, '#' + id)),
          h('div', { class: 'stepper' },
            h('button', { onclick: () => setVal(S.inventory[id] - 1) }, '−'), inp, h('button', { onclick: () => setVal(S.inventory[id] + 1) }, '+')),
          h('button', { class: 'iconbtn', 'aria-label': 'Hapus', style: 'min-width:40px;height:40px;padding:0', onclick: () => { S.inventory[id] = 0; markDirty(); renderList(); } }, '🗑')));
      }
      if (!n) listEl.append(h('p', { class: 'empty' }, q ? 'Tidak ada hasil' : 'Inventory kosong. Tambahkan item di atas.'));
    }
    search.addEventListener('input', () => { invFilter = search.value; renderList(); });
    renderList();
    return wrap;
  }

  function socialTab() {
    const wrap = h('div');
    const add = h('button', { class: 'btn accent', onclick: async () => {
      if (S.socialLinks.length >= 23) { toast('Maksimal 23 social link', true); return; }
      const opts = CAT.socialLinkIDs.filter((x) => x.id !== 0 && !S.socialLinks.some((l) => l.id === x.id)).map((x) => ({ id: x.id, name: x.name, sub: x.arcana }));
      if (!opts.length) { toast('Semua link sudah ditambahkan'); return; }
      const id = await pick('Tambah Social Link', opts);
      if (id === undefined) return;
      S.socialLinks.push({ id, level: 1, progress: 0, flag: 0 }); markDirty(); render();
    } }, '+ Tambah Social Link');
    wrap.append(h('div', { class: 'toolbar' }, add));
    if (!S.socialLinks.length) wrap.append(h('p', { class: 'empty' }, 'Belum ada social link.'));
    S.socialLinks.forEach((l, idx) => {
      const info = CAT.socialLinkIDs.find((x) => x.id === l.id);
      wrap.append(h('div', { class: 'card' },
        h('div', { class: 'item', style: 'border:0;padding:0;margin-bottom:6px' },
          h('div', { class: 'name' }, h('b', null, info ? info.name : 'Unknown (' + l.id + ')'), h('small', null, info ? info.arcana : '#' + l.id)),
          h('button', { class: 'btn small danger', onclick: () => { S.socialLinks.splice(idx, 1); markDirty(); render(); } }, 'Hapus')),
        row('Level', numField(() => l.level, (v) => { l.level = v; }, 0, 255)),
        row('Progress', numField(() => l.progress, (v) => { l.progress = v; }, 0, 255))));
    });
    return wrap;
  }

  function compendiumTab() {
    const wrap = h('div');
    const search = h('input', { class: 'search', type: 'text', placeholder: 'Cari persona…', value: compFilter });
    const listEl = h('div', { class: 'list' });
    const openEditor = (pe) => {
      const handle = openSheet(personaName(pe.id) + '  (#' + pe.id + ')', h('div', null,
        personaEditor(pe, { idPicker: false }),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn danger', style: 'width:100%', onclick: () => {
          S.compendium.splice(S.compendium.indexOf(pe), 1); markDirty(); handle.close(); renderList();
        } }, 'Hapus dari compendium'))), { full: true, onClose: renderList });
    };
    const add = h('button', { class: 'btn accent', onclick: async () => {
      const opts = CAT.personae.filter((x) => x.id !== 0).map((x) => ({ id: x.id, name: x.name, sub: S.compendium.some((c) => c.id === x.id) ? '✓ terdaftar' : '#' + x.id }));
      const id = await pick('Tambah ke Compendium', opts);
      if (id === undefined) return;
      let pe = S.compendium.find((c) => c.id === id);
      if (!pe) {
        if (id > P4G.COMPENDIUM_COUNT) { toast('ID persona tidak bisa disimpan di compendium', true); return; }
        pe = P4G.newPersona(id); S.compendium.push(pe); S.compendium.sort((a, b) => a.id - b.id); markDirty();
      }
      renderList(); openEditor(pe);
    } }, '+ Tambah');
    const clear = h('button', { class: 'btn danger', onclick: async () => {
      if (!S.compendium.length) return;
      if (await confirmDialog('Hapus semua ' + S.compendium.length + ' persona dari compendium?', 'Hapus semua', true)) { S.compendium = []; markDirty(); renderList(); }
    } }, 'Hapus semua');
    wrap.append(h('div', { class: 'toolbar' }, search), h('div', { class: 'toolbar' }, add, clear), listEl);
    function renderList() {
      listEl.replaceChildren();
      const q = compFilter.trim().toLowerCase();
      let n = 0;
      for (const pe of S.compendium) {
        const nm = personaName(pe.id);
        if (q && !nm.toLowerCase().includes(q)) continue;
        n++;
        listEl.append(h('div', { class: 'item tap', onclick: () => openEditor(pe) },
          h('div', { class: 'name' }, h('b', null, nm), h('small', null, '#' + pe.id + ' · Lv ' + pe.level + (pe.level > 99 ? ' ⚠' : ''))),
          h('span', { class: 'hint' }, '›')));
      }
      if (!n) listEl.append(h('p', { class: 'empty' }, q ? 'Tidak ada hasil' : 'Compendium kosong.'));
    }
    search.addEventListener('input', () => { compFilter = search.value; renderList(); });
    renderList();
    return wrap;
  }

  function otherTab() {
    const phases = DB.phases.map((n, i) => ({ id: i, name: n }));
    const nameInput = (key) => {
      const i = h('input', { type: 'text', maxlength: 9, value: S[key], autocomplete: 'off' });
      i.addEventListener('input', () => { S[key] = i.value.slice(0, 9); markDirty(); });
      return i;
    };
    return h('div', null,
      card('Tanggal', row('Day', numField(() => S.day, (v) => { S.day = v; }, 0, 255)),
        row('Phase', selectField(phases, () => S.dayPhase, (v) => { S.dayPhase = v; }, 'Phase')),
        row('Next Day', numField(() => S.nextDay, (v) => { S.nextDay = v; }, 0, 255)),
        row('Next Phase', selectField(phases, () => S.nextDayPhase, (v) => { S.nextDayPhase = v; }, 'Next Phase'))),
      card('Nama Protagonist', row('First name', nameInput('firstname')), row('Surname', nameInput('surname')),
        h('p', { class: 'hint' }, 'Maksimal 9 karakter. Huruf, angka, dan simbol umum didukung.')));
  }

  // ----------------------------------------------------------- shell / chrome
  const ICONS = {
    stats: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    inv: '<svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v10l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v10"/></svg>',
    social: '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z"/></svg>',
    comp: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
    other: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  };
  const TABS = [['stats', 'Stats', statsTab], ['inv', 'Inventory', inventoryTab], ['social', 'Social', socialTab], ['comp', 'Compendium', compendiumTab], ['other', 'Lainnya', otherTab]];
  let mainEl, titleSub, saveBtn, navEl;

  function updateTopbar() {
    if (!titleSub) return;
    titleSub.textContent = S ? (fileName || 'save') + (slotBytes ? ' + binslot' : '') + (dirty ? ' — belum disimpan' : '') : 'Belum ada file dibuka';
    titleSub.classList.toggle('dirty', !!(S && dirty));
    saveBtn.disabled = !S;
  }

  function build() {
    root.replaceChildren();
    titleSub = h('span');
    saveBtn = h('button', { class: 'iconbtn primary', onclick: doSave }, 'Simpan');
    const top = h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('b', null, 'P4G Save Tool'), titleSub),
      h('button', { class: 'iconbtn', onclick: doOpen }, 'Buka'), saveBtn,
      h('button', { class: 'iconbtn', 'aria-label': 'Menu', onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, '⋮'));
    mainEl = h('main');
    navEl = h('nav');
    root.append(top, mainEl, navEl);
    updateTopbar();
    render();
  }

  let menuEl = null;
  function toggleMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; return; }
    menuEl = h('div', { class: 'menu' },
      h('button', { onclick: () => { toggleMenu(); doSaveAs(); } }, 'Simpan sebagai…'),
      h('button', { onclick: () => { toggleMenu(); showAbout(); } }, 'Tentang'));
    document.body.append(menuEl);
  }
  document.addEventListener('click', () => { if (menuEl) { menuEl.remove(); menuEl = null; } });

  function render() {
    const scroll = mainEl.scrollTop;
    mainEl.replaceChildren();
    navEl.replaceChildren();
    if (!S) {
      mainEl.append(h('div', { class: 'welcome' },
        h('div', { class: 'logo' }, 'P4G'),
        h('h1', null, 'Persona 4 Golden Save Tool'),
        h('p', null, 'Edit file save P4G (.bin) langsung dari ponsel: stats, persona, inventory, social link, compendium, dan lainnya.'),
        h('button', { class: 'btn accent', onclick: doOpen }, 'Buka file save'),
        h('p', { class: 'hint' }, 'Save Switch: pilih data0001.bin dan data0001.binslot sekaligus agar checksum ikut diperbarui.'),
        h('p', { class: 'hint' }, 'Selalu simpan salinan cadangan file save aslimu sebelum mengedit.')));
      return;
    }
    TABS.forEach(([key, label, fn]) => navEl.append(h('button', { class: key === tab ? 'on' : '', onclick: () => { tab = key; render(); mainEl.scrollTop = 0; }, html: ICONS[key] + '<span>' + label + '</span>' })));
    const t = TABS.find((x) => x[0] === tab);
    mainEl.append(t[2]());
    mainEl.scrollTop = scroll;
  }

  function showAbout() {
    openSheet('Tentang', h('div', null,
      h('p', null, 'P4G Save Tool untuk Android. Port dari P4G Save Tool (WPF) oleh Jack P. Fenech (Fennec-kun), lisensi MIT.'),
      h('p', null, 'Aslinya ditulis oleh Fennec-kun dengan bantuan TGE, Shrinefox, dan Pan dari Amicitia. Dimungkinkan oleh HENkaku.'),
      h('p', { class: 'hint' }, 'Repo asli: github.com/Fennec-kun/P4G-Save-Tool')));
  }

  // --------------------------------------------------------------- file I/O
  const toB64 = (u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); };
  const fromB64 = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  function loadBytes(name, bytes, slot) {
    try {
      const parsed = P4G.parse(bytes);
      if (slot && !P4G.isBinslot(slot.bytes)) throw new Error('File ' + slot.name + ' bukan .binslot P4G.');
      S = parsed; orig = bytes; fileName = name; dirty = false;
      slotBytes = slot ? slot.bytes : null; slotName = slot ? slot.name : '';
      memberIdx = 0; slotIdx = 0; invFilter = ''; compFilter = ''; tab = 'stats';
      build();
      toast('Dibuka: ' + name + (slot ? ' + ' + slot.name : ''));
      if (!slot) setTimeout(() => toast('Save Switch? Pilih juga file .binslot saat membuka.'), 2400);
    } catch (e) {
      toast(e.message || String(e), true);
    }
  }
  /** files: [{name, bytes}] - one .bin plus an optional .binslot, in any order. */
  function loadFiles(files) {
    const slot = files.find((f) => /\.binslot$/i.test(f.name));
    const bin = files.find((f) => f !== slot);
    if (!bin) { toast('Pilih file save .bin (dan .binslot untuk Switch).', true); return; }
    loadBytes(bin.name, bin.bytes, slot);
  }
  async function doOpen() {
    if (dirty && !(await confirmDialog('Ada perubahan yang belum disimpan. Buka file lain dan buang perubahan?', 'Buka', true))) return;
    if (bridge) bridge.openFile();
    else {
      const inp = h('input', { type: 'file', multiple: true });
      inp.addEventListener('change', async () => {
        const files = [];
        for (const f of inp.files) files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        if (files.length) loadFiles(files);
      });
      inp.click();
    }
  }
  function currentBytes() { return P4G.serialize(S, orig); }
  function currentSlot(bin) { return slotBytes ? P4G.patchBinslot(slotBytes, bin) : null; }
  function download(name, bytes) {
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), download: name });
    document.body.append(a); a.click(); a.remove();
  }
  async function doSave() {
    if (!S) return;
    if (!bridge) return doSaveAs();
    const names = fileName + (slotBytes ? ' dan ' + slotName : '');
    if (!(await confirmDialog('Timpa ' + names + ' dengan perubahan ini? Cadangan otomatis disimpan di folder aplikasi.', 'Simpan'))) return;
    const out = currentBytes(), slot = currentSlot(out);
    pendingBytes = out; pendingSlot = slot;
    bridge.saveFile(toB64(out), slot ? toB64(slot) : '');
  }
  function doSaveAs() {
    if (!S) return;
    const out = currentBytes(), slot = currentSlot(out);
    if (bridge) { pendingBytes = out; pendingSlot = slot; bridge.saveFileAs(fileName || 'save.bin', toB64(out), slotName, slot ? toB64(slot) : ''); }
    else {
      download(fileName || 'save.bin', out);
      if (slot) setTimeout(() => download(slotName, slot), 400);
      orig = out; if (slot) slotBytes = slot; dirty = false; updateTopbar(); toast('File diunduh');
    }
  }
  let pendingBytes = null, pendingSlot = null;

  // callbacks invoked by the Android host
  window.__onFilesOpened = (arr) => loadFiles(arr.map((f) => ({ name: f.name, bytes: fromB64(f.b64) })));
  window.__onSaved = (name) => { if (pendingBytes) { orig = pendingBytes; pendingBytes = null; } if (pendingSlot) { slotBytes = pendingSlot; pendingSlot = null; } if (name) fileName = name; dirty = false; updateTopbar(); toast('Tersimpan: ' + fileName); };
  window.__onError = (msg) => { pendingBytes = null; pendingSlot = null; toast(msg, true); };
  window.__back = () => {
    if (menuEl) { toggleMenu(); return 'handled'; }
    if (modals.length) { modals[modals.length - 1].close(); return 'handled'; }
    if (dirty) {
      confirmDialog('Ada perubahan yang belum disimpan. Keluar dari aplikasi?', 'Keluar', true).then((ok) => { if (ok && bridge) bridge.exitApp(); });
      return 'handled';
    }
    return 'exit';
  };
  window.__p4g = { get state() { return S; }, loadBytes, currentBytes }; // debug / testing hook

  build();
})();
