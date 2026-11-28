/*
 * P4G Save Tool - read-only screens: shadow bestiary, dream Persona planner and broadcast card.
 * app.js hands over its helpers; none of these screens changes the save.
 */
window.P4GScreens = function (ui) {
  'use strict';
  const { h, t, openSheet, pick, toast, DB, PK, ELEM_NAMES, AFF_LABEL, affCell, personaName, skillName } = ui;
  const metaData = window.P4G_PERSONA_DATA;
  const SH = P4GShadows.create(window.P4G_SHADOW_DATA);
  const PL = P4GPlanner.create(metaData, PK);
  const elemShort = (i) => (i === 7 ? 'Alm.' : ELEM_NAMES[i]);
  const chips = (options, current, onPick, cls) => h('div', { class: 'chips' + (cls ? ' ' + cls : '') },
    options.map(([value, label]) => h('button', { class: 'chip' + (value === current ? ' on' : ''), 'aria-pressed': String(value === current), onclick: () => onPick(value) }, label)));
  const checkbox = (label, checked, onChange) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return h('label', { class: 'check' }, box, label);
  };
  const searchBox = (placeholder, value, onInput) => {
    const input = h('input', { type: 'text', class: 'search', placeholder, value, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
    input.addEventListener('input', () => onInput(input.value));
    return input;
  };
  const hint = (text, cls) => h('p', { class: 'hint' + (cls ? ' ' + cls : '') }, text);
  const heading = (text) => h('h5', { class: 'sub' }, text);

  // ================================================================ bestiary
  const book = { view: 'list', dungeon: null, weakTo: null, query: '', item: '', lead: null };

  function affStrip(codes) {
    return h('div', { class: 'aff' }, codes.split('').map((code, i) => h('span', { class: 'cell' }, h('small', null, elemShort(i)), affCell({ code }))));
  }
  function showShadow(e) {
    const line = (label, value) => h('div', { class: 'learn' }, h('span', null, label), h('small', null, value));
    openSheet(e.n, h('div', null,
      hint([e.a, 'Lv ' + e.l, e.p ? t('sh_special') : ''].filter(Boolean).join(' · ')),
      affStrip(e.x),
      line('HP / SP', e.h + ' / ' + e.m),
      line('St Ma En Ag Lu', e.s.join(' ')),
      line('EXP / ' + t('sh_yen'), e.e + ' / ' + e.y),
      line(t('sh_area'), e.w),
      heading(t('sh_skills')), h('p', null, e.k.join(', ') || '—'),
      heading(t('sh_drops')), e.d.length ? e.d.map(([item, odds]) => line(item, odds + '%')) : hint('—')), { full: true });
  }
  function shadowRow(e) {
    return h('button', { class: 'item shadow', onclick: () => showShadow(e) },
      h('span', { class: 'line' }, h('b', null, e.n), h('small', null, 'Lv ' + e.l + ' · HP ' + e.h + (e.p ? ' · ' + t('sh_special') : ''))),
      affStrip(e.x));
  }

  function showShadows() {
    const S = ui.state();
    const head = h('div'), body = h('div', { class: 'list' });
    let limit = 30;
    const dungeonName = () => (book.dungeon == null ? t('sh_all') : SH.dungeons[book.dungeon]);
    const refresh = () => { limit = 30; paintHead(); paint(); };
    function paintHead() {
      head.replaceChildren(chips([['list', t('sh_tab_list')], ['team', t('sh_tab_team')], ['items', t('sh_tab_items')]], book.view, (v) => { book.view = v; refresh(); }));
      if (book.view !== 'items') {
        head.append(h('button', { class: 'select', type: 'button', onclick: async () => {
          const options = [{ id: -1, name: t('sh_all'), sub: '' }].concat(SH.dungeons.map((d, i) => ({ id: i, name: d, sub: String(SH.find({ dungeon: i }).length) })));
          const id = await pick(t('sh_dungeon'), options, book.dungeon == null ? -1 : book.dungeon);
          if (id !== undefined) { book.dungeon = id < 0 ? null : id; refresh(); }
        } }, h('span', { class: 'v' }, dungeonName())));
      }
      if (book.view === 'list') {
        head.append(searchBox(t('sh_search'), book.query, (v) => { book.query = v; limit = 30; paint(); }),
          hint(t('sh_weak_filter')),
          chips([[null, t('sh_any')]].concat([0, 1, 2, 3, 4, 5, 6].map((i) => [i, ELEM_NAMES[i]])), book.weakTo, (v) => { book.weakTo = v; refresh(); }, 'wrap'));
      }
      if (book.view === 'items') head.append(searchBox(t('sh_item_search'), book.item, (v) => { book.item = v; limit = 30; paint(); }));
    }
    function more(total) {
      if (total > limit) body.append(h('button', { class: 'btn', onclick: () => { limit += 30; paint(); } }, t('show_more', { n: total - limit })));
    }
    function paintList() {
      const hit = SH.find(book);
      body.append(hint(t('sh_count', { n: hit.length })));
      hit.slice(0, limit).forEach((e) => body.append(shadowRow(e)));
      more(hit.length);
      if (!hit.length) body.append(h('p', { class: 'empty' }, t('sh_none')));
    }
    function paintItems() {
      const hit = SH.drops(book.item);
      body.append(hint(t('sh_item_count', { n: hit.length })));
      hit.slice(0, limit).forEach((x) => body.append(h('div', { class: 'card drop' }, h('h3', null, x.item),
        x.sources.map((s) => h('button', { class: 'learn', onclick: () => showShadow(s.enemy) },
          h('span', null, s.enemy.n + ' (' + s.odds + '%)'), h('small', null, s.enemy.w))))));
      more(hit.length);
      if (!hit.length) body.append(h('p', { class: 'empty' }, t('no_results_for', { q: book.item.trim() })));
    }
    function paintTeam() {
      const list = SH.find({ dungeon: book.dungeon });
      const filled = S.mcSlots.map((p, i) => ({ p, i })).filter((x) => x.p.id);
      if (!filled.some((x) => x.i === book.lead)) book.lead = filled.some((x) => x.i === ui.slot()) ? ui.slot() : (filled.length ? filled[0].i : 0);
      const team = ui.team(book.lead);
      team.forEach((m) => { const c = m.p && m.p.id ? PK.affinities(m.p.id, m.p.skills) : null; m.codes = c && c.map((x) => x.code); });
      if (filled.length > 1) body.append(chips(filled.map((x) => [x.i, personaName(x.p.id)]), book.lead, (v) => { book.lead = v; paint(); }));
      body.append(hint(t('sh_team_hint', { n: list.length, place: dungeonName(), team: team.map((m) => m.who.split(' ')[0]).join(', ') })));
      const unknown = team.filter((m) => !m.codes);
      if (unknown.length) body.append(hint(t('sh_unknown', { who: unknown.map((m) => m.who).join(', ') }), 'warn'));

      const threats = SH.threats(list, team);
      body.append(heading(t('sh_danger')));
      if (!threats.length) body.append(hint(t('sh_danger_none')));
      threats.forEach((r) => body.append(h('div', { class: 'item danger' },
        h('b', null, ELEM_NAMES[r.i] + ': ' + r.weak.map((w) => w.split(' ')[0]).join(', ')),
        h('small', null, t('sh_danger_row', { n: r.attackers })))));

      // team members holding an attack skill of an element
      const holders = (i) => team.filter((m) => m.p && m.p.id && m.p.skills.some((s) => metaData.skills[s] && metaData.skills[s][0] === P4GPersona.ELEMENTS[i]))
        .map((m) => m.who.split(' ')[0]);
      const adv = SH.advice(list);
      body.append(heading(t('sh_bring')));
      adv.best.forEach((r) => {
        const who = holders(r.i);
        body.append(h('div', { class: 'item col' }, h('b', null, ELEM_NAMES[r.i]),
          h('small', null, t('sh_bring_row', { weak: r.weak, block: r.block })),
          h('small', { class: who.length ? 'ok' : 'warn' }, who.length ? t('sh_have', { who: who.join(', ') }) : t('sh_have_none'))));
      });
      if (adv.risky.length) body.append(heading(t('sh_avoid')),
        ...adv.risky.map((r) => h('div', { class: 'item col' }, h('b', null, ELEM_NAMES[r.i]), h('small', null, t('sh_avoid_row', { n: r.back })))));

      body.append(heading(t('sh_table')), h('table', { class: 'sum' },
        h('tr', null, [t('sk_elem'), t('sh_col_weak'), t('sh_col_strong'), t('sh_col_block'), t('sh_col_attack')].map((x) => h('th', null, x))),
        SH.summary(list).map((r) => h('tr', null, h('th', null, ELEM_NAMES[r.i]), [r.weak, r.strong, r.block, r.attackers].map((n) => h('td', null, String(n)))))));
      body.append(hint(t('sh_note')));
    }
    function paint() {
      body.replaceChildren();
      ({ list: paintList, team: paintTeam, items: paintItems })[book.view]();
    }
    paintHead(); paint();
    openSheet(t('sh_title'), h('div', null, head, body), { full: true });
  }

  // ================================================================ planner
  const form = { target: 0, skills: [], allowNew: true, limitLevel: true };

  const personaLabel = (id) => { const b = PK.base(id); return b.race + ' · Lv ' + b.lvl; };
  function ownedList(S) {
    const out = [];
    S.mcSlots.forEach((p) => { if (p.id) out.push({ id: p.id, level: p.level, skills: p.skills.slice(), src: 'slot' }); });
    S.compendium.forEach((p) => { if (p.id) out.push({ id: p.id, level: p.level, skills: p.skills.slice(), src: 'comp' }); });
    return out;
  }
  const SOURCE = { slot: 'pl_src_slot', comp: 'pl_src_comp', new: 'pl_src_new' };

  /** Draws a found route: what to prepare first, then the actions in order. */
  function routeView(result, heroLevel, inSlots) {
    const steps = result.steps, el = h('div');
    const names = (ids) => ids.map(skillName).join(', ');
    const actions = steps.filter((s) => s.type !== 'get');
    const number = new Map(actions.map((s, i) => [s, i + 1]));
    const ref = (i) => personaName(steps[i].id) + (number.has(steps[i]) ? ' (' + t('pl_from_step', { n: number.get(steps[i]) }) + ')' : '');

    const gets = steps.filter((s) => s.type === 'get');
    const uses = {};
    // two copies of one Persona count separately when their level or wanted skills differ
    const keyOf = (s) => [s.id, s.src, s.level, s.has.join()].join('/');
    gets.forEach((s) => { uses[keyOf(s)] = (uses[keyOf(s)] || 0) + 1; });
    el.append(heading(t('pl_prepare')));
    const shown = new Set();
    gets.forEach((s) => {
      const key = keyOf(s);
      if (shown.has(key)) return;
      shown.add(key);
      const level = s.src === 'new' ? PK.base(s.id).lvl : s.level;
      el.append(h('div', { class: 'item step ' + s.src },
        h('b', null, personaName(s.id) + ' · Lv ' + level),
        h('small', null, t(SOURCE[s.src])),
        s.has.length ? h('small', null, t('pl_carries', { skills: names(s.has) })) : null,
        // a Compendium Persona can simply be summoned again
        uses[key] > 1 && s.src !== 'comp' ? h('small', { class: 'warn' }, t('pl_twice', { n: uses[key] })) : null,
        s.src === 'new' && heroLevel && level > heroLevel ? h('small', { class: 'warn' }, t('pl_above', { lv: heroLevel })) : null,
        s.src === 'new' && PK.unlock(s.id) ? h('small', { class: 'warn' }, t('fu_unlock', { c: PK.unlock(s.id) })) : null));
    });

    el.append(heading(t('pl_order')));
    const list = h('ol', { class: 'route' });
    actions.forEach((s) => {
      if (s.type === 'level') {
        list.append(h('li', { class: 'item' },
          h('b', null, t('pl_level', { name: personaName(s.id), lv: s.level })),
          h('small', null, t('pl_learns', { skills: names(s.learn) }))));
      } else {
        list.append(h('li', { class: 'item' },
          h('b', null, s.from.map(ref).join(' + ') + ' = ' + personaName(s.id)),
          h('small', null, s.inherit.length ? t('pl_inherit', { skills: names(s.inherit) }) : t('pl_inherit_none')),
          h('small', null, t('pl_slots', { slots: s.slots, n: s.distinct })),
          heroLevel && PK.base(s.id).lvl > heroLevel ? h('small', { class: 'warn' }, t('pl_above', { lv: heroLevel })) : null,
          inSlots.has(s.id) ? h('small', { class: 'warn' }, t('pl_held', { name: personaName(s.id) })) : null,
          PK.unlock(s.id) ? h('small', { class: 'warn' }, t('fu_unlock', { c: PK.unlock(s.id) })) : null));
      }
    });
    el.append(list, hint(t('pl_how')), hint(t('pl_rule_note')));
    return el;
  }

  function showPlanner(start) {
    const S = ui.state();
    if (!S) return;
    if (start && PK.canFuse(start) && start !== form.target) { form.target = start; form.skills = []; }
    const head = h('div'), out = h('div', { class: 'list', 'aria-live': 'polite' });
    let job = 0, closed = false; // a changed request or a closed sheet cancels the running search

    const reset = () => { job++; out.replaceChildren(); paint(); };
    const possible = (sid) => !PL.blocker(form.target, sid, ownedList(S));

    function run() {
      const mine = ++job;
      const search = PL.start({ target: form.target, skills: form.skills, owned: ownedList(S), allowNew: form.allowNew, maxLevel: form.limitLevel ? S.mcLevel : 0 });
      const progress = h('p', { class: 'hint' }, t('pl_searching'));
      out.replaceChildren(progress, h('button', { class: 'btn', onclick: () => { job++; out.replaceChildren(); } }, t('cancel')));
      const slice = () => {
        if (closed || mine !== job) return;
        const until = Date.now() + 40;
        let x;
        do { x = search.next(); } while (!x.done && Date.now() < until);
        if (!x.done) { progress.textContent = t('pl_searched', { n: x.value }); setTimeout(slice, 0); return; }
        show(x.value);
      };
      setTimeout(slice, 30);
    }
    function show(r) {
      out.replaceChildren();
      const target = personaName(form.target);
      if (r.status === 'ok') out.append(routeView(r, S.mcLevel, new Set(S.mcSlots.map((p) => p.id).filter(Boolean))));
      else if (r.status === 'owned') out.append(h('p', { class: 'empty' }, t('pl_owned', { name: target, where: t(SOURCE[r.owned.src]) })));
      else if (r.status === 'blocked') {
        r.blocked.forEach((b) => out.append(h('p', { class: 'hint warn' }, t('pl_block_' + b.why, { skill: skillName(b.skill), name: target }))));
      } else if (r.level) out.append(h('p', { class: 'hint warn' }, t('pl_level_block', { name: target, need: r.level, lv: S.mcLevel })));
      else {
        out.append(h('p', { class: 'empty' }, t(r.exhausted ? 'pl_none' : 'pl_budget')),
          hint([!form.allowNew ? t('pl_try_new') : '', form.limitLevel ? t('pl_try_level') : '', form.skills.length > 1 ? t('pl_try_fewer') : ''].filter(Boolean).join(' ')));
      }
    }

    async function addSkill() {
      const options = Object.keys(metaData.skills).map(Number)
        .filter((sid) => DB.allSkills[sid] && !form.skills.includes(sid) && possible(sid))
        .map((sid) => {
          const lv = PL.learnLevel(form.target, sid);
          return { id: sid, name: skillName(sid), desc: ui.skillSummary(sid), sub: lv == null ? t('pl_by_inherit') : lv ? t('pl_by_level', { lv }) : t('sk_innate') };
        });
      const id = await pick(t('pl_pick_skill'), options);
      if (id !== undefined) { form.skills.push(id); reset(); }
    }
    function paint() {
      head.replaceChildren(h('p', { class: 'hint', style: 'margin-top:0' }, t('pl_intro')),
        h('button', { class: 'select', type: 'button', onclick: async () => {
          const id = await pick(t('fu_pick'), PK.targets().map((x) => ({ id: x, name: personaName(x), sub: personaLabel(x) })), form.target);
          if (id !== undefined && id !== form.target) { form.target = id; form.skills = form.skills.filter(possible); reset(); }
        } }, h('span', { class: 'v' }, form.target ? personaName(form.target) : t('fu_pick'))));
      if (!form.target) return;
      head.append(hint(personaLabel(form.target)), heading(t('pl_wanted', { n: form.skills.length, max: PL.MAX_WANTED })));
      form.skills.forEach((sid) => head.append(h('div', { class: 'wanted' },
        h('span', null, skillName(sid), h('small', null, ui.skillSummary(sid))),
        h('button', { class: 'iconbtn', 'aria-label': t('pl_remove', { skill: skillName(sid) }), onclick: () => { form.skills = form.skills.filter((x) => x !== sid); reset(); } }, '✕'))));
      if (form.skills.length < PL.MAX_WANTED) head.append(h('button', { class: 'btn', onclick: addSkill }, t('pl_add')));
      head.append(checkbox(t('pl_allow_new'), form.allowNew, (v) => { form.allowNew = v; reset(); }),
        checkbox(t('pl_limit', { lv: S.mcLevel }), form.limitLevel, (v) => { form.limitLevel = v; reset(); }),
        h('button', { class: 'btn accent wide', disabled: !form.skills.length, onclick: run }, t('pl_go')));
    }
    paint();
    openSheet(t('pl_title'), h('div', null, head, out), { full: true, onClose: () => { closed = true; } });
  }

  // ================================================================ card
  const look = { who: 'team', style: 'tv', lead: null };

  function member(who, p) {
    const base = PK.info(p.id);
    const cells = PK.affinities(p.id, p.skills);
    return {
      who, persona: personaName(p.id), arcana: base ? base.r : '', level: p.level, stats: [p.st, p.ma, p.de, p.ag, p.lu],
      skills: p.skills.filter(Boolean).map(skillName),
      aff: (cells || []).map((c) => ({ code: c.code, label: AFF_LABEL[c.code] })),
    };
  }

  function showCard() {
    const S = ui.state();
    if (!S) return;
    const body = h('div');
    const canvas = document.createElement('canvas');
    const filled = S.mcSlots.map((p, i) => ({ p, i })).filter((x) => x.p.id);
    if (!filled.some((x) => x.i === look.lead)) look.lead = filled.some((x) => x.i === ui.slot()) ? ui.slot() : (filled.length ? filled[0].i : 0);
    function paint() {
      const team = (look.who === 'team' ? ui.team(look.lead) : ui.team(look.lead).slice(0, 1)).filter((m) => m.p && m.p.id);
      body.replaceChildren(chips([['team', t('cd_team')], ['one', t('cd_one')]], look.who, (v) => { look.who = v; paint(); }));
      if (filled.length > 1) body.append(chips(filled.map((x) => [x.i, personaName(x.p.id)]), look.lead, (v) => { look.lead = v; paint(); }));
      body.append(chips([['tv', t('theme_tv')], ['midnight', t('theme_midnight')]], look.style, (v) => { look.style = v; paint(); }));
      if (!team.length) { body.append(h('p', { class: 'empty' }, t('cd_empty'))); return; }
      P4GCard.draw(canvas, {
        title: look.who === 'team' ? t('cd_title_team', { name: ui.protagName() }) : personaName(team[0].p.id),
        subtitle: look.who === 'team' ? t('cd_subtitle', { lv: S.mcLevel }) : t('cd_subtitle_one', { name: team[0].who, lv: S.mcLevel }),
        footer: t('cd_footer'),
        elements: P4GPersona.ELEMENTS.map((e, i) => elemShort(i)),
        stats: ['ST', 'MA', 'DE', 'AG', 'LU'],
        members: team.map((m) => member(m.who, m.p)),
      }, look.style);
      const url = canvas.toDataURL('image/png');
      const name = look.who === 'team' ? 'p4g-team.png' : 'p4g-persona.png';
      const send = () => {
        if (ui.bridge && ui.bridge.shareFile) ui.bridge.shareFile(name, url.slice(url.indexOf(',') + 1));
        else {
          const a = h('a', { href: url, download: name });
          document.body.append(a); a.click(); a.remove(); toast(t('downloaded'));
        }
      };
      body.append(h('button', { class: 'btn accent wide', onclick: send }, ui.bridge && ui.bridge.shareFile ? t('cd_share') : t('cd_save')),
        h('img', { class: 'cardpreview', src: url, alt: t('cd_alt', { names: team.map((m) => personaName(m.p.id)).join(', ') }) }));
    }
    paint();
    openSheet(t('cd_title'), body, { full: true });
  }

  return { showShadows, showPlanner, showCard };
};
