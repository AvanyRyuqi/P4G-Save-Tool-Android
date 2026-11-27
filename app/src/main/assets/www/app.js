/* P4G Save Tool - UI layer (mobile). Logic lives in p4g-core.js */
(function () {
  'use strict';
  const DB = window.P4G_DB;
  const CAT = P4G.buildCatalog(DB);
  const PK = P4GPersona.create(window.P4G_PERSONA_DATA, DB, P4G.xpForLevel);
  const bridge = window.AndroidBridge || null;
  const STR = window.P4G_I18N;
  let lang = 'id';
  try { const l = localStorage.getItem('p4g-lang'); if (STR[l]) lang = l; } catch (e) { /* storage unavailable */ }
  /** Translate a key; {name} placeholders are filled from vars. Falls back to English, then the key. */
  const t = (key, vars) => {
    let str = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
    if (vars) for (const k in vars) str = str.split('{' + k + '}').join(vars[k] == null ? '' : vars[k]);
    return str;
  };
  function setLang(l) {
    if (!STR[l] || l === lang) return;
    lang = l;
    try { localStorage.setItem('p4g-lang', l); } catch (e) { /* ignore */ }
    document.documentElement.lang = l;
    build();
  }
  document.documentElement.lang = lang;

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

  // ---- preferences (theme, text size, auto XP)
  const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
  const autoXp = () => pref('p4g-autoxp', '0') === '1';
  function applyDisplay() {
    let th = pref('p4g-theme', 'tv');
    if (th === 'auto') th = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'tv' : 'midnight';
    document.documentElement.setAttribute('data-theme', th);
    document.documentElement.setAttribute('data-skin', th === 'tv' || th === 'midnight' ? 'tv' : 'classic');
    document.documentElement.style.setProperty('--fz', { small: '0.9', normal: '1', large: '1.2' }[pref('p4g-fs', 'normal')] || '1');
  }
  applyDisplay();

  // ---- undo / redo history (snapshots of the parsed save, committed shortly after the last edit)
  function deepClone(o) {
    if (o == null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(deepClone);
    const r = {}; for (const k in o) r[k] = deepClone(o[k]);
    return r;
  }
  const sigOf = (o) => JSON.stringify(o);
  let hist = [], histSig = [], hi = -1, snapTimer = null, savedSig = null, base = null;
  let compareMode = false;      // false | 'diff' | 'hex'
  let sandboxBase = null;       // non-null while the what-if sandbox is active
  // ---- draft autosave: unsaved edits survive the app being closed / killed
  const DRAFT_KEY = 'p4g-draft';
  function readDraft() { try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return d && d.bin ? d : null; } catch (e) { return null; } }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }
  function syncDraft() {
    if (!S) return;
    if (!dirty) { clearDraft(); return; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: fileName, slotName, bin: toB64(currentBytes()), slot: slotBytes ? toB64(slotBytes) : null, t: Date.now() })); } catch (e) { /* storage full / unavailable */ }
  }
  function resetHistory() {
    clearTimeout(snapTimer); snapTimer = null;
    hist = [deepClone(S)]; histSig = [sigOf(S)]; hi = 0; savedSig = histSig[0]; base = deepClone(S);
  }
  function commitSnap() {
    clearTimeout(snapTimer); snapTimer = null;
    if (!S) return;
    const sg = sigOf(S);
    if (sg === histSig[hi]) return;
    hist.length = hi + 1; histSig.length = hi + 1;
    hist.push(deepClone(S)); histSig.push(sg);
    if (hist.length > 80) { hist.shift(); histSig.shift(); }
    hi = hist.length - 1;
    dirty = sg !== savedSig; updateTopbar(); syncDraft();
  }
  function markDirty() {
    dirty = true; updateTopbar();
    clearTimeout(snapTimer); snapTimer = setTimeout(commitSnap, 400);
  }
  function gotoHist(i) {
    hi = i; S = deepClone(hist[hi]);
    dirty = histSig[hi] !== savedSig; updateTopbar(); syncDraft(); render();
  }
  function undo() { commitSnap(); if (hi <= 0) return toast(t('nothing_undo')); gotoHist(hi - 1); toast(t('undone')); }
  function redo() { commitSnap(); if (hi >= hist.length - 1) return toast(t('nothing_redo')); gotoHist(hi + 1); toast(t('redone')); }
  async function discardChanges() {
    commitSnap();
    if (!(await confirmDialog(t('reset_q'), t('reset_btn'), true))) return;
    S = deepClone(base); commitSnap(); gotoHist(hi); toast(t('reset_done'));
  }
  function toast(msg, err) {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
    const box = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    document.body.append(box);
    setTimeout(() => box.remove(), err ? 4500 : 2200);
  }

  // ------------------------------------------------------------ modal stack
  const modals = [];
  function openSheet(title, bodyEl, opts) {
    opts = opts || {};
    const scrim = h('div', { class: 'scrim' });
    const close = () => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); if (opts.onClose) opts.onClose(); };
    const sheet = h('div', { class: 'sheet' + (opts.full ? ' full' : '') },
      h('header', null, h('h4', null, title), h('button', { class: 'iconbtn', onclick: close, 'aria-label': t('close') }, '✕')),
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
          h('button', { class: 'btn', onclick: () => done(false) }, t('cancel')),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'accent'), onclick: () => done(true) }, okLabel || t('ok')))));
      modals.push(entry);
      document.body.append(scrim);
    });
  }

  function promptNumber(message, hint, def, min, max, okLabel) {
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim center' });
      const entry = { close: () => done(undefined) };
      const done = (v) => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); resolve(v); };
      const inp = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: String(def), class: 'num', style: 'max-width:none;margin-bottom:10px' });
      const go = () => { const n = parseInt(inp.value, 10); done(clamp(Number.isFinite(n) ? n : def, min, max)); };
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      scrim.append(h('div', { class: 'dialog' }, h('p', null, message), inp, hint ? h('p', { class: 'hint', style: 'margin-top:0' }, hint) : null,
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => done(undefined) }, t('cancel')),
          h('button', { class: 'btn accent', onclick: go }, okLabel || t('ok')))));
      modals.push(entry);
      document.body.append(scrim);
    });
  }

  function promptText(message, def, okLabel) {
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim center' });
      const entry = { close: () => done(undefined) };
      const done = (v) => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); resolve(v); };
      const inp = h('input', { type: 'text', value: def || '', autocomplete: 'off', style: 'margin-bottom:12px' });
      const go = () => { const v = inp.value.trim(); done(v || undefined); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      scrim.append(h('div', { class: 'dialog' }, h('p', null, message), inp,
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => done(undefined) }, t('cancel')),
          h('button', { class: 'btn accent', onclick: go }, okLabel || t('ok')))));
      modals.push(entry);
      document.body.append(scrim);
      setTimeout(() => inp.focus(), 50);
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
      const search = h('input', { type: 'text', placeholder: t('search_ph'), autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' });
      const clear = h('button', { class: 'clearbtn', type: 'button', 'aria-label': t('clear_search'), hidden: true, onclick: () => { search.value = ''; limit = PAGE; render(); search.focus(); } }, '✕');
      const bar = h('div', { class: 'searchbar' }, h('div', { class: 'searchwrap' }, search, clear), count);
      const lower = options.map((o) => o.name.toLowerCase());
      const matches = () => {
        const tokens = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (!tokens.length) return options;
        const hit = [];
        options.forEach((o, i) => {
          const n = lower[i], id = String(o.id);
          if (tokens.every((w) => n.includes(w) || id === w.replace(/^#/, '') || (/^#?\d+$/.test(w) && id.startsWith(w.replace(/^#/, ''))))) hit.push([n.startsWith(tokens[0]) ? 0 : 1, i]);
        });
        return hit.sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => options[x[1]]); // prefix matches first
      };
      const render = () => {
        const res = matches();
        clear.hidden = !search.value;
        count.textContent = search.value.trim() ? t('n_results', { n: res.length }) : t('n_options', { n: options.length });
        list.replaceChildren();
        res.slice(0, limit).forEach((o) => {
          const opt = h('button', { class: 'opt' + (o.id === currentId ? ' on' : ''), onclick: () => { chosen = o.id; handle.close(); } },
            h('span', null, o.name, o.desc ? h('small', { class: 'desc' }, o.desc) : null), h('small', null, o.sub != null ? o.sub : '#' + o.id));
          // ⓘ sits next to the option (not inside it) so reading the details never selects anything
          list.append(o.info ? h('div', { class: 'optrow' }, opt, infoButton(o.name, o.info)) : opt);
        });
        if (res.length > limit) list.append(h('button', { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => { limit += PAGE; render(); } }, t('show_more', { n: res.length - limit })));
        if (!res.length) list.append(h('p', { class: 'empty' }, t('no_results_for', { q: search.value.trim() })));
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

  // ---------------------------------------------------------------- skill info
  const SKILL_INFO = window.P4G_SKILL_INFO || {};
  const SKILL_ELEMS = { phy: 'Phys', fir: 'Fire', ice: 'Ice', ele: 'Elec', win: 'Wind', lig: 'Light', dar: 'Dark', alm: 'Almighty',
    ail: 'Ailment', rec: 'Recovery', sup: 'Support', spe: 'Special', pas: 'Passive' };
  const skillElem = (s) => SKILL_ELEMS[s.e] || s.e;
  /** One-line description, e.g. "Fire · 4 SP · 1 foe · √40 pwr". Empty when there is no data. */
  function skillSummary(id) {
    const s = SKILL_INFO[id];
    return s ? [skillElem(s), s.c, s.e === 'pas' ? '' : s.t, s.d].filter(Boolean).join(' · ') : '';
  }
  function showSkillInfo(id) {
    const s = SKILL_INFO[id];
    if (!s) return;
    const line = (label, value) => value ? row(label, h('span', null, value)) : null;
    const how = (lv) => lv === 0 ? t('sk_innate') : typeof lv === 'number' ? 'Lv ' + lv : t('sk_special', { code: lv });
    openSheet(DB.allSkills[id], h('div', null,
      line(t('sk_elem'), skillElem(s)), line(t('sk_cost'), s.c || (s.e === 'pas' ? t('sk_passive') : '')),
      line(t('sk_target'), s.e === 'pas' ? '' : s.t), line(t('sk_effect'), s.d || t('sk_no_effect')),
      line(t('sk_card'), s.k),
      h('p', { class: 'hint', style: 'margin:14px 0 4px;color:var(--accent)' }, t('sk_learned')),
      s.l ? s.l.map(([name, lv]) => h('div', { class: 'learn' }, h('span', null, name), h('small', null, how(lv))))
        : h('p', { class: 'hint' }, t('sk_learned_none')),
      h('p', { class: 'hint', style: 'margin-top:14px' }, t('sk_source'))), { full: true });
  }
  function infoButton(name, open) {
    return h('button', { class: 'infobtn', type: 'button', 'aria-label': t('sk_info', { name }), onclick: open }, 'ⓘ');
  }
  const skillOptions = () => CAT.skills.map((o) => SKILL_INFO[o.id]
    ? Object.assign({ desc: skillSummary(o.id), info: () => showSkillInfo(o.id) }, o) : o);

  /** Skill selector with a summary line and an ⓘ button for the chosen skill. */
  function skillField(options, get, set, title) {
    const desc = h('p', { class: 'skilldesc' });
    const info = infoButton(title, () => showSkillInfo(get()));
    const paint = () => { desc.textContent = skillSummary(get()); desc.hidden = !desc.textContent; info.disabled = !SKILL_INFO[get()]; info.setAttribute('aria-label', t('sk_info', { name: DB.allSkills[get()] || title })); };
    const sel = selectField(options, get, (id) => { set(id); paint(); }, title);
    paint();
    return h('div', null, row(title, h('div', { class: 'skillpick' }, sel, info)), desc);
  }

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
      const r = await pick(title || t('choose'), withUnknown(options, id), id);
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
    const num = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', class: 'num sv', value: String(get()), 'aria-label': label });
    const r = h('input', { type: 'range', min, max, step: 1, value: clamp(get(), min, max) });
    const paint = (v) => { num.classList.toggle('warn', warnOver != null && v > warnOver); };
    const commit = (v) => { set(v); markDirty(); paint(v); };
    r.addEventListener('input', () => { num.value = r.value; commit(+r.value); });
    num.addEventListener('focus', () => num.select());
    // live-commit while typing, but only for complete in-range values
    num.addEventListener('input', () => {
      const digits = num.value.replace(/\D/g, '');
      if (digits !== num.value) num.value = digits;
      if (digits === '') return;
      const n = parseInt(digits, 10);
      if (n >= min && n <= max) { r.value = n; commit(n); }
    });
    // on blur/enter: clamp & normalize
    num.addEventListener('change', () => {
      const n = parseInt(num.value, 10);
      const v = clamp(Number.isFinite(n) ? n : get(), min, max);
      num.value = String(v); r.value = v;
      if (v !== get()) commit(v); else paint(v);
    });
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') num.blur(); });
    paint(get());
    return h('div', { class: 'sliderrow' }, h('span', { class: 'lbl' }, label), r, num);
  }
  const row = (label, ctl, hint) => h('div', { class: 'row' }, h('label', null, label), h('div', { class: 'grow' }, ctl));
  const card = (title, ...kids) => h('div', { class: 'card' }, title ? h('h3', null, title) : null, kids);

  // --------------------------------------------------------- persona editor
  function personaEditor(p, opts) {
    const el = h('div');
    const refresh = () => { el.replaceChildren(); build(); };
    function build() {
      const aff = affinityBox(p);
      if (opts.idPicker) {
        el.append(row(t('persona'), selectField(CAT.personae, () => p.id, (id) => {
          const wasBlank = p.id === 0;
          p.id = id;
          if (p.level === 0 && id !== 0 && !p.exists) p.level = 1;
          p.exists = id !== 0;
          opts.onIdChange && opts.onIdChange();
          if (PK.defaults(id)) offerDefaults(p, id, wasBlank);
        }, t('persona'))));
      }
      el.append(aff.el);
      let xpInput = null;
      el.append(slider('Lv', () => p.level, (v) => {
        p.level = v;
        if (autoXp()) { p.totalxp = P4G.xpForLevel(v); if (xpInput) xpInput.value = String(p.totalxp); }
      }, 1, 255, 99));
      xpInput = numField(() => p.totalxp, (v) => { p.totalxp = v; }, 0, 4294967295);
      xpInput.style.maxWidth = 'none';
      el.append(h('div', { class: 'row' }, h('label', null, t('total_xp')), h('div', { class: 'grow' }, xpInput),
        h('button', { class: 'btn small', onclick: () => { p.totalxp = P4G.xpForLevel(p.level); xpInput.value = String(p.totalxp); markDirty(); } }, t('from_level'))));
      [['ST', 'st'], ['MA', 'ma'], ['DE', 'de'], ['AG', 'ag'], ['LU', 'lu']].forEach(([lbl, k]) =>
        el.append(slider(lbl, () => p[k], (v) => { p[k] = v; }, 0, 255)));
      el.append(h('p', { class: 'hint' }, t('skill')));
      const options = skillOptions();
      for (let i = 0; i < 8; i++) {
        el.append(skillField(options, () => p.skills[i], (id) => { p.skills[i] = id; aff.paint(); }, t('skill_n', { n: i + 1 })));
      }
      el.append(h('div', { class: 'toolbar', style: 'margin-top:10px;flex-wrap:wrap' },
        PK.defaults(p.id) ? h('button', { class: 'btn small', onclick: () => refillDefaults(p, refresh) }, t('pd_refill')) : null,
        PK.canFuse(p.id) ? h('button', { class: 'btn small', onclick: () => showFusion(p.id) }, t('fu_for_this')) : null,
        h('button', { class: 'btn small', onclick: () => copyPersona(p) }, t('copy_to')),
        h('button', { class: 'btn small', onclick: () => { p.skills = [0, 0, 0, 0, 0, 0, 0, 0]; markDirty(); refresh(); } }, t('clear_skills')),
        h('button', { class: 'btn small', onclick: () => personaExchange(p, opts, refresh) }, t('export_import'))));
    }
    build();
    return el;
  }

  // ---- default level / stats / skills
  /** After a Persona was picked: an empty slot is filled at once, a used one only if confirmed. */
  async function offerDefaults(p, id, wasBlank) {
    if (!wasBlank && !(await confirmDialog(t('pd_fill_q', { name: personaName(id), lv: PK.defaults(id).level }), t('pd_fill_yes')))) return;
    if (p.id !== id) return;
    PK.applyDefaults(p, id);
    markDirty(); commitSnap(); render();
  }
  async function refillDefaults(p, refresh) {
    const baseLv = PK.defaults(p.id).level;
    const lv = await promptNumber(t('pd_level_q', { name: personaName(p.id) }), t('pd_level_hint', { lv: baseLv }), clamp(p.level, baseLv, 99), baseLv, 99, t('pd_fill_yes'));
    if (lv === undefined) return;
    PK.applyDefaults(p, p.id, lv);
    markDirty(); commitSnap(); refresh(); toast(t('pd_done'));
  }

  // ---- element affinities
  const AFF_LABEL = { w: 'Wk', '-': '–', S: '½', s: 'Str', n: 'Nul', r: 'Rpl', d: 'Drn' };
  const affClass = (code) => 'a-' + (code === '-' ? 'none' : code === 'S' ? 'half' : code);
  const affCell = (c, tag) => h(tag || 'span', { class: 'ac ' + affClass(c.code) }, AFF_LABEL[c.code] + (c.skill ? '*' : ''));
  /** The eight affinities of one Persona (base data plus passive skills). */
  function affinityBox(p) {
    const el = h('div', { class: 'affbox' });
    const paint = () => {
      const cells = p.id ? PK.affinities(p.id, p.skills) : null;
      el.hidden = !cells;
      el.replaceChildren();
      if (!cells) return;
      el.append(h('div', { class: 'aff' }, cells.map((c) => h('div', null, h('small', null, c.elem === 'alm' ? 'Alm.' : SKILL_ELEMS[c.elem]), affCell(c)))));
      if (cells.some((c) => c.skill)) el.append(h('p', { class: 'hint' }, t('el_from_skill')));
    };
    paint();
    return { el, paint };
  }

  /** Affinity table for the protagonist's chosen Persona and the three active party members. */
  function showTeam() {
    if (!S) return;
    const filled = S.mcSlots.map((p, i) => ({ p, i })).filter((x) => x.p.id);
    let lead = filled.some((x) => x.i === slotIdx) ? slotIdx : (filled.length ? filled[0].i : 0);
    const body = h('div');
    const paint = () => {
      const team = [{ who: protagName(), p: S.mcSlots[lead] }];
      // party byte: 2 = Yosuke ... 8 = Teddie, one more than the member index in the file
      S.party.forEach((v) => { const i = v - 1; if (i >= 1 && i < S.memberPersona.length) team.push({ who: DB.party[i], p: S.memberPersona[i] }); });
      team.forEach((m) => { m.cells = m.p && m.p.id ? PK.affinities(m.p.id, m.p.skills) : null; });
      const sum = PK.teamSummary(team.map((m) => m.cells));
      body.replaceChildren(h('p', { class: 'hint', style: 'margin-top:0' }, t('el_team_hint')));
      if (filled.length) body.append(h('div', { class: 'chips' }, filled.map((x) => h('button', { class: 'chip' + (x.i === lead ? ' on' : ''), onclick: () => { lead = x.i; paint(); } }, personaName(x.p.id)))));
      body.append(h('table', { class: 'team' },
        h('tr', null, h('th'), team.map((m) => h('th', null, m.who.split(' ')[0], h('small', null, m.p && m.p.id ? personaName(m.p.id) : '—'))), h('th', null, t('el_weak_n'))),
        sum.map((x, e) => h('tr', { class: x.weak >= 2 || (x.weak && !x.guard) ? 'risk' : '' }, h('th', null, SKILL_ELEMS[x.elem]),
          team.map((m) => m.cells ? affCell(m.cells[e], 'td') : h('td', { class: 'ac' }, '?')),
          h('td', { class: 'ac' }, String(x.weak))))),
        h('p', { class: 'hint' }, t('el_legend')), h('p', { class: 'hint' }, t('el_note')));
    };
    paint();
    openSheet(t('el_team'), body, { full: true });
  }

  // ---- fusion calculator (read-only)
  function showFusion(startId) {
    if (!S) return;
    let target = PK.canFuse(startId) ? startId : 0, mode = 'pairs', ownedOnly = false, query = '', limit = 50;
    const back = [];
    const cache = {};
    const head = h('div'), list = h('div', { class: 'list' });
    const inSlots = new Set(S.mcSlots.map((p) => p.id).filter(Boolean)), inComp = new Set(S.compendium.map((p) => p.id));
    const owned = new Set([...inSlots, ...inComp]);
    const label = (id) => { const b = PK.base(id); return b.race + ' · Lv ' + b.lvl; };
    const get = () => {
      const key = target + mode;
      if (!cache[key]) { const r = PK.recipes(target, { triple: mode === 'triples' }); cache[key] = { special: r.special, list: PK.rank(r.special ? [r.special] : r[mode], owned) }; }
      return cache[key];
    };
    const go = (id) => { target = id; limit = 50; query = ''; paintHead(); paintList(); };
    const ingredient = (id) => h('button', { class: 'ing' + (owned.has(id) ? ' have' : ''), onclick: () => { back.push(target); go(id); } },
      h('b', null, (inSlots.has(id) ? '● ' : inComp.has(id) ? '◆ ' : '') + personaName(id)), h('small', null, label(id)));
    function paintList() {
      list.replaceChildren();
      if (!target) return;
      const r = get();
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hit = r.list.filter((x) => (!ownedOnly || x.missing === 0)
        && words.every((w) => x.ids.some((id) => personaName(id).toLowerCase().includes(w))));
      list.append(h('p', { class: 'hint' }, t('fu_count', { n: hit.length })));
      hit.slice(0, limit).forEach((x) => list.append(h('div', { class: 'recipe' }, x.ids.map(ingredient),
        h('small', { class: 'miss' + (x.missing ? '' : ' ok') }, x.missing ? t('fu_missing', { n: x.missing }) : t('fu_ready')))));
      if (hit.length > limit) list.append(h('button', { class: 'btn', onclick: () => { limit += 50; paintList(); } }, t('show_more', { n: hit.length - limit })));
      if (!hit.length) list.append(h('p', { class: 'empty' }, r.list.length ? t('fu_no_match') : t(mode === 'pairs' ? 'fu_none_pairs' : 'fu_none_triples')));
    }
    function paintHead() {
      head.replaceChildren();
      const choose = h('button', { class: 'select', type: 'button', onclick: async () => {
        const id = await pick(t('fu_pick'), PK.targets().map((x) => ({ id: x, name: personaName(x), sub: label(x) })), target);
        if (id !== undefined && id !== target) { back.length = 0; go(id); }
      } }, h('span', { class: 'v' }, target ? personaName(target) : t('fu_pick')));
      if (back.length) head.append(h('button', { class: 'btn small', style: 'margin-bottom:8px', onclick: () => go(back.pop()) }, '‹ ' + personaName(back[back.length - 1])));
      head.append(choose);
      if (!target) { head.append(h('p', { class: 'hint' }, t('fu_intro'))); return; }
      const special = !!get().special;
      head.append(h('p', { class: 'hint' }, label(target)));
      if (PK.unlock(target)) head.append(h('p', { class: 'hint' }, t('fu_unlock', { c: PK.unlock(target) })));
      if (PK.base(target).lvl > S.mcLevel) head.append(h('p', { class: 'hint warn' }, t('fu_level', { lv: S.mcLevel })));
      if (special) head.append(h('p', { class: 'hint' }, t('fu_special')));
      else head.append(h('div', { class: 'chips', style: 'margin-top:10px' }, [['pairs', 'fu_two'], ['triples', 'fu_three']].map(([m, k]) =>
        h('button', { class: 'chip' + (mode === m ? ' on' : ''), onclick: () => { mode = m; limit = 50; paintHead(); paintList(); } }, t(k)))));
      if (!special) {
        const search = h('input', { type: 'text', class: 'search', placeholder: t('fu_search'), value: query, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
        search.addEventListener('input', () => { query = search.value; limit = 50; paintList(); });
        const box = h('input', { type: 'checkbox' });
        box.checked = ownedOnly;
        box.addEventListener('change', () => { ownedOnly = box.checked; limit = 50; paintList(); });
        head.append(search, h('label', { class: 'check' }, box, t('fu_owned_only')));
      }
      head.append(h('p', { class: 'hint' }, t('fu_legend')));
    }
    paintHead(); paintList();
    openSheet(t('fu_title'), h('div', null, head, list), { full: true });
  }

  /** Every place a Persona can be copied to: protagonist slots and party members. */
  async function copyPersona(src) {
    const targets = [];
    S.mcSlots.forEach((p, i) => { if (p !== src) targets.push({ id: i, name: t('slot_n', { n: i + 1 }) + ' – ' + protagName(), sub: p.id ? personaName(p.id) + ' Lv ' + p.level : 'Blank', obj: p }); });
    for (let i = 1; i < S.memberPersona.length; i++) {
      const p = S.memberPersona[i];
      if (p && p !== src) targets.push({ id: 100 + i, name: memberName(i), sub: p.id ? personaName(p.id) + ' Lv ' + p.level : 'Blank', obj: p });
    }
    const id = await pick(t('copy_title'), targets);
    if (id === undefined) return;
    const target = targets.find((x) => x.id === id);
    if (target.obj.id !== 0 && !(await confirmDialog(t('copy_overwrite_q', { name: target.name + ' (' + personaName(target.obj.id) + ')' }), t('ok'), true))) return;
    Object.assign(target.obj, deepClone(src));
    markDirty(); commitSnap(); render(); toast(t('copied_to'));
  }

  /** Text export / import of a single Persona (copy & paste friendly, no files needed). */
  function personaExchange(p, opts, refresh) {
    const dump = () => JSON.stringify({ p4g: 1, id: p.id, level: p.level, totalxp: p.totalxp, skills: p.skills, st: p.st, ma: p.ma, de: p.de, ag: p.ag, lu: p.lu });
    const ta = h('textarea', { rows: 7, spellcheck: 'false', autocapitalize: 'none', class: 'ta' });
    ta.value = dump();
    const copy = async () => {
      ta.focus(); ta.select();
      let ok = false;
      try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { try { ok = document.execCommand('copy'); } catch (e2) { /* manual copy */ } }
      if (ok) toast(t('ei_copied'));
    };
    const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    const validObj = (o) => o && typeof o === 'object' && inRange(o.id, 0, 65535) && inRange(o.level, 0, 255) && inRange(o.totalxp, 0, 4294967295)
      && Array.isArray(o.skills) && o.skills.length === 8 && o.skills.every((x) => inRange(x, 0, 65535))
      && ['st', 'ma', 'de', 'ag', 'lu'].every((k) => inRange(o[k], 0, 255));
    const applyObj = (o) => {
      if (!validObj(o)) { toast(t('ei_bad'), true); return; }
      if (opts.idPicker) { p.id = o.id; p.exists = o.id !== 0; }
      p.level = o.level; p.totalxp = o.totalxp; p.skills = o.skills.slice();
      ['st', 'ma', 'de', 'ag', 'lu'].forEach((k) => { p[k] = o[k]; });
      markDirty(); commitSnap(); handle.close(); refresh(); if (opts.onIdChange) opts.onIdChange(); toast(t('ei_applied'));
    };
    const apply = () => { let o; try { o = JSON.parse(ta.value); } catch (e) { o = null; } applyObj(o); };

    const builds = () => { try { const b = JSON.parse(localStorage.getItem('p4g-builds') || '[]'); return Array.isArray(b) ? b.filter((x) => x && x.name && validObj(x.data)) : []; } catch (e) { return []; } };
    const putBuilds = (b) => { try { localStorage.setItem('p4g-builds', JSON.stringify(b)); } catch (e) { /* ignore */ } };
    const buildList = h('div', { class: 'list' });
    const paintBuilds = () => {
      buildList.replaceChildren();
      const all = builds();
      if (!all.length) { buildList.append(h('p', { class: 'hint' }, t('build_none'))); return; }
      all.forEach((b, i) => buildList.append(h('div', { class: 'item' },
        h('div', { class: 'name' }, h('b', null, b.name), h('small', null, personaName(b.data.id) + ' Lv ' + b.data.level)),
        h('button', { class: 'btn small', onclick: () => applyObj(b.data) }, t('build_apply')),
        h('button', { class: 'btn small danger', onclick: () => { const x = builds(); x.splice(i, 1); putBuilds(x); paintBuilds(); toast(t('build_deleted')); } }, t('delete')))));
    };
    const saveBuild = async () => {
      const name = await promptText(t('build_name_q'), personaName(p.id) + ' Lv' + p.level, t('save'));
      if (!name) return;
      const x = builds(); x.push({ name, data: JSON.parse(dump()) }); putBuilds(x); paintBuilds(); toast(t('build_saved'));
    };
    const canShare = bridge && bridge.shareText;
    const handle = openSheet(t('ei_title'), h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, t('ei_hint')), ta,
      h('div', { class: 'toolbar', style: 'margin-top:10px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: copy }, t('ei_copy')),
        canShare ? h('button', { class: 'btn', onclick: () => bridge.shareText(ta.value) }, t('share')) : null,
        h('button', { class: 'btn accent', onclick: apply }, t('ei_apply'))),
      h('h3', { style: 'margin:16px 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)' }, t('builds')),
      h('button', { class: 'btn', style: 'width:100%;margin-bottom:10px', onclick: saveBuild }, t('build_save')),
      buildList));
    paintBuilds();
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
      const mcXpInput = numField(() => S.mcXp, (v) => { S.mcXp = v; }, 0, 4294967295);
      wrap.append(card(t('protagonist'),
        row(t('yen'), numField(() => S.yen, (v) => { S.yen = v; }, 0, 4294967295)),
        slider('Lv', () => S.mcLevel, (v) => {
          S.mcLevel = v;
          if (autoXp()) { S.mcXp = P4G.xpForLevel(v); mcXpInput.value = String(S.mcXp); }
        }, 1, 255, 99),
        h('div', { class: 'row' }, h('label', null, t('total_xp')), h('div', { class: 'grow' }, mcXpInput),
          h('button', { class: 'btn small', onclick: () => { S.mcXp = P4G.xpForLevel(S.mcLevel); mcXpInput.value = String(S.mcXp); markDirty(); } }, t('from_level')))));
    }

    // persona
    let p;
    const slotRow = [];
    if (memberIdx === 0) {
      const chipsSlot = h('div', { class: 'chips' });
      for (let i = 0; i < 12; i++) chipsSlot.append(h('button', { class: 'chip' + (i === slotIdx ? ' on' : ''), onclick: () => { slotIdx = i; render(); } }, t('slot_n', { n: i + 1 })));
      slotRow.push(chipsSlot);
      p = S.mcSlots[slotIdx];
    } else {
      p = S.memberPersona[memberIdx];
    }
    wrap.append(card(t('persona'), slotRow, personaEditor(p, { idPicker: true, onIdChange: render })));

    // equipment
    const eq = CAT.members[memberIdx].equipId;
    if (memberIdx === 4) {
      wrap.append(card(t('equipment'), h('p', { class: 'hint' }, t('rise_no_equip'))));
    } else {
      const wl = CAT.weaponsByMember[eq];
      wrap.append(card(t('equipment'),
        row(t('weapon'), selectField(wl, () => S.equip.weapon[eq], (id) => { S.equip.weapon[eq] = id; }, t('weapon'))),
        row(t('armor'), selectField(CAT.armor, () => S.equip.armor[eq], (id) => { S.equip.armor[eq] = id; }, t('armor'))),
        row(t('accessory'), selectField(CAT.accessories, () => S.equip.accessory[eq], (id) => { S.equip.accessory[eq] = id; }, t('accessory'))),
        row(t('costume'), selectField(CAT.costumes, () => S.equip.costume[eq], (id) => { S.equip.costume[eq] = id; }, t('costume')))));
    }

    if (memberIdx === 0) {
      // social stats
      const sc = card(t('social_stats'));
      CAT.statNames.forEach((nm, st) => {
        const lvls = CAT.statLevels[st].map((n, i) => ({ id: i + 1, name: n, sub: 'Lv ' + (i + 1) }));
        const pts = h('small', { class: 'hint' });
        const paint = () => { pts.textContent = t('points', { n: S.socialStats[st] }); };
        const sel = selectField(lvls, () => P4G.pointsToLevel(st, S.socialStats[st]),
          (lv) => { S.socialStats[st] = P4G.levelToPoints(st, lv); paint(); }, nm);
        paint();
        sc.append(row(nm, sel), h('div', { style: 'margin:-4px 0 6px 106px' }, pts));
      });
      // party config
      wrap.append(sc, card(t('party_config'), [0, 1, 2].map((i) =>
        row(t('member_n', { n: i + 1 }), selectField(CAT.partyChoices, () => S.party[i], (id) => { S.party[i] = id; }, t('member_n', { n: i + 1 }))))));
    }
    return wrap;
  }

  function inventoryTab() {
    const wrap = h('div');
    const sec = CAT.sections[invSection];
    const chips = h('div', { class: 'chips' });
    CAT.sections.forEach((s, i) => chips.append(h('button', { class: 'chip' + (i === invSection ? ' on' : ''), onclick: () => { invSection = i; render(); } }, s.name)));
    wrap.append(chips);

    const search = h('input', { class: 'search', type: 'text', placeholder: t('inv_search'), value: invFilter });
    const listEl = h('div', { class: 'list' });
    const addBtn = h('button', { class: 'btn accent', onclick: async () => {
      const opts = sec.items.filter((i) => i.name !== 'Blank' && i.id !== 1792).map((i) => ({ id: i.id, name: i.name, sub: S.inventory[i.id] > 0 ? '×' + S.inventory[i.id] : '#' + i.id }));
      if (!opts.length) { toast(t('section_empty')); return; }
      const id = await pick(t('add_section_title', { s: sec.name }), opts);
      if (id === undefined) return;
      if (S.inventory[id] > 0) { toast(t('already_in_inv', { n: S.inventory[id] })); return; }
      S.inventory[id] = 1; markDirty(); invFilter = ''; renderList(); toast(t('added', { name: itemName(id) }));
    } }, t('add_section', { s: sec.name }));
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
          h('button', { class: 'iconbtn', 'aria-label': t('delete'), style: 'min-width:40px;height:40px;padding:0', onclick: () => { S.inventory[id] = 0; markDirty(); renderList(); } }, '🗑')));
      }
      if (!n) listEl.append(h('p', { class: 'empty' }, q ? t('no_results') : t('inv_empty')));
    }
    search.addEventListener('input', () => { invFilter = search.value; renderList(); });
    renderList();
    return wrap;
  }

  function socialTab() {
    const wrap = h('div');
    const add = h('button', { class: 'btn accent', onclick: async () => {
      if (S.socialLinks.length >= 23) { toast(t('max_links'), true); return; }
      const opts = CAT.socialLinkIDs.filter((x) => x.id !== 0 && !S.socialLinks.some((l) => l.id === x.id)).map((x) => ({ id: x.id, name: x.name, sub: x.arcana }));
      if (!opts.length) { toast(t('all_links_added')); return; }
      const id = await pick(t('add_link_title'), opts);
      if (id === undefined) return;
      S.socialLinks.push({ id, level: 1, progress: 0, flag: 0 }); markDirty(); render();
    } }, t('add_link'));
    wrap.append(h('div', { class: 'toolbar' }, add));
    if (!S.socialLinks.length) wrap.append(h('p', { class: 'empty' }, t('no_links')));
    S.socialLinks.forEach((l, idx) => {
      const info = CAT.socialLinkIDs.find((x) => x.id === l.id);
      wrap.append(h('div', { class: 'card' },
        h('div', { class: 'item', style: 'border:0;padding:0;margin-bottom:6px' },
          h('div', { class: 'name' }, h('b', null, info ? info.name : 'Unknown (' + l.id + ')'), h('small', null, info ? info.arcana : '#' + l.id)),
          h('button', { class: 'btn small danger', onclick: () => { S.socialLinks.splice(idx, 1); markDirty(); render(); } }, t('delete'))),
        row(t('level'), numField(() => l.level, (v) => { l.level = v; }, 0, 255)),
        row(t('progress'), numField(() => l.progress, (v) => { l.progress = v; }, 0, 255))));
    });
    return wrap;
  }

  function compendiumTab() {
    const wrap = h('div');
    const search = h('input', { class: 'search', type: 'text', placeholder: t('comp_search'), value: compFilter });
    const listEl = h('div', { class: 'list' });
    const openEditor = (pe) => {
      const handle = openSheet(personaName(pe.id) + '  (#' + pe.id + ')', h('div', null,
        personaEditor(pe, { idPicker: false }),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn danger', style: 'width:100%', onclick: () => {
          S.compendium.splice(S.compendium.indexOf(pe), 1); markDirty(); handle.close(); renderList();
        } }, t('comp_remove')))), { full: true, onClose: renderList });
    };
    const add = h('button', { class: 'btn accent', onclick: async () => {
      const opts = CAT.personae.filter((x) => x.id !== 0).map((x) => ({ id: x.id, name: x.name, sub: S.compendium.some((c) => c.id === x.id) ? t('registered') : '#' + x.id }));
      const id = await pick(t('comp_add_title'), opts);
      if (id === undefined) return;
      let pe = S.compendium.find((c) => c.id === id);
      if (!pe) {
        if (id > P4G.COMPENDIUM_COUNT) { toast(t('comp_bad_id'), true); return; }
        pe = P4G.newPersona(id); PK.applyDefaults(pe, id); S.compendium.push(pe); S.compendium.sort((a, b) => a.id - b.id); markDirty();
      }
      renderList(); openEditor(pe);
    } }, t('add'));
    const fill = h('button', { class: 'btn', onclick: async () => {
      const lv = await promptNumber(t('comp_fill_q'), t('comp_fill_hint'), 99, 1, 99, t('go'));
      if (lv === undefined) return;
      let n = 0;
      for (let id = 1; id <= P4G.COMPENDIUM_COUNT; id++) {
        if (!DB.personae[id] || DB.personae[id] === 'Blank' || S.compendium.some((c) => c.id === id)) continue;
        const pe = P4G.newPersona(id);
        if (!PK.applyDefaults(pe, id, lv)) { pe.level = lv; pe.totalxp = P4G.xpForLevel(lv); }
        S.compendium.push(pe); n++;
      }
      if (!n) { toast(t('comp_fill_none')); return; }
      S.compendium.sort((a, b) => a.id - b.id); markDirty(); commitSnap(); renderList(); toast(t('comp_filled', { n }));
    } }, t('comp_fill_all'));
    const clear = h('button', { class: 'btn danger', onclick: async () => {
      if (!S.compendium.length) return;
      if (await confirmDialog(t('comp_delete_all_q', { n: S.compendium.length }), t('delete_all'), true)) { S.compendium = []; markDirty(); renderList(); }
    } }, t('delete_all'));
    wrap.append(h('div', { class: 'toolbar' }, search), h('div', { class: 'toolbar' }, add, fill, clear), listEl);
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
      if (!n) listEl.append(h('p', { class: 'empty' }, q ? t('no_results') : t('comp_empty')));
    }
    search.addEventListener('input', () => { compFilter = search.value; renderList(); });
    renderList();
    return wrap;
  }

  function otherTab() {
    const phases = DB.phases.map((n, i) => ({ id: i, name: n }));
    const nameInput = (key) => {
      const i = h('input', { type: 'text', value: S[key], autocomplete: 'off' });
      i.addEventListener('input', () => {
        const clean = i.value.replace(/[^\x21-\x7e]/g, '').slice(0, 9);
        if (clean !== i.value) i.value = clean;
        S[key] = clean; markDirty();
      });
      return i;
    };
    return h('div', null,
      card(t('date'), row(t('day'), numField(() => S.day, (v) => { S.day = v; }, 0, 255)),
        row(t('phase'), selectField(phases, () => S.dayPhase, (v) => { S.dayPhase = v; }, t('phase'))),
        row(t('next_day'), numField(() => S.nextDay, (v) => { S.nextDay = v; }, 0, 255)),
        row(t('next_phase'), selectField(phases, () => S.nextDayPhase, (v) => { S.nextDayPhase = v; }, t('next_phase')))),
      card(t('hero_name'), row(t('first_name'), nameInput('firstname')), row(t('surname'), nameInput('surname')),
        h('p', { class: 'hint' }, t('name_hint'))));
  }

  // ----------------------------------------------------------- shell / chrome
  const ICONS = {
    stats: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    inv: '<svg viewBox="0 0 24 24"><path d="M4 8l8-4 8 4v10l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v10"/></svg>',
    social: '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 6-8 11-8 11z"/></svg>',
    comp: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
    other: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  };
  const TABS = [['stats', 'tab_stats', statsTab], ['inv', 'tab_inv', inventoryTab], ['social', 'tab_social', socialTab], ['comp', 'tab_comp', compendiumTab], ['other', 'tab_other', otherTab]];
  let mainEl, titleSub, saveBtn, navEl;

  function updateTopbar() {
    if (!titleSub) return;
    titleSub.textContent = S ? (sandboxBase ? t('sandbox_banner') + ' · ' : '') + (fileName || 'save') + ' · ' + (slotBytes ? t('fmt_switch') + ' + binslot' : t('fmt_bin')) + (dirty ? t('unsaved') : '') : t('no_file');
    titleSub.classList.toggle('dirty', !!(S && dirty));
    saveBtn.disabled = !S || !!sandboxBase;
  }

  function build() {
    root.replaceChildren();
    titleSub = h('span');
    saveBtn = h('button', { class: 'iconbtn primary', onclick: doSave }, t('save'));
    const top = h('div', { class: 'topbar' },
      h('div', { class: 'brand' }, h('b', null, 'P4G Save Tool'), titleSub),
      h('button', { class: 'iconbtn', onclick: doOpen }, t('open')), saveBtn,
      h('button', { class: 'iconbtn', 'aria-label': t('menu'), onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, '⋮'));
    mainEl = h('main');
    navEl = h('nav');
    root.append(top, mainEl, navEl);
    updateTopbar();
    render();
  }

  let menuEl = null;
  function toggleMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; return; }
    const m = (fn, label) => h('button', { onclick: () => { toggleMenu(); fn(); } }, label);
    menuEl = h('div', { class: 'menu' },
      S ? m(undo, t('undo')) : null, S ? m(redo, t('redo')) : null,
      S && dirty ? m(discardChanges, t('reset_changes')) : null,
      S ? m(showTools, t('tools')) : null,
      S ? m(showSearch, t('search_all')) : null,
      S ? m(showSummary, t('summary')) : null,
      S ? m(showPresets, t('presets')) : null,
      S ? m(doCompare, t('compare')) : null,
      S && bridge && bridge.shareFile ? m(showShare, t('share')) : null,
      bridge && bridge.listBackups ? m(showBackups, t('backups')) : null,
      h('button', { onclick: () => { toggleMenu(); doSaveAs(); } }, t('save_as')),
      hasFolderAccess() ? h('button', { onclick: () => { toggleMenu(); openSaveFolder(); } }, t('open_folder')) : null,
      m(showSettings, t('settings')),
      h('button', { onclick: () => { toggleMenu(); showLanguage(); } }, t('language')),
      h('button', { onclick: () => { toggleMenu(); showAbout(); } }, t('about')));
    document.body.append(menuEl);
  }
  document.addEventListener('click', () => { if (menuEl) { menuEl.remove(); menuEl = null; } });

  function render() {
    const scroll = mainEl.scrollTop;
    mainEl.replaceChildren();
    navEl.replaceChildren();
    if (!S) {
      mainEl.append(h('div', { class: 'welcome' },
        h('div', { class: 'logo', 'aria-hidden': 'true' }, h('span', null, 'P4G')),
        h('h1', null, t('welcome_title')),
        h('p', null, t('welcome_text')),
        hasFolderAccess() ? h('button', { class: 'btn accent', onclick: openSaveFolder }, t('open_folder')) : null,
        h('button', { class: hasFolderAccess() ? 'btn' : 'btn accent', onclick: doOpen }, t('open_save')),
        h('p', { class: 'hint' }, t('switch_hint')),
        h('p', { class: 'hint' }, t('backup_hint')),
        (() => {
          const d = readDraft();
          if (!d) return null;
          return h('div', { class: 'card', style: 'width:100%;max-width:420px' }, h('p', null, t('draft_found', { name: d.name })),
            h('div', { class: 'toolbar' },
              h('button', { class: 'btn accent', onclick: () => restoreDraft(d) }, t('draft_restore')),
              h('button', { class: 'btn danger', onclick: () => { clearDraft(); render(); } }, t('draft_discard'))));
        })()));
      return;
    }
    TABS.forEach(([key, label, fn]) => navEl.append(h('button', { class: key === tab ? 'on' : '', onclick: () => { tab = key; render(); mainEl.scrollTop = 0; }, html: ICONS[key] + '<span>' + t(label) + '</span>' })));
    const current = TABS.find((x) => x[0] === tab);
    mainEl.append(current[2]());
    mainEl.scrollTop = scroll;
  }

  function showAbout() {
    openSheet(t('about'), h('div', null, h('p', null, t('about_1')), h('p', null, t('about_2')), h('p', { class: 'hint' }, t('about_3'))));
  }
  function showLanguage() {
    const handle = openSheet(t('language'), h('div', null, Object.keys(STR).map((code) =>
      h('button', { class: 'opt' + (code === lang ? ' on' : ''), onclick: () => { handle.close(); setLang(code); } },
        h('span', null, STR[code].lang_name), h('small', null, code === lang ? '✓' : '')))));
  }

  // ------------------------------------------------- review / presets / backups / settings
  function diffLines(a, b) {
    const L = [];
    const ch = (k, x, y) => L.push(t(k) + ': ' + x + ' → ' + y);
    if (a.yen !== b.yen) ch('d_yen', a.yen, b.yen);
    if (a.mcLevel !== b.mcLevel) ch('d_level', a.mcLevel, b.mcLevel);
    if (a.mcXp !== b.mcXp) ch('d_xp', a.mcXp, b.mcXp);
    const nm = (x) => (x.firstname + ' ' + x.surname).trim();
    if (nm(a) !== nm(b)) ch('d_name', nm(a), nm(b));
    if (a.day !== b.day) ch('d_day', a.day, b.day);
    if (a.dayPhase !== b.dayPhase) ch('d_phase', DB.phases[a.dayPhase], DB.phases[b.dayPhase]);
    if (a.nextDay !== b.nextDay) ch('d_next', a.nextDay, b.nextDay);
    if (a.nextDayPhase !== b.nextDayPhase) L.push(t('d_next') + ': ' + DB.phases[a.nextDayPhase] + ' → ' + DB.phases[b.nextDayPhase]);
    CAT.statNames.forEach((n, st) => {
      if (a.socialStats[st] !== b.socialStats[st]) L.push(t('d_stat') + ' ' + n + ': Lv ' + P4G.pointsToLevel(st, a.socialStats[st]) + ' (' + a.socialStats[st] + ') → Lv ' + P4G.pointsToLevel(st, b.socialStats[st]) + ' (' + b.socialStats[st] + ')');
    });
    for (let i = 0; i < 3; i++) if (a.party[i] !== b.party[i]) L.push(t('d_party') + ' ' + (i + 1) + ': ' + nameOf(CAT.partyChoices, a.party[i]) + ' → ' + nameOf(CAT.partyChoices, b.party[i]));
    for (let m = 0; m < 8; m++) {
      if (m === 4) continue;
      const eq = CAT.members[m].equipId;
      [['weapon', CAT.weaponsByMember[eq]], ['armor', CAT.armor], ['accessory', CAT.accessories], ['costume', CAT.costumes]].forEach(([k, list]) => {
        const x = a.equip[k][eq], y = b.equip[k][eq];
        if (x !== y) L.push(t('d_equip') + ' ' + memberName(m) + ' ' + t(k) + ': ' + nameOf(list || [], x) + ' → ' + nameOf(list || [], y));
      });
    }
    for (let id = 0; id < b.inventory.length; id++) {
      if (a.inventory[id] !== b.inventory[id] && id !== 1792) L.push(t('d_item') + ' ' + itemName(id) + ': ' + a.inventory[id] + ' → ' + b.inventory[id]);
    }
    const linkName = (id) => { const f = CAT.socialLinkIDs.find((x) => x.id === id); return f ? f.name : '#' + id; };
    b.socialLinks.forEach((l) => {
      const o = a.socialLinks.find((x) => x.id === l.id);
      if (!o) L.push(t('d_link') + ' ' + linkName(l.id) + ': ' + t('d_added'));
      else if (o.level !== l.level || o.progress !== l.progress) L.push(t('d_link') + ' ' + linkName(l.id) + ': Lv ' + o.level + '/' + o.progress + ' → Lv ' + l.level + '/' + l.progress);
    });
    a.socialLinks.forEach((l) => { if (!b.socialLinks.some((x) => x.id === l.id)) L.push(t('d_link') + ' ' + linkName(l.id) + ': ' + t('d_removed')); });
    const pd = (p) => p.id === 0 ? 'Blank' : personaName(p.id) + ' Lv ' + p.level;
    const pcmp = (label, x, y) => {
      if (!x || !y || sigOf(x) === sigOf(y)) return;
      if (x.id !== y.id || x.level !== y.level) L.push(label + ': ' + pd(x) + ' → ' + pd(y));
      else L.push(label + ': ' + pd(y) + ' (' + t('d_changed') + ')');
    };
    a.mcSlots.forEach((p, i) => pcmp(t('d_persona') + ' ' + t('slot_n', { n: i + 1 }), p, b.mcSlots[i]));
    for (let i = 1; i < a.memberPersona.length; i++) pcmp(t('d_persona') + ' ' + memberName(i), a.memberPersona[i], b.memberPersona[i]);
    const ca = new Map(a.compendium.map((p) => [p.id, p])), cb = new Map(b.compendium.map((p) => [p.id, p]));
    let add = 0, rem = 0, chg = 0;
    cb.forEach((p, id) => { if (!ca.has(id)) add++; else if (sigOf(ca.get(id)) !== sigOf(p)) chg++; });
    ca.forEach((p, id) => { if (!cb.has(id)) rem++; });
    if (add) L.push(t('d_comp') + ': ' + add + ' ' + t('d_added'));
    if (rem) L.push(t('d_comp') + ': ' + rem + ' ' + t('d_removed'));
    if (chg) L.push(t('d_comp') + ': ' + chg + ' ' + t('d_changed'));
    return L;
  }

  /** "Review changes" dialog shown before saving: change list + sanity warnings. Resolves true to proceed. */
  function reviewDialog(message, okLabel) {
    commitSnap();
    const lines = base ? diffLines(base, S) : [];
    const warns = P4G.validate(S);
    const MAX = 60;
    return new Promise((resolve) => {
      const scrim = h('div', { class: 'scrim center' });
      const entry = { close: () => done(false) };
      const done = (v) => { const i = modals.indexOf(entry); if (i >= 0) modals.splice(i, 1); scrim.remove(); resolve(v); };
      scrim.append(h('div', { class: 'dialog wide' },
        h('h3', { style: 'margin:0 0 8px;font-size:16px' }, t('review_title')),
        message ? h('p', null, message) : null,
        warns.length ? h('div', { class: 'warnbox' }, h('b', null, '⚠ ' + t('warnings')), warns.map((w) => h('div', null, t('w_' + w.code, { n: w.n })))) : null,
        h('div', { class: 'changes' }, lines.length ? lines.slice(0, MAX).map((x) => h('div', null, x)) : h('div', { class: 'hint' }, t('review_none')),
          lines.length > MAX ? h('div', { class: 'hint' }, t('review_more', { n: lines.length - MAX })) : null),
        h('div', { class: 'btns', style: 'margin-top:14px' },
          h('button', { class: 'btn', onclick: () => done(false) }, t('cancel')),
          h('button', { class: 'btn accent', onclick: () => done(true) }, okLabel || t('save')))));
      modals.push(entry);
      document.body.append(scrim);
    });
  }

  function showPresets() {
    let handle;
    const run = (fn) => () => { handle.close(); fn(); markDirty(); commitSnap(); render(); toast(t('preset_done')); };
    const opt = (label, fn) => h('button', { class: 'opt', onclick: fn }, h('span', null, label));
    handle = openSheet(t('presets'), h('div', null,
      opt(t('preset_yen'), run(() => { S.yen = 9999999; })),
      opt(t('preset_mc99'), run(() => { S.mcLevel = 99; S.mcXp = P4G.xpForLevel(99); })),
      opt(t('preset_stats'), run(() => { CAT.statNames.forEach((n, st) => { S.socialStats[st] = P4G.levelToPoints(st, 5); }); })),
      opt(t('preset_links'), run(() => { S.socialLinks.forEach((l) => { l.level = 10; }); })),
      opt(t('preset_items99'), run(() => { for (let id = 0; id < S.inventory.length; id++) if (S.inventory[id] > 0 && id !== 1792) S.inventory[id] = 99; })),
      opt(t('preset_add_section'), async () => {
        handle.close();
        const si = await pick(t('pick_section'), CAT.sections.map((sec, i) => ({ id: i, name: sec.name, sub: String(sec.items.length) })));
        if (si === undefined) return;
        CAT.sections[si].items.forEach((it) => { if (it.name !== 'Blank' && it.id !== 1792) S.inventory[it.id] = 99; });
        markDirty(); commitSnap(); render(); toast(t('preset_done'));
      })));
  }

  const stampRe = /-(\d{8}-\d{6})(\.keep)?\.bak$/;
  function showBackups() {
    if (!S) { toast(t('backups_need_file')); return; }
    let arr = [];
    try { arr = JSON.parse(bridge.listBackups() || '[]'); } catch (e) { arr = []; }
    const stampOf = (n) => { const m = stampRe.exec(n); return m ? { stamp: m[1], locked: !!m[2] } : null; };
    const mine = arr.filter((b) => b.name.startsWith(fileName + '-') && stampOf(b.name)).map((b) => {
      const st = stampOf(b.name);
      const partner = slotName ? arr.find((x) => x.name.startsWith(slotName + '-') && stampOf(x.name) && stampOf(x.name).stamp === st.stamp) : null;
      return Object.assign({}, b, st, { partner: partner ? partner.name : null });
    });
    const fmt = (st) => st.slice(0, 4) + '-' + st.slice(4, 6) + '-' + st.slice(6, 8) + ' ' + st.slice(9, 11) + ':' + st.slice(11, 13) + ':' + st.slice(13, 15);
    let handle;
    const reopen = () => { handle.close(); showBackups(); };
    const list = h('div', { class: 'list' });
    mine.forEach((b) => list.append(h('div', { class: 'item' },
      h('div', { class: 'name tap', style: 'cursor:pointer', onclick: () => { handle.close(); restoreBackup(b); } },
        h('b', null, fmt(b.stamp)), h('small', null, Math.round(b.size / 1024) + ' KB' + (b.locked ? ' · ' + t('bk_locked') : ''))),
      h('button', { class: 'btn small', onclick: () => {
        const names = [b.name].concat(b.partner ? [b.partner] : []);
        names.forEach((n) => bridge.toggleBackupLock(n));
        reopen();
      } }, b.locked ? t('bk_unlock') : t('bk_lock')),
      h('button', { class: 'btn small danger', onclick: async () => {
        if (!(await confirmDialog(t('bk_delete_q'), t('bk_delete'), true))) return;
        [b.name].concat(b.partner ? [b.partner] : []).forEach((n) => bridge.deleteBackup(n));
        toast(t('bk_deleted')); reopen();
      } }, t('bk_delete')))));
    handle = openSheet(t('backups_title', { name: fileName }), h('div', null,
      mine.length ? list : h('p', { class: 'empty' }, t('backups_none')), h('p', { class: 'hint' }, t('bk_hint'))));
  }
  async function restoreBackup(b) {
    if (!(await confirmDialog(t('restore_q'), t('restore_btn'), true))) return;
    const b64 = bridge.readBackup(b.name);
    if (!b64) { toast(t('restore_fail'), true); return; }
    let slot = null;
    if (slotBytes) {
      let sb = slotBytes;
      const s64 = b.partner ? bridge.readBackup(b.partner) : '';
      if (s64) sb = fromB64(s64);
      slot = { name: slotName, bytes: sb };
    }
    const keepBase = base, name = fileName;
    if (!loadBytes(name, fromB64(b64), slot, true)) return;
    base = keepBase || base; savedSig = null; dirty = true; updateTopbar(); syncDraft();
    toast(t('restored'));
  }

  // ------------------------------------------------------- search / summary / share
  function showSearch() {
    if (!S) return;
    const itemSec = {};
    CAT.sections.forEach((sec, i) => sec.items.forEach((it) => { itemSec[it.id] = i; }));
    const holders = [];
    S.mcSlots.forEach((p, i) => { if (p.id) holders.push({ p, loc: t('sa_in_slot', { n: i + 1 }), go: () => { tab = 'stats'; memberIdx = 0; slotIdx = i; } }); });
    for (let i = 1; i < S.memberPersona.length; i++) { const p = S.memberPersona[i]; if (p && p.id) holders.push({ p, loc: memberName(i), go: () => { tab = 'stats'; memberIdx = i; slotIdx = 0; } }); }
    S.compendium.forEach((p) => holders.push({ p, loc: t('sa_in_comp'), go: () => { tab = 'comp'; compFilter = personaName(p.id); } }));
    const input = h('input', { type: 'text', placeholder: t('search_all_ph'), autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const out = h('div');
    let handle;
    const go = (fn) => { handle.close(); fn(); render(); mainEl.scrollTop = 0; };
    const section = (title, rows) => rows.length ? [h('p', { class: 'hint', style: 'margin:12px 0 4px;color:var(--accent)' }, title), rows] : [];
    const row2 = (name, sub, fn) => h('button', { class: 'opt', onclick: fn }, h('span', null, name), h('small', null, sub));
    const run = () => {
      out.replaceChildren();
      const tokens = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length || input.value.trim().length < 2) { out.append(h('p', { class: 'empty' }, t('sa_none'))); return; }
      const hit = (name) => tokens.every((w) => name.toLowerCase().includes(w));
      const LIM = 12;
      const items = [];
      for (let id = 0; id < DB.allItems.length && items.length < LIM; id++) {
        const n = DB.allItems[id];
        if (n == null || n === 'Blank' || id === 1792 || !hit(n)) continue;
        const owned = S.inventory[id] || 0;
        items.push(row2(n, owned ? t('sa_owned', { n: owned }) : t('sa_not_owned'), async () => {
          if (!owned && !(await confirmDialog(t('sa_add_item_q', { name: n }), t('add')))) return;
          if (!owned) { S.inventory[id] = 1; markDirty(); }
          handle.close(); tab = 'inv'; invSection = itemSec[id] != null ? itemSec[id] : 0; invFilter = n; render(); mainEl.scrollTop = 0;
        }));
      }
      const pers = holders.filter((x) => hit(personaName(x.p.id))).slice(0, LIM).map((x) => row2(personaName(x.p.id) + ' Lv ' + x.p.level, x.loc, () => go(x.go)));
      const skills = [];
      holders.forEach((x) => x.p.skills.forEach((sid) => { if (sid && skills.length < LIM && DB.allSkills[sid] != null && hit(DB.allSkills[sid])) skills.push(row2(DB.allSkills[sid], personaName(x.p.id) + ' · ' + x.loc, () => go(x.go))); }));
      const links = CAT.socialLinkIDs.filter((x) => x.id !== 0 && hit(x.name + ' ' + x.arcana)).slice(0, LIM)
        .map((x) => row2(x.name, x.arcana + ' · ' + (S.socialLinks.some((l) => l.id === x.id) ? t('sa_in_save') : t('sa_not_in_save')), () => go(() => { tab = 'social'; })));
      const all = [].concat(section(t('sa_items'), items), section(t('sa_personas'), pers), section(t('sa_skills'), skills), section(t('sa_links'), links));
      if (!all.length) out.append(h('p', { class: 'empty' }, t('no_results_for', { q: input.value.trim() })));
      else out.append(...all.flat(Infinity));
    };
    input.addEventListener('input', run);
    handle = openSheet(t('search_all'), h('div', null, input, out), { full: true });
    run();
    setTimeout(() => input.focus(), 50);
  }

  function showSummary() {
    if (!S) return;
    const total = []; for (let id = 1; id <= P4G.COMPENDIUM_COUNT; id++) if (DB.personae[id] && DB.personae[id] !== 'Blank') total.push(id);
    const reg = S.compendium.filter((p) => total.includes(p.id)).length;
    const kinds = S.inventory.filter((c, id) => c > 0 && id !== 1792 && DB.allItems[id] != null && DB.allItems[id] !== 'Blank').length;
    const party = [0, 1, 2].map((i) => nameOf(CAT.partyChoices, S.party[i])).join(', ');
    const rows = [
      [t('sm_format'), slotBytes ? t('fmt_switch') + ' + binslot' : t('fmt_bin')],
      [t('d_yen'), S.yen.toLocaleString(lang === 'id' ? 'id-ID' : 'en-US')],
      [t('d_level'), String(S.mcLevel)],
      [t('sm_date'), t('d_day') + ' ' + S.day + ' · ' + DB.phases[S.dayPhase]],
      [t('sm_compendium'), t('sm_of', { a: reg, b: total.length, p: total.length ? Math.round(reg * 100 / total.length) : 0 })],
      [t('sm_personas'), String(S.mcSlots.filter((p) => p.id).length) + ' / 12'],
      [t('sm_items'), t('sm_kinds', { n: kinds })],
      [t('sm_links'), String(S.socialLinks.length) + ' / 23'],
      [t('sm_party'), party],
    ];
    CAT.statNames.forEach((n, st) => rows.push([n, 'Lv ' + P4G.pointsToLevel(st, S.socialStats[st])]));
    openSheet(t('summary'), h('div', null, rows.map(([k, v]) => h('div', { class: 'row', style: 'border-bottom:1px solid var(--line);padding-bottom:6px' }, h('label', { style: 'flex:0 0 120px' }, k), h('div', { class: 'grow', style: 'text-align:right' }, v)))));
  }

  function showShare() {
    if (!S) return;
    const out = currentBytes(), slot = currentSlot(out);
    let handle;
    const opt = (label, fn) => h('button', { class: 'opt', onclick: () => { handle.close(); fn(); } }, h('span', null, label));
    handle = openSheet(t('share'), h('div', null,
      opt(t('share_bin') + ' (' + (fileName || 'save.bin') + ')', () => bridge.shareFile(fileName || 'save.bin', toB64(out))),
      slot ? opt(t('share_slot') + ' (' + slotName + ')', () => bridge.shareFile(slotName, toB64(slot))) : null));
  }

  function showSettings() {
    const choice = (label, key, def, opts) => {
      const box = h('div', { class: 'chips wrap', style: 'margin-bottom:0' });
      const paint = () => [...box.children].forEach((c, i) => c.classList.toggle('on', opts[i][0] === pref(key, def)));
      opts.forEach(([val, name]) => box.append(h('button', { class: 'chip', onclick: () => { setPref(key, val); applyDisplay(); paint(); } }, name)));
      paint();
      return h('div', null, h('p', { class: 'hint' }, label), box);
    };
    const xpBtn = h('button', { class: 'chip', onclick: () => { setPref('p4g-autoxp', autoXp() ? '0' : '1'); paint(); } });
    const paint = () => { xpBtn.textContent = autoXp() ? t('on') : t('off'); xpBtn.classList.toggle('on', autoXp()); };
    paint();
    openSheet(t('settings'), h('div', null,
      choice(t('theme'), 'p4g-theme', 'tv', [['tv', t('theme_tv')], ['midnight', t('theme_midnight')], ['auto', t('theme_auto')], ['dark', t('theme_dark')], ['light', t('theme_light')]]),
      choice(t('font_size'), 'p4g-fs', 'normal', [['small', t('fs_small')], ['normal', t('fs_normal')], ['large', t('fs_large')]]),
      h('p', { class: 'hint' }, t('auto_xp')), h('div', { class: 'chips', style: 'margin-bottom:0' }, xpBtn), h('p', { class: 'hint' }, t('auto_xp_hint')),
      h('p', { class: 'hint' }, t('help_hint'))));
  }

  // ------------------------------------------------------------ advanced tools
  const compTotalIds = () => { const r = []; for (let id = 1; id <= P4G.COMPENDIUM_COUNT; id++) if (DB.personae[id] && DB.personae[id] !== 'Blank') r.push(id); return r; };
  const compRegistered = () => { const tot = new Set(compTotalIds()); return S.compendium.filter((p) => tot.has(p.id)).length; };

  function showTools() {
    if (!S) return;
    let handle;
    const opt = (label, fn) => h('button', { class: 'opt', onclick: () => { handle.close(); fn(); } }, h('span', null, label));
    handle = openSheet(t('tools'), h('div', null,
      opt(t('fu_title'), () => showFusion()), opt(t('el_team'), showTeam),
      opt(t('doctor'), showDoctor), opt(t('goals'), showGoals), opt(t('timeline'), showTimeline),
      opt(t('sandbox'), showSandbox), opt(t('transfer'), showTransfer), opt(t('hex'), showHex)));
  }

  // ---- save doctor
  function showDoctor() {
    const body = h('div');
    let handle;
    const paint = () => {
      body.replaceChildren();
      const issues = P4G.diagnose(S, DB, CAT);
      if (!issues.length) { body.append(h('p', { class: 'empty' }, t('doctor_ok'))); return; }
      const fix = (codes) => { codes.forEach((c) => P4G.applyFix(S, c, DB, CAT)); markDirty(); commitSnap(); render(); paint(); toast(t('doctor_fixed')); };
      [['warn', 'doctor_warn'], ['info', 'doctor_info']].forEach(([sev, title]) => {
        const group = issues.filter((x) => x.sev === sev);
        if (!group.length) return;
        body.append(h('p', { class: 'hint', style: 'margin:10px 0 4px;color:' + (sev === 'warn' ? 'var(--danger)' : 'var(--accent)') }, t(title)));
        group.forEach((x) => body.append(h('div', { class: 'item' },
          h('div', { class: 'name' }, h('b', { style: 'white-space:normal' }, t(x.code, { n: x.n }))),
          h('button', { class: 'btn small', onclick: () => fix([x.code]) }, t('doctor_fix')))));
      });
      body.append(h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn accent', onclick: () => fix(issues.map((x) => x.code)) }, t('doctor_fix_all'))),
        h('p', { class: 'hint' }, t('doctor_hint')));
    };
    handle = openSheet(t('doctor'), body, { full: true });
    paint();
  }

  // ---- timeline
  const TL_KEY = 'p4g-timeline';
  function readTimeline() { try { return JSON.parse(localStorage.getItem(TL_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function recordTimeline() {
    if (!S) return;
    try {
      const all = readTimeline(), key = fileName || 'save';
      const list = all[key] || [];
      const e = { t: Date.now(), day: S.day, phase: S.dayPhase, lv: S.mcLevel, yen: S.yen, comp: S.compendium.length, links: S.socialLinks.length };
      const last = list[list.length - 1];
      if (last && ['day', 'phase', 'lv', 'yen', 'comp', 'links'].every((k) => last[k] === e[k])) return;
      list.push(e); all[key] = list.slice(-150);
      localStorage.setItem(TL_KEY, JSON.stringify(all));
    } catch (e) { /* storage unavailable */ }
  }
  function spark(label, values) {
    const W = 300, H = 56, min = Math.min.apply(null, values), max = Math.max.apply(null, values), span = max - min || 1;
    const pts = values.map((v, i) => (values.length === 1 ? W / 2 : 4 + i * (W - 8) / (values.length - 1)).toFixed(1) + ',' + (H - 6 - (v - min) * (H - 12) / span).toFixed(1));
    return h('div', { style: 'margin:10px 0' },
      h('div', { class: 'row', style: 'margin:0' }, h('label', { style: 'flex:1;color:var(--text)' }, label), h('span', { class: 'hint', style: 'margin:0' }, min === max ? String(max) : min + ' → ' + values[values.length - 1] + '  (max ' + max + ')')),
      h('div', { html: '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:56px;background:var(--surface-2);border-radius:10px"><polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" points="' + pts.join(' ') + '"/></svg>' }));
  }
  function showTimeline() {
    const list = readTimeline()[fileName || 'save'] || [];
    const fmt = (ms) => { try { return new Date(ms).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } };
    openSheet(t('timeline'), list.length ? h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, t('tl_hint', { name: fileName })),
      spark(t('tl_yen'), list.map((x) => x.yen)), spark(t('tl_level'), list.map((x) => x.lv)), spark(t('tl_comp'), list.map((x) => x.comp)), spark(t('tl_links'), list.map((x) => x.links)),
      h('h3', { style: 'margin:14px 0 6px;font-size:13px;color:var(--accent);text-transform:uppercase' }, t('tl_entries')),
      list.slice().reverse().slice(0, 40).map((x) => h('div', { class: 'item', style: 'margin-bottom:6px' }, h('div', { class: 'name' }, h('b', null, t('d_day') + ' ' + x.day + ' · Lv ' + x.lv), h('small', null, fmt(x.t) + ' · ¥' + x.yen + ' · ' + x.comp + ' Persona'))))) : h('p', { class: 'empty' }, t('tl_none')), { full: true });
  }

  // ---- goals
  const GOALS_KEY = 'p4g-goals';
  function metrics() {
    const links = Math.min(23, CAT.socialLinkIDs.filter((x) => x.id !== 0).length);
    return {
      yen: { label: 'gm_yen', get: () => S.yen, max: 9999999 },
      level: { label: 'gm_level', get: () => S.mcLevel, max: 99 },
      comp: { label: 'gm_comp', get: compRegistered, max: compTotalIds().length },
      links: { label: 'gm_links', get: () => S.socialLinks.filter((l) => l.level >= 10).length, max: links },
      stats: { label: 'gm_stats', get: () => CAT.statNames.filter((n, st) => P4G.pointsToLevel(st, S.socialStats[st]) >= 5).length, max: 5 },
      slots: { label: 'gm_slots', get: () => S.mcSlots.filter((p) => p.id).length, max: 12 },
    };
  }
  function showGoals() {
    const M = metrics();
    const custom = () => { try { const g = JSON.parse(localStorage.getItem(GOALS_KEY) || '[]'); return Array.isArray(g) ? g.filter((x) => M[x.metric] && Number.isFinite(x.target)) : []; } catch (e) { return []; } };
    const putCustom = (g) => { try { localStorage.setItem(GOALS_KEY, JSON.stringify(g)); } catch (e) { /* ignore */ } };
    const body = h('div');
    let handle;
    const bar = (label, cur, target, onDelete) => {
      const pct = Math.max(0, Math.min(100, Math.round(cur * 100 / (target || 1))));
      return h('div', { class: 'goal' },
        h('div', { class: 'row', style: 'margin:0 0 4px' }, h('label', { style: 'flex:1;color:var(--text)' }, (pct >= 100 ? '✓ ' : '') + label),
          h('span', { class: 'hint', style: 'margin:0' }, cur + ' / ' + target + (pct >= 100 ? ' · ' + t('goal_done') : '')),
          onDelete ? h('button', { class: 'btn small danger', style: 'min-height:30px', onclick: onDelete }, '✕') : null),
        h('div', { class: 'bar' }, h('i', { style: 'width:' + pct + '%' + (pct >= 100 ? ';background:var(--ok)' : '') })));
    };
    const paint = () => {
      body.replaceChildren(h('p', { class: 'hint', style: 'margin-top:0' }, t('goals_hint')));
      Object.keys(M).forEach((k) => body.append(bar(t(M[k].label), M[k].get(), M[k].max)));
      const c = custom();
      c.forEach((g, i) => body.append(bar(t(M[g.metric].label), M[g.metric].get(), g.target, () => { const x = custom(); x.splice(i, 1); putCustom(x); paint(); })));
      body.append(h('button', { class: 'btn', style: 'width:100%;margin-top:12px', onclick: async () => {
        const keys = Object.keys(M);
        const idx = await pick(t('goal_pick_metric'), keys.map((k, i) => ({ id: i, name: t(M[k].label), sub: '≤ ' + M[k].max })));
        if (idx === undefined) return;
        const key = keys[idx];
        const target = await promptNumber(t('goal_target_q'), '', M[key].max, 1, M[key].max, t('ok'));
        if (target === undefined) return;
        const x = custom(); x.push({ metric: key, target }); putCustom(x); paint();
      } }, t('goal_add')));
    };
    handle = openSheet(t('goals'), body, { full: true });
    paint();
  }

  // ---- sandbox
  function showSandbox() {
    if (!sandboxBase) {
      commitSnap(); sandboxBase = deepClone(S); updateTopbar(); toast(t('sandbox_started'));
      return;
    }
    commitSnap();
    const lines = diffLines(sandboxBase, S);
    let handle;
    handle = openSheet(t('sandbox'), h('div', null,
      h('p', { class: 'hint', style: 'margin-top:0' }, t('sandbox_impact')),
      h('div', { class: 'changes', style: 'max-height:40vh' }, lines.length ? lines.slice(0, 80).map((x) => h('div', null, x)) : h('div', { class: 'hint' }, t('review_none'))),
      h('div', { class: 'toolbar', style: 'margin-top:12px' },
        h('button', { class: 'btn danger', onclick: () => {
          handle.close(); S = deepClone(sandboxBase); sandboxBase = null; commitSnap(); gotoHist(hi); updateTopbar(); toast(t('sandbox_discarded'));
        } }, t('sandbox_discard')),
        h('button', { class: 'btn accent', onclick: () => { handle.close(); sandboxBase = null; updateTopbar(); toast(t('sandbox_applied')); } }, t('sandbox_apply')))));
  }

  // ---- transfer (text code)
  async function packCode() {
    const bin = currentBytes(), slot = currentSlot(bin);
    const payload = new TextEncoder().encode(JSON.stringify({ n: fileName, sn: slotName, b: toB64(bin), s: slot ? toB64(slot) : null }));
    if (window.CompressionStream) {
      const buf = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      return 'P4GX1:' + toB64(buf);
    }
    return 'P4GR1:' + toB64(payload);
  }
  async function unpackCode(code) {
    code = code.trim();
    const m = /^(P4GX1|P4GR1):([A-Za-z0-9+/=\s]+)$/.exec(code);
    if (!m) throw new Error('bad');
    let bytes = fromB64(m[2].replace(/\s+/g, ''));
    if (m[1] === 'P4GX1') {
      if (!window.DecompressionStream) throw new Error('bad');
      bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const o = JSON.parse(new TextDecoder().decode(bytes));
    if (!o || typeof o.b !== 'string') throw new Error('bad');
    return o;
  }
  function showTransfer() {
    const ta = h('textarea', { rows: 8, spellcheck: 'false', autocapitalize: 'none', class: 'ta' });
    let handle;
    const make = async () => { ta.value = S ? await packCode() : ''; };
    const copy = async () => {
      ta.focus(); ta.select(); let ok = false;
      try { await navigator.clipboard.writeText(ta.value); ok = true; } catch (e) { try { ok = document.execCommand('copy'); } catch (e2) { /* manual */ } }
      if (ok) toast(t('ei_copied'));
    };
    const load = async () => {
      try {
        const o = await unpackCode(ta.value);
        if (dirty && !(await confirmDialog(t('discard_open'), t('open'), true))) return;
        const slot = o.s ? { name: o.sn || 'save.binslot', bytes: fromB64(o.s) } : null;
        handle.close();
        if (!loadBytes(o.n || 'save.bin', fromB64(o.b), slot, true)) return;
        savedSig = null; dirty = true; updateTopbar(); syncDraft(); toast(t('tr_loaded'));
      } catch (e) { toast(t('tr_bad'), true); }
    };
    handle = openSheet(t('transfer'), h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, t('tr_hint')), ta,
      h('div', { class: 'toolbar', style: 'margin-top:10px;flex-wrap:wrap' },
        h('button', { class: 'btn', onclick: make }, t('tr_make')), h('button', { class: 'btn', onclick: copy }, t('tr_copy')),
        bridge && bridge.shareText ? h('button', { class: 'btn', onclick: () => ta.value && bridge.shareText(ta.value) }, t('share')) : null,
        h('button', { class: 'btn accent', onclick: load }, t('tr_load')))));
    make();
  }

  // ---- hex inspector
  const REGIONS = Object.entries(P4G.OFF).filter(([, v]) => typeof v === 'number').sort((a, b) => a[1] - b[1]);
  const regionOf = (off) => { let r = null; for (const [k, v] of REGIONS) if (v <= off) r = [k, v]; return r ? r[0] + '+' + (off - r[1]) : 'header+' + off; };
  const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
  function showHex() {
    const cur = currentBytes(), ref = orig;
    const PAGE = 256;
    let start = 0;
    const body = h('div');
    let handle;
    const dump = h('div', { class: 'hexdump' });
    const info = h('p', { class: 'hint' });
    const goInput = h('input', { type: 'text', placeholder: t('hex_goto'), autocomplete: 'off', autocapitalize: 'none' });
    const paint = () => {
      start = Math.max(0, Math.min(Math.floor((cur.length - 1) / 16) * 16, start - (start % 16)));
      dump.replaceChildren();
      for (let a = start; a < Math.min(cur.length, start + PAGE); a += 16) {
        const row = h('div', { class: 'hx' }, h('span', { class: 'ao' }, hex(a, 5)));
        let asc = '';
        for (let i = a; i < a + 16; i++) {
          if (i >= cur.length) { row.append(h('span', { class: 'b' }, '  ')); continue; }
          const changed = ref && i < ref.length && ref[i] !== cur[i];
          row.append(h('span', { class: 'b' + (changed ? ' chg' : '') }, hex(cur[i], 2)));
          asc += cur[i] >= 32 && cur[i] < 127 ? String.fromCharCode(cur[i]) : '.';
        }
        row.append(h('span', { class: 'asc' }, asc));
        dump.append(row);
      }
      info.textContent = '0x' + hex(start, 5) + ' – 0x' + hex(Math.min(cur.length, start + PAGE) - 1, 5) + '  ·  ' + regionOf(start) + '  ·  ' + cur.length + ' B';
    };
    goInput.addEventListener('change', () => {
      const v = goInput.value.trim();
      const n = /^0x/i.test(v) || /[a-f]/i.test(v) ? parseInt(v.replace(/^0x/i, ''), 16) : parseInt(v, 10);
      if (Number.isFinite(n)) { start = n; paint(); }
    });
    const regionBtn = h('button', { class: 'btn', style: 'width:100%;margin-bottom:8px', onclick: async () => {
      const idx = await pick(t('hex_region'), REGIONS.map(([k, v], i) => ({ id: i, name: k, sub: '0x' + hex(v, 5) })));
      if (idx !== undefined) { start = REGIONS[idx][1]; paint(); }
    } }, t('hex_region'));
    body.append(h('p', { class: 'hint', style: 'margin-top:0' }, t('hex_hint')), regionBtn, goInput, info, dump,
      h('div', { class: 'toolbar', style: 'margin-top:8px' },
        h('button', { class: 'btn', onclick: () => { start -= PAGE; paint(); } }, t('hex_prev')),
        h('button', { class: 'btn', onclick: () => { start += PAGE; paint(); } }, t('hex_next'))),
      h('button', { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => { handle.close(); compareMode = 'hex'; pickFiles(); } }, t('hex_compare')));
    handle = openSheet(t('hex'), body, { full: true });
    paint();
  }
  function showHexDiff(name, other) {
    const cur = currentBytes(), n = Math.min(cur.length, other.length);
    const ranges = [];
    for (let i = 0; i < n; i++) {
      if (cur[i] === other[i]) continue;
      const last = ranges[ranges.length - 1];
      if (last && i === last.end) last.end = i + 1; else ranges.push({ start: i, end: i + 1 });
    }
    const rows = ranges.slice(0, 200).map((r) => {
      const len = r.end - r.start, cap = Math.min(len, 8);
      const a = Array.from(cur.subarray(r.start, r.start + cap), (v) => hex(v, 2)).join(' ') + (len > cap ? ' …' : '');
      const b = Array.from(other.subarray(r.start, r.start + cap), (v) => hex(v, 2)).join(' ') + (len > cap ? ' …' : '');
      return h('div', { class: 'item', style: 'display:block' }, h('b', null, '0x' + hex(r.start, 5) + ' · ' + regionOf(r.start) + ' · ' + len + ' B'),
        h('div', { class: 'hint', style: 'font-family:ui-monospace,monospace;margin:2px 0 0;word-break:break-all' }, a + '  →  ' + b));
    });
    openSheet(t('hex_diff_title', { name }), h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, t('hex_ranges', { n: ranges.length })),
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'empty' }, t('hex_none'))), { full: true });
  }

  // ---- long-press explanations
  (function initHelp() {
    const map = () => {
      const m = { Lv: 'level', ST: 'stat', MA: 'stat', DE: 'stat', AG: 'stat', LU: 'stat' };
      [['yen', 'yen'], ['total_xp', 'xp'], ['level', 'link_level'], ['progress', 'progress'], ['day', 'day'], ['next_day', 'day'], ['phase', 'phase'], ['next_phase', 'phase'],
        ['persona', 'persona'], ['social_stats', 'social_stats'], ['party_config', 'party'], ['hero_name', 'name']].forEach(([k, v]) => { m[t(k)] = v; });
      return m;
    };
    let timer = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    const lookup = (target) => {
      const el = target.closest && target.closest('label, .lbl, h3');
      if (!el) return null;
      const txt = el.textContent.trim(), key = map()[txt];
      return key ? { txt, key } : null;
    };
    const show = (hit) => openSheet(hit.txt, h('div', null, h('p', null, t('help_' + hit.key)), h('p', { class: 'hint' }, t('help_title'))));
    const start = (e) => { const hit = lookup(e.target); if (!hit) return; cancel(); timer = setTimeout(() => { timer = null; show(hit); }, 500); };
    ['touchstart', 'mousedown'].forEach((ev) => document.addEventListener(ev, start, { passive: true }));
    ['touchend', 'touchmove', 'touchcancel', 'mouseup', 'scroll'].forEach((ev) => document.addEventListener(ev, cancel, { passive: true, capture: true }));
    document.addEventListener('contextmenu', (e) => { const hit = lookup(e.target); if (hit) { e.preventDefault(); cancel(); show(hit); } });
  })();

  // ---- the emulator rewrote the opened save
  let extPrompt = false;
  window.__onExternalChange = (binPath, slotPath) => {
    if (extPrompt || !S) return;
    extPrompt = true;
    confirmDialog(t('ext_changed_q') + (dirty ? t('ext_changed_dirty') : ''), t('reload'), dirty).then((ok) => {
      extPrompt = false;
      if (ok && bridge && bridge.openPath) bridge.openPath(binPath, slotPath);
    });
  };

  // --------------------------------------------------------------- file I/O
  const toB64 = (u8) => { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); };
  const fromB64 = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  function loadBytes(name, bytes, slot, silent) {
    try {
      const parsed = P4G.parse(bytes);
      if (slot && !P4G.isBinslot(slot.bytes)) throw new Error(t('not_binslot_named', { name: slot.name }));
      S = parsed; orig = bytes; fileName = name; dirty = false;
      slotBytes = slot ? slot.bytes : null; slotName = slot ? slot.name : '';
      memberIdx = 0; slotIdx = 0; invFilter = ''; compFilter = ''; tab = 'stats';
      resetHistory(); clearDraft(); sandboxBase = null; recordTimeline();
      build();
      if (!silent) {
        toast(t('opened', { name: name + (slot ? ' + ' + slot.name : '') }));
        if (!slot) setTimeout(() => toast(t('switch_pick_slot')), 2400);
      }
      return true;
    } catch (e) {
      toast(e.code ? t('err_' + e.code, e.args) : (e.message || String(e)), true);
      return false;
    }
  }
  /** files: [{name, bytes}] - one .bin plus an optional .binslot, in any order. */
  function loadFiles(files) {
    if (compareMode) {
      const mode = compareMode; compareMode = false;
      const only = files.find((f) => !/\.binslot$/i.test(f.name));
      if (!only) { toast(t('compare_pick_bin'), true); return; }
      if (mode === 'hex') { showHexDiff(only.name, only.bytes); return; }
      try { showCompare(only.name, P4G.parse(only.bytes)); } catch (e) { toast(e.code ? t('err_' + e.code, e.args) : (e.message || String(e)), true); }
      return;
    }
    const slot = files.find((f) => /\.binslot$/i.test(f.name));
    const bin = files.find((f) => f !== slot);
    if (!bin) { toast(t('pick_bin'), true); return; }
    loadBytes(bin.name, bin.bytes, slot);
  }
  // ------------------------------------------------------ save folder (Android)
  const DEFAULT_DIR = '/storage/emulated/0/persona 4 golden/user/save';
  const hasFolderAccess = () => !!(bridge && bridge.scanSaves);
  const getDir = () => { try { return localStorage.getItem('p4g-savedir') || DEFAULT_DIR; } catch (e) { return DEFAULT_DIR; } };
  const setDir = (v) => { try { localStorage.setItem('p4g-savedir', v); } catch (e) { /* ignore */ } };

  async function openSaveFolder() {
    if (!hasFolderAccess()) return doOpen();
    if (dirty && !(await confirmDialog(t('discard_open'), t('open'), true))) return;
    compareMode = false;
    toast(t('scanning'));
    bridge.scanSaves(getDir());
  }

  /** Message + editable path + retry / manual-pick buttons. */
  function folderEditor(message, path) {
    const input = h('input', { type: 'text', value: path, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    const handle = openSheet(t('folder_location'), h('div', null,
      message ? h('p', { class: 'warn' }, message) : null,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, input)),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn accent', onclick: () => { const v = input.value.trim() || DEFAULT_DIR; setDir(v); handle.close(); toast(t('scanning')); bridge.scanSaves(v); } }, t('retry')),
        h('button', { class: 'btn', onclick: () => { handle.close(); doOpen(); } }, t('pick_manually')))));
    return handle;
  }

  function showSlots(r) {
    const fmt = (ms) => { try { return new Date(ms).toLocaleString(lang === 'id' ? 'id-ID' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } };
    const list = h('div', { class: 'list' });
    let handle;
    r.slots.forEach((sl) => {
      const detail = [sl.info, Math.round(sl.size / 1024) + ' KB', fmt(sl.modified)].filter(Boolean).join(' · ');
      list.append(h('div', { class: 'item tap', onclick: () => { handle.close(); bridge.openPath(sl.bin, sl.slot); } },
        h('div', { class: 'name' }, h('b', null, (sl.dir ? sl.dir + '/' : '') + sl.name), h('small', null, detail)),
        h('span', { class: 'hint' }, '›')));
    });
    handle = openSheet(t('pick_slot'), h('div', null,
      h('p', { class: 'hint', style: 'margin:0 0 10px;word-break:break-all' }, t('slots_found', { n: r.slots.length, path: r.root })),
      list,
      h('div', { class: 'toolbar', style: 'margin-top:12px' },
        h('button', { class: 'btn', onclick: () => { handle.close(); folderEditor('', r.path); } }, t('change_folder')))), { full: true });
  }

  window.__onScanResult = (r) => {
    if (r.status === 'permission') {
      confirmDialog(t('perm_q'), t('perm_go')).then((ok) => { if (ok) bridge.requestStorageAccess(); });
    } else if (r.status === 'ok') showSlots(r);
    else folderEditor(t(r.status === 'empty' ? 'folder_empty' : 'folder_not_found') + ' ' + r.path, r.path);
  };

  async function doOpen() {
    if (dirty && !(await confirmDialog(t('discard_open'), t('open'), true))) return;
    compareMode = false;
    pickFiles();
  }
  function pickFiles() {
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
  function doCompare() {
    if (!S) return;
    commitSnap();
    compareMode = 'diff';
    pickFiles();
  }
  function showCompare(name, other) {
    const lines = diffLines(S, other);
    openSheet(t('compare_title', { name }), h('div', null, h('p', { class: 'hint', style: 'margin-top:0' }, t('compare_hint')),
      lines.length ? h('div', { class: 'changes', style: 'max-height:none' }, lines.slice(0, 300).map((x) => h('div', null, x))) : h('p', { class: 'empty' }, t('compare_none'))), { full: true });
  }
  function restoreDraft(d) {
    const slot = d.slot ? { name: d.slotName || 'save.binslot', bytes: fromB64(d.slot) } : null;
    if (!loadBytes(d.name || 'save.bin', fromB64(d.bin), slot, true)) { clearDraft(); return; }
    savedSig = null; dirty = true; updateTopbar(); syncDraft(); toast(t('draft_restored'));
  }
  function currentBytes() { return P4G.serialize(S, orig); }
  function currentSlot(bin) { return slotBytes ? P4G.patchBinslot(slotBytes, bin) : null; }
  function download(name, bytes) {
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), download: name });
    document.body.append(a); a.click(); a.remove();
  }
  async function doSave() {
    if (!S) return;
    if (sandboxBase) { toast(t('sandbox_blocked'), true); return; }
    const names = fileName + (slotBytes ? ' ' + t('and') + ' ' + slotName : '');
    if (!(await reviewDialog(bridge ? t('overwrite_q', { names }) : '', t('save')))) return;
    if (!bridge) return doSaveAs(true);
    const out = currentBytes(), slot = currentSlot(out);
    if (slot && !P4G.verifySlot(slot, out)) { toast(t('err_verify_bad'), true); return; }
    pendingBytes = out; pendingSlot = slot;
    bridge.saveFile(toB64(out), slot ? toB64(slot) : '');
  }
  async function doSaveAs(skipReview) {
    if (!S) return;
    if (sandboxBase) { toast(t('sandbox_blocked'), true); return; }
    if (skipReview !== true && !(await reviewDialog('', t('save_as')))) return;
    const out = currentBytes(), slot = currentSlot(out);
    if (slot && !P4G.verifySlot(slot, out)) { toast(t('err_verify_bad'), true); return; }
    if (bridge) { pendingBytes = out; pendingSlot = slot; bridge.saveFileAs(fileName || 'save.bin', toB64(out), slotName, slot ? toB64(slot) : ''); }
    else {
      download(fileName || 'save.bin', out);
      if (slot) setTimeout(() => download(slotName, slot), 400);
      orig = out; if (slot) slotBytes = slot; commitSnap(); savedSig = sigOf(S); base = deepClone(S); dirty = false; updateTopbar(); clearDraft(); toast(t('downloaded'));
    }
  }
  let pendingBytes = null, pendingSlot = null;

  // callbacks invoked by the Android host
  window.__onFilesOpened = (arr) => loadFiles(arr.map((f) => ({ name: f.name, bytes: fromB64(f.b64) })));
  window.__onSaved = (name) => { if (pendingBytes) { orig = pendingBytes; pendingBytes = null; } if (pendingSlot) { slotBytes = pendingSlot; pendingSlot = null; } if (name) fileName = name; commitSnap(); savedSig = sigOf(S); base = deepClone(S); dirty = false; updateTopbar(); clearDraft(); recordTimeline(); toast(t('saved', { name: fileName })); };
  window.__onError = (code, detail) => { pendingBytes = null; pendingSlot = null; toast(STR.en['err_' + code] ? t('err_' + code, { detail }) : code, true); };
  window.__back = () => {
    if (menuEl) { toggleMenu(); return 'handled'; }
    if (modals.length) { modals[modals.length - 1].close(); return 'handled'; }
    if (dirty) {
      confirmDialog(t('exit_q'), t('exit'), true).then((ok) => { if (ok && bridge) bridge.exitApp(); });
      return 'handled';
    }
    return 'exit';
  };
  window.__p4g = { get state() { return S; }, loadBytes, currentBytes }; // debug / testing hook

  build();
})();
