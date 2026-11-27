/* Screens built on persona-core.js: real data, skill compare, build planner, team resistances, fusion. */
window.P4GPersonaUI = function (ctx) {
  'use strict';
  const { t, h, row, DB, CAT, engine, openSheet, confirmDialog, pick, toast, personaName, memberName, protagName } = ctx;
  const S = () => ctx.state();
  const skillName = (id) => DB.allSkills[id] != null ? DB.allSkills[id] : '#' + id;
  const levelText = (lv) => lv === 0 ? t('sk_innate') : typeof lv === 'number' ? 'Lv ' + lv : t('sk_special', { code: lv });
  const heading = (text) => h('p', { class: 'subhead' }, text);
  const note = (text) => h('p', { class: 'hint' }, text);
  const tag = (text, kind) => h('span', { class: 'tag ' + (kind || '') }, text);
  const item = (title, sub, extra, onclick) => h(onclick ? 'button' : 'div', { class: 'entry' + (onclick ? ' tap' : ''), onclick },
    h('b', null, title), sub ? h('small', null, sub) : null, extra || null);
  /** A "select" that only drives the screen it is on (nothing in the save changes). */
  function chooser(title, getOptions, get, set) {
    const label = h('span', { class: 'v' });
    const paint = () => { const o = getOptions().find((x) => x.id === get()); label.textContent = o ? o.name : t('choose'); };
    paint();
    return h('button', { class: 'select', type: 'button', onclick: async () => {
      const r = await pick(title, getOptions(), get());
      if (r !== undefined) { set(r); paint(); }
    } }, label);
  }
  /** Long lists are shown in pages so the WebView stays responsive. */
  function paged(list, render, size) {
    const box = h('div');
    let shown = 0;
    const more = h('button', { class: 'btn', style: 'width:100%;margin-top:8px', onclick: () => next() });
    const next = () => {
      list.slice(shown, shown + size).forEach((x) => box.insertBefore(render(x), more));
      shown = Math.min(list.length, shown + size);
      if (shown >= list.length) more.remove(); else more.textContent = t('show_more', { n: list.length - shown });
    };
    box.append(more); next();
    return box;
  }

  const personaOptions = (filter) => CAT.personae.filter((o) => o.id !== 0 && engine.get(o.id) && (!filter || filter(o.id)))
    .map((o) => ({ id: o.id, name: o.name, sub: engine.arcana(o.id) + ' · Lv ' + engine.get(o.id).l }));

  function ownedIds(withCompendium) {
    const set = new Set(S().mcSlots.filter((p) => p.id).map((p) => p.id));
    if (withCompendium) S().compendium.forEach((p) => set.add(p.id));
    return set;
  }
  function whereOwned(id) {
    if (S().mcSlots.some((p) => p.id === id)) return t('own_slot');
    return S().compendium.some((p) => p.id === id) ? t('own_comp') : '';
  }

  // ------------------------------------------------------------ real data
  const describe = (p) => 'Lv ' + p.level + ' · ST ' + p.st + ' MA ' + p.ma + ' DE ' + p.de + ' AG ' + p.ag + ' LU ' + p.lu +
    ' · ' + (p.skills.filter(Boolean).map(skillName).join(', ') || t('def_no_skill'));
  function realData(id) {
    const d = engine.defaults(id);
    return d ? Object.assign(d, { totalxp: ctx.xpForLevel(d.level) }) : null;
  }
  /** Preview first; only the confirmed Persona changes. */
  function applyDefaults(p, done) {
    const d = realData(p.id);
    if (!d) { toast(t('def_none'), true); return; }
    const handle = openSheet(t('def_title', { name: personaName(p.id) }), h('div', null,
      heading(t('def_before')), h('p', null, describe(p)), heading(t('def_after')), h('p', null, describe(d)), note(t('def_hint')),
      h('button', { class: 'btn accent', style: 'width:100%;margin-top:12px', onclick: () => {
        Object.assign(p, d, { skills: d.skills.slice(), exists: true });
        ctx.changed(); handle.close(); done(); toast(t('def_applied'));
      } }, t('def_apply'))));
  }

  // ------------------------------------------------------------ build check
  function buildWarnings(p) {
    if (!p.id) return [];
    const r = engine.checkBuild(p.id, p.skills);
    const out = [];
    if (r.duplicate.length) out.push({ kind: 'bad', text: t('bw_dup', { list: r.duplicate.map(skillName).join(', ') }) });
    if (r.foreign.length) out.push({ kind: 'info', text: t('bw_foreign', { list: r.foreign.map(skillName).join(', ') }) });
    return out;
  }

  // ------------------------------------------------------------ compare skills
  function compareSkills(first) {
    const ids = [first || 0, 0];
    const out = h('div');
    const options = () => ctx.skillOptions().filter((o) => o.desc);
    const paint = () => {
      out.replaceChildren();
      const info = ids.map((i) => ctx.skillInfo[i]);
      if (!info[0] || !info[1]) { out.append(note(t('cmp_pick'))); return; }
      const rows = [[t('sk_elem'), info.map(ctx.skillElem)], [t('sk_cost'), info.map((s) => s.c || '–')],
        [t('sk_target'), info.map((s) => s.t || '–')], [t('sk_effect'), info.map((s) => s.d || '–')], [t('sk_card'), info.map((s) => s.k || '–')]];
      out.append(h('table', { class: 'cmp' },
        h('tr', null, h('th'), ids.map((i) => h('th', null, skillName(i)))),
        rows.map(([label, v]) => h('tr', null, h('td', null, label), h('td', { class: v[0] !== v[1] ? 'diff' : '' }, v[0]), h('td', { class: v[0] !== v[1] ? 'diff' : '' }, v[1])))));
    };
    openSheet(t('cmp_title'), h('div', null,
      [0, 1].map((n) => row(t('skill') + ' ' + (n ? 'B' : 'A'), chooser(t('skill'), options, () => ids[n], (v) => { ids[n] = v; paint(); }))), out), { full: true });
    paint();
  }

  // ------------------------------------------------------------ build planner
  const wanted = []; // kept while the app is open
  function planner() {
    const body = h('div');
    const paint = () => {
      body.replaceChildren(note(t('pl_hint')));
      wanted.forEach((id, i) => body.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, skillName(id)), h('small', { class: 'hint', style: 'display:block;margin:0' }, ctx.skillSummary(id))),
        h('button', { class: 'btn small danger', onclick: () => { wanted.splice(i, 1); paint(); } }, '✕'))));
      if (wanted.length < 8) body.append(h('button', { class: 'btn accent', style: 'width:100%', onclick: async () => {
        const r = await pick(t('pl_add'), ctx.skillOptions().filter((o) => o.id !== 0 && o.name !== 'Blank' && !wanted.includes(o.id)), 0, { skillFilters: true });
        if (r !== undefined) { wanted.push(r); paint(); }
      } }, t('pl_add')));
      if (!wanted.length) return;
      const cards = wanted.filter((id) => (ctx.skillInfo[id] || {}).k);
      if (cards.length) body.append(heading(t('pl_cards')), ...cards.map((id) => note(skillName(id) + ' ← ' + ctx.skillInfo[id].k)));
      const list = engine.plan(wanted);
      body.append(heading(t('pl_results', { n: list.length })));
      if (!list.length) { body.append(note(t('pl_none'))); return; }
      const have = ownedIds(true);
      body.append(paged(list, (x) => {
        const where = whereOwned(x.id);
        const ready = !where && !x.party && engine.recipesFor(x.id, have).some((r) => !r.missing.length);
        return item(personaName(x.id) + '  ' + x.matches.length + '/' + wanted.length,
          x.matches.map((m) => skillName(m.skill) + ' (' + levelText(m.level) + ')').join(', '),
          h('span', { class: 'tags' }, tag((x.party ? t('pl_party') : engine.arcana(x.id)) + ' · ' + t('pl_base', { n: x.level })),
            where ? tag(where, 'ok') : null, ready ? tag(t('pl_fusable'), 'ok') : null),
          x.party ? null : () => fusion(x.id));
      }, 20));
    };
    openSheet(t('planner'), body, { full: true });
    paint();
  }

  // ------------------------------------------------------------ team resistances
  const SYMBOL = { w: 'Wk', '-': '–', s: 'Res', n: 'Nul', r: 'Rpl', d: 'Abs' };
  function team() {
    let slot = Math.max(0, S().mcSlots.findIndex((p) => p.id));
    const body = h('div');
    const paint = () => {
      const members = [];
      const mc = S().mcSlots[slot];
      members.push({ name: protagName(), p: mc });
      // party bytes hold member index + 1
      S().party.forEach((v) => { if (v > 1 && S().memberPersona[v - 1]) members.push({ name: memberName(v - 1), p: S().memberPersona[v - 1] }); });
      const rows = members.map((m) => ({ m, aff: engine.affinities(m.p.id, m.p.skills) }));
      const report = engine.teamReport(members.map((m) => m.p));
      const els = ctx.elements.slice(0, 7);
      const slots = () => S().mcSlots.map((p, i) => ({ id: i, name: t('slot_n', { n: i + 1 }) + ' – ' + personaName(p.id) }));
      body.replaceChildren(
        row(t('team_mc'), chooser(t('team_mc'), slots, () => slot, (v) => { slot = v; paint(); })),
        h('div', { class: 'tablewrap' }, h('table', { class: 'aff' },
          h('tr', null, h('th'), els.map((e) => h('th', null, e.slice(0, 4)))),
          rows.map(({ m, aff }) => h('tr', null, h('td', null, h('b', null, m.name.split(' ')[0]), h('small', null, personaName(m.p.id))),
            els.map((e, i) => h('td', { class: aff ? 'a-' + (aff[i] === '-' ? 'x' : aff[i]) : '' }, aff ? SYMBOL[aff[i]] : '?')))))));
      const danger = report.filter((x) => x.weak >= 2);
      body.append(heading(t('team_summary')));
      if (danger.length) danger.forEach((x) => body.append(h('p', { class: 'warn' }, t('team_weak', { n: x.weak, el: x.name }) + (x.safe ? ' ' + t('team_cover', { n: x.safe }) : ''))));
      else body.append(note(t('team_ok')));
      if (rows.some((x) => !x.aff)) body.append(note(t('team_unknown')));
      body.append(note(t('team_hint')));
    };
    openSheet(t('team'), body, { full: true });
    paint();
  }

  // ------------------------------------------------------------ fusion
  function unlockState(id) {
    const cond = engine.get(id).u;
    if (!cond) return null;
    const m = /^(\w+) Rank 10$/.exec(cond);
    const done = !!m && S().socialLinks.some((l) => {
      const info = CAT.socialLinkIDs.find((x) => x.id === l.id);
      return l.level >= 10 && info && info.arcana.split(' ')[0] === m[1];
    });
    return { cond, done };
  }
  function resultNotes(id) {
    const out = [];
    const lv = engine.get(id).l;
    if (lv > S().mcLevel) out.push(h('p', { class: 'warn' }, t('fu_level', { need: lv, have: S().mcLevel })));
    const u = unlockState(id);
    if (u) out.push(h('p', { class: u.done ? 'hint' : 'warn' }, t(u.done ? 'fu_unlock_ok' : 'fu_unlock', { cond: u.cond })));
    if (engine.isSpecial(id)) out.push(note(t('fu_special')));
    return out;
  }
  const recipeText = (ids, owned) => ids.map((i) => personaName(i) + ' (Lv ' + engine.get(i).l + ')' + (owned.has(i) ? ' ✓' : ' ✗')).join('  +  ');

  let useComp = true;
  function fusion(startTarget) {
    let target = startTarget || 0, mode = 'target';
    const pair = [0, 0];
    const body = h('div');
    const paint = () => {
      const owned = ownedIds(useComp);
      const box = h('input', { type: 'checkbox' }); box.checked = useComp;
      box.addEventListener('change', () => { useComp = box.checked; paint(); });
      body.replaceChildren(
        h('div', { class: 'chips' }, [['target', t('fu_tab_target')], ['now', t('fu_tab_now')], ['pair', t('fu_tab_pair')]]
          .map(([k, label]) => h('button', { class: 'chip' + (mode === k ? ' on' : ''), onclick: () => { mode = k; paint(); } }, label))),
        h('label', { class: 'check' }, box, ' ' + t('fu_use_comp')));
      const open = (id) => { target = id; mode = 'target'; paint(); body.parentElement.scrollTop = 0; };

      if (mode === 'target') {
        body.append(row(t('fu_target'), chooser(t('fu_target'), () => personaOptions(engine.fusible), () => target, (v) => { target = v; paint(); })));
        if (target) {
          const list = engine.recipesFor(target, owned);
          body.append(...resultNotes(target));
          if (whereOwned(target)) body.append(note(t('fu_already', { where: whereOwned(target) })));
          if (!list.length) body.append(note(t('fu_none')));
          [[t('fu_ready'), (r) => !r.missing.length], [t('fu_one'), (r) => r.missing.length === 1], [t('fu_more'), (r) => r.missing.length > 1]].forEach(([label, test]) => {
            const group = list.filter(test);
            if (group.length) body.append(heading(label + ' (' + group.length + ')'), paged(group, (r) => item(recipeText(r.ingredients, owned),
              r.missing.length ? t('fu_missing', { list: r.missing.map(personaName).join(', ') }) : ''), 10));
          });
        }
      } else if (mode === 'now') {
        const list = engine.craftable(owned);
        body.append(heading(t('fu_now_count', { n: list.length })));
        if (!list.length) body.append(note(t('fu_now_none')));
        else body.append(paged(list, (x) => item(personaName(x.id), engine.arcana(x.id) + ' · ' + t('pl_base', { n: x.level }),
          h('span', { class: 'tags' }, x.level > S().mcLevel ? tag(t('fu_tag_level'), 'bad') : null,
            unlockState(x.id) && !unlockState(x.id).done ? tag(t('fu_tag_locked'), 'bad') : null,
            whereOwned(x.id) ? tag(whereOwned(x.id), 'ok') : null), () => open(x.id)), 30));
      } else {
        const options = () => personaOptions(engine.fusible).map((o) => owned.has(o.id) ? Object.assign({}, o, { sub: '✓ ' + o.sub }) : o)
          .sort((a, b) => (owned.has(b.id) ? 1 : 0) - (owned.has(a.id) ? 1 : 0));
        [0, 1].forEach((n) => body.append(row(t('fu_ingredient', { n: n + 1 }), chooser(t('fu_ingredient', { n: n + 1 }), options, () => pair[n], (v) => { pair[n] = v; paint(); }))));
        if (pair[0] && pair[1]) {
          const r = engine.fuse(pair[0], pair[1]);
          if (r) {
            body.append(heading(t('fu_result')), item(personaName(r), engine.arcana(r) + ' · ' + t('pl_base', { n: engine.get(r).l }), null, () => open(r)), ...resultNotes(r));
          } else body.append(note(t('fu_pair_none')));
        }
      }
      body.append(note(t('fu_hint')));
    };
    openSheet(t('fusion'), body, { full: true });
    paint();
  }

  return { applyDefaults, realData, buildWarnings, compareSkills, planner, team, fusion };
};
