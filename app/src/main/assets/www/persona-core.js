/*
 * Persona knowledge on top of persona-data.js: default data, build checks, build planner,
 * resistances and two-Persona / special fusion. Pure functions; runs in the WebView and in Node.
 * Fusion rules are a port of aqiu384/megaten-fusion-tool (Unlicense).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P4GPersona = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ELEMENTS = ['Phys', 'Fire', 'Ice', 'Elec', 'Wind', 'Light', 'Dark', 'Almighty'];
  // affinity codes in the data. Anything else ('-', 'S') counts as neutral, as on the website.
  const AFFINITY_RANK = { w: 0, '-': 1, s: 2, n: 3, r: 4, d: 5 };
  const AFFINITY_BY_RANK = ['w', '-', 's', 'n', 'r', 'd'];

  function create(data, skillInfo) {
    const P = data.personas;
    const get = (id) => P[id] || null;

    // ------------------------------------------------------------ default data
    /** Base level, stats and starting skills, or null when the source has no data for this Persona. */
    function defaults(id) {
      const e = get(id);
      if (!e) return null;
      const skills = e.k.filter((x) => x[1] === 0).map((x) => x[0]).slice(0, 8);
      while (skills.length < 8) skills.push(0);
      const [st, ma, de, ag, lu] = e.s;
      return { level: e.l, st, ma, de, ag, lu, skills };
    }

    // ------------------------------------------------------------ build checks
    /** Information only: skills can legitimately arrive through fusion or Skill Cards. */
    function checkBuild(id, skills) {
      const seen = new Set(), duplicate = new Set(), foreign = new Set();
      const e = get(id);
      const own = e ? new Set(e.k.map((x) => x[0])) : null;
      for (const s of skills) {
        if (!s) continue;
        if (seen.has(s)) duplicate.add(s);
        seen.add(s);
        if (own && !own.has(s)) foreign.add(s);
      }
      return { duplicate: [...duplicate], foreign: [...foreign] };
    }

    // ------------------------------------------------------------ build planner
    /** Personas that learn at least one wanted skill: most matches first, then lowest base level. */
    function plan(wanted) {
      const want = new Set(wanted.filter(Boolean));
      const out = [];
      for (const key of Object.keys(P)) {
        const matches = P[key].k.filter((x) => want.has(x[0])).map((x) => ({ skill: x[0], level: x[1] }));
        if (matches.length) out.push({ id: Number(key), level: P[key].l, party: !!P[key].p, matches });
      }
      return out.sort((a, b) => b.matches.length - a.matches.length || a.level - b.level || a.id - b.id);
    }

    // ------------------------------------------------------------ resistances
    /** 8 affinity codes (order of ELEMENTS), including passive Resist/Null/Repel/Absorb skills; null if unknown. */
    function affinities(id, skills) {
      const src = get(id) || data.forms[id];
      if (!src) return null;
      const ranks = src.r.split('').map((c) => (AFFINITY_RANK[c] === undefined ? 1 : AFFINITY_RANK[c]));
      for (const s of skills || []) {
        const info = skillInfo[s];
        const m = info && /^(Resist|Null|Repel|Absorb) (Physical|Fire|Ice|Elec|Wind|Light|Dark)$/.exec(info.n);
        if (!m) continue;
        const el = ELEMENTS.indexOf(m[2] === 'Physical' ? 'Phys' : m[2]);
        const rank = { Resist: 2, Null: 3, Repel: 4, Absorb: 5 }[m[1]];
        ranks[el] = Math.max(ranks[el], rank);
      }
      return ranks.map((r) => AFFINITY_BY_RANK[r]);
    }
    /** team: [{id, skills}] -> per element how many are weak / protected. Unknown Personas are skipped. */
    function teamReport(team) {
      const rows = team.map((m) => affinities(m.id, m.skills));
      return ELEMENTS.slice(0, 7).map((name, i) => ({
        name,
        weak: rows.filter((r) => r && r[i] === 'w').length,
        safe: rows.filter((r) => r && AFFINITY_RANK[r[i]] >= 2).length,
      }));
    }

    // ------------------------------------------------------------ fusion
    const raceCount = data.races.length;
    const table = {};
    for (const [a, b, r] of data.chart) { table[a * raceCount + b] = r; table[b * raceCount + a] = r; }
    const isSpecial = (id) => Object.prototype.hasOwnProperty.call(data.special, id);
    const ingredients = [], results = []; // per arcana, sorted by base level
    for (let i = 0; i < raceCount; i++) { ingredients.push([]); results.push([]); }
    for (const key of Object.keys(P)) {
      const id = Number(key), e = P[key];
      if (e.p) continue; // party Personas take no part in fusion
      ingredients[e.a].push(id);
      if (!isSpecial(id)) results[e.a].push(id);
    }
    const byLevel = (a, b) => P[a].l - P[b].l;
    ingredients.forEach((l) => l.sort(byLevel));
    results.forEach((l) => l.sort(byLevel));
    const fusible = (id) => !!get(id) && !P[id].p;

    const specialPairs = new Map();
    for (const key of Object.keys(data.special)) {
      const list = data.special[key];
      if (list.length === 2) specialPairs.set(Math.min(...list) + ':' + Math.max(...list), Number(key));
    }

    /** Result id of fusing two Personas, or 0 when they cannot be fused. Symmetric. */
    function fuse(a, b) {
      if (a === b || !fusible(a) || !fusible(b)) return 0;
      const A = P[a], B = P[b];
      let result = 0;
      if (A.a === B.a) {
        // same arcana: highest result at or below (lvlA + lvlB) / 2 + 1 that is not an ingredient
        const list = results[A.a];
        for (const r of list) if (r !== a && r !== b && 2 * P[r].l <= A.l + B.l + 2) result = r;
        return result;
      }
      const race = table[A.a * raceCount + B.a];
      if (race === undefined) return 0;
      const list = results[race];
      if (!list.length) return 0;
      // different arcana: first result with base level >= (lvlA + lvlB) / 2 + 0.5, else the highest one
      let i = list.findIndex((r) => A.l + B.l <= 2 * P[r].l - 1);
      if (i < 0) i = list.length - 1;
      if (list[i] === a || list[i] === b) i++; // an ingredient cannot be the result: take the next one up
      if (i >= list.length || list[i] === a || list[i] === b) return 0;
      const special = specialPairs.get(Math.min(a, b) + ':' + Math.max(a, b));
      return special !== undefined ? special : list[i]; // "results" never contains special Personas
    }

    let cache = null;
    /** Every possible recipe grouped by result id: Map(result -> [[ids...]]). */
    function allRecipes() {
      if (cache) return cache;
      cache = new Map();
      const add = (r, recipe) => { if (!cache.has(r)) cache.set(r, []); cache.get(r).push(recipe); };
      const ids = [].concat(...ingredients).sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const r = fuse(ids[i], ids[j]);
          if (r && !isSpecial(r)) add(r, [ids[i], ids[j]]);
        }
      }
      // special Personas can only be made with their fixed recipe
      for (const key of Object.keys(data.special)) add(Number(key), data.special[key].slice());
      return cache;
    }
    /** Recipes for one target, each with the ingredients not in "owned"; fewest missing first, then cheapest levels. */
    function recipesFor(target, owned) {
      const weight = (r) => r.reduce((n, id) => n + P[id].l, 0);
      return (allRecipes().get(target) || []).map((r) => ({ ingredients: r, missing: r.filter((id) => !owned.has(id)) }))
        .sort((x, y) => x.missing.length - y.missing.length || weight(x.ingredients) - weight(y.ingredients));
    }
    /** Targets that can be fused right now from the owned Personas. */
    function craftable(owned) {
      const out = [];
      for (const [result, list] of allRecipes()) {
        const ready = list.filter((r) => r.every((id) => owned.has(id)));
        if (ready.length) out.push({ id: result, level: P[result].l, recipes: ready });
      }
      return out.sort((a, b) => a.level - b.level || a.id - b.id);
    }

    return {
      get, defaults, checkBuild, plan, affinities, teamReport, fuse, recipesFor, craftable, fusible, isSpecial,
      arcana: (id) => (get(id) && P[id].a >= 0 ? data.races[P[id].a] : ''),
    };
  }

  return { create, ELEMENTS };
});
