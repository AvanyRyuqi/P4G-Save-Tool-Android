/*
 * P4G Save Tool - Persona knowledge: defaults, element affinities and fusion recipes.
 * Data comes from persona-data.js. Runs unchanged in the Android WebView and in Node (see /tests).
 *
 * The fusion rules are ported from aqiu384/megaten-fusion-tool (Unlicense) as configured for
 * Persona 4 Golden. Two-Persona recipes come from that tool's forward rules applied to every pair,
 * so an ingredient is never listed as its own result and a pair with a special recipe is not
 * offered for anything else. Triple recipes follow its "which ingredients give this result" rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P4GPersona = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ELEMENTS = ['phy', 'fir', 'ice', 'ele', 'win', 'lig', 'dar', 'alm'];

  // Resistance codes: w weak, - normal, S partial (light/dark only), s strong, n null, r repel, d drain.
  const RANK = { w: 0, '-': 1, S: 2, s: 3, n: 4, r: 5, d: 6 };
  // Passive skills that replace an affinity, e.g. "Null Fire".
  const SKILL_ELEM = { Physical: 0, Fire: 1, Ice: 2, Elec: 3, Wind: 4, Light: 5, Dark: 6 };
  const SKILL_CODE = { Resist: 's', Null: 'n', Repel: 'r', Absorb: 'd' };

  function create(data, db, xpForLevel) {
    const info = (id) => data.personas[id] || null;

    // ------------------------------------------------------------- defaults
    /** Fields of a freshly obtained Persona, or null when there is no base data for it.
     *  A level below the base level is raised to the base level. Stats are always the base stats. */
    function defaults(id, level) {
      const d = info(id);
      if (!d || d.l == null) return null;
      const lv = Math.max(d.l, Math.min(99, level || d.l));
      // innate skills plus those learned up to lv; only the latest 8 fit
      const skills = d.k.filter((k) => k[1] <= lv).map((k) => k[0]).slice(-8);
      while (skills.length < 8) skills.push(0);
      const [st, ma, de, ag, lu] = d.s;
      return { level: lv, totalxp: xpForLevel(lv), skills, st, ma, de, ag, lu };
    }
    /** Writes the defaults onto a save record. Returns false (record untouched) without base data. */
    function applyDefaults(p, id, level) {
      const x = defaults(id, level);
      if (!x) return false;
      Object.assign(p, x, { id, exists: true });
      return true;
    }

    // ----------------------------------------------------------- affinities
    /** [{elem, code, base, skill}] for the 8 elements, or null when the Persona is not in the data. */
    function affinities(id, skills) {
      const d = info(id);
      if (!d) return null;
      const cells = ELEMENTS.map((elem, i) => ({ elem, code: d.x[i], base: d.x[i], skill: 0 }));
      for (const sid of skills || []) {
        const m = /^(Resist|Null|Repel|Absorb) (Physical|Fire|Ice|Elec|Wind|Light|Dark)$/.exec(db.allSkills[sid] || '');
        if (!m) continue;
        const cell = cells[SKILL_ELEM[m[2]]], code = SKILL_CODE[m[1]];
        if (RANK[code] > RANK[cell.code]) { cell.code = code; cell.skill = sid; }
      }
      return cells;
    }
    /** Per element: how many of the given affinity lists are weak / protected (strong or better). */
    function teamSummary(lists) {
      return ELEMENTS.map((elem, i) => ({
        elem,
        weak: lists.filter((c) => c && c[i].code === 'w').length,
        guard: lists.filter((c) => c && RANK[c[i].code] >= RANK.s).length,
      }));
    }

    // --------------------------------------------------------------- fusion
    const races = data.chart.races;
    const raceOrder = {};
    races.concat('World').forEach((r, i) => { raceOrder[r] = i; });

    const pool = {};          // id -> {race, lvl} of every Persona that takes part in fusion
    const ingredients = {};   // race -> levels, ascending
    const results = {};       // race -> levels reachable by chart fusion (special results excluded)
    const byLevel = {};       // race -> level -> id
    Object.keys(raceOrder).forEach((r) => { ingredients[r] = []; results[r] = []; byLevel[r] = {}; });
    Object.keys(data.personas).map(Number).forEach((id) => {
      const d = data.personas[id];
      if (d.p || d.a) return; // party Personas and duplicate ids
      pool[id] = { race: d.r, lvl: d.l };
      ingredients[d.r].push(d.l);
      if (!data.special[id]) results[d.r].push(d.l);
      byLevel[d.r][d.l] = id;
    });
    Object.keys(raceOrder).forEach((r) => { ingredients[r].sort((a, b) => a - b); results[r].sort((a, b) => a - b); });

    // The chart's upper triangle is normal fusion, the lower triangle (with the diagonal) triple fusion.
    const normFusion = {}, normFission = {}, triFusion = {}, triFission = {};
    const link = (fusion, fission, a, b, res) => {
      if (res === '-') return;
      (fusion[a] = fusion[a] || {})[b] = res;
      (fusion[b] = fusion[b] || {})[a] = res;
      const byResult = fission[res] = fission[res] || {};
      (byResult[a] = byResult[a] || []).push(b);
    };
    races.forEach((a, r) => races.forEach((b, c) => {
      if (c > r) link(normFusion, normFission, a, b, data.chart.table[r][c]);
      if (c <= r) link(triFusion, triFission, a, b, data.chart.table[r][c]);
    }));

    const NORM_MOD = 0.5, TRI_MOD = 4.25;
    const findBin = (n, bins) => {
      let i = 0;
      while (i < bins.length && n > bins[i]) i++;
      return i === bins.length ? -1 : i;
    };

    // two-ingredient special recipes take precedence over the chart
    const specialPair = {};
    Object.keys(data.special).forEach((r) => {
      const ing = data.special[r];
      if (ing.length === 2) specialPair[ing.slice().sort((x, y) => x - y).join()] = Number(r);
    });

    /** Result of fusing two Persona (ids), or null when they cannot be fused. */
    function fusePair(a, b) {
      if (a === b || !pool[a] || !pool[b]) return null;
      const special = specialPair[a < b ? a + ',' + b : b + ',' + a];
      if (special) return special;
      const x = pool[a], y = pool[b], sum = x.lvl + y.lvl;
      if (x.race === y.race) {
        // same arcana: the highest other Persona of that arcana not above the average (+1)
        const fit = results[x.race].filter((l) => l !== x.lvl && l !== y.lvl && 2 * l <= sum + 2);
        return fit.length ? byLevel[x.race][fit[fit.length - 1]] : null;
      }
      const race = (normFusion[x.race] || {})[y.race];
      if (!race || !results[race].length) return null;
      // different arcana: the first result at or above the average (+ modifier), else the highest
      const res = results[race];
      let i = res.findIndex((l) => sum <= 2 * (l - NORM_MOD));
      if (i < 0) i = res.length - 1;
      // an ingredient cannot be its own result: move up one
      const r = byLevel[race][res[i]];
      if (r !== a && r !== b) return r;
      return i + 1 < res.length ? byLevel[race][res[i + 1]] : null;
    }

    let pairTable = null; // result id -> [[a, b]], built on first use
    function pairsFor(id) {
      if (!pairTable) {
        pairTable = {};
        const ids = Object.keys(pool).map(Number);
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            const r = fusePair(ids[i], ids[j]);
            if (r) (pairTable[r] = pairTable[r] || []).push([ids[i], ids[j]]);
          }
        }
      }
      return (pairTable[id] || []).slice();
    }

    // "a ranks above b": higher level, ties broken by arcana order
    const above = (a, b) => pool[a].lvl > pool[b].lvl || (pool[a].lvl === pool[b].lvl && raceOrder[pool[a].race] < raceOrder[pool[b].race]);
    const each = (race, fn) => { for (const l of ingredients[race] || []) fn(byLevel[race][l], l); };
    const push = (map, key, value) => (map[key] = map[key] || []).push(value);

    function tripleDiffRace(id) {
      const out = [];
      const { race, lvl } = pool[id];
      const res = results[race], at = res.indexOf(lvl);
      if (at < 0) return out;
      // race of the highest ingredient -> races it can pair with in the triple chart
      const partners = {};
      for (const [t1, t2s] of Object.entries(triFission[race] || {})) {
        partners[t1] = partners[t1] || [];
        for (const t2 of t2s) {
          partners[t2] = partners[t2] || [];
          if (t1 !== t2) partners[t1].push(t2);
          partners[t2].push(t1);
        }
      }
      const min = at > 0 ? 3 * res[at - 1] - 3 * TRI_MOD : 0;
      const max = 3 * lvl - 3 * TRI_MOD;
      for (const [t1, t2s] of Object.entries(partners)) {
        // the other two ingredients: any normal pair giving t2, or t2 together with itself
        const pairs = {};
        for (const t2 of t2s) {
          for (const [n1, n2s] of Object.entries(normFission[t2] || {})) n2s.forEach((n2) => push(pairs, n1, n2));
        }
        for (const t2 of t2s) if (t1 !== t2) push(pairs, t2, t2);

        each(t1, (a, la) => {
          if (a === id) return;
          for (const [n1, n2s] of Object.entries(pairs)) {
            each(n1, (b, lb) => {
              if (b === a || b === id || !above(a, b)) return;
              for (const n2 of n2s) {
                each(n2, (c, lc) => {
                  if (c === b || c === a || c === id || (n1 === n2 && lb >= lc) || !above(a, c)) return;
                  if (min - la - lb < lc && lc <= max - la - lb) out.push([a, b, c]);
                });
              }
            });
          }
        });
      }
      return out;
    }

    function tripleSameRace(id) {
      const out = [];
      const { race, lvl } = pool[id];
      const ing = ingredients[race].filter((l) => l !== lvl);
      for (let i = 0; i < ing.length; i++) {
        for (let j = i + 1; j < ing.length; j++) {
          for (let k = j + 1; k < ing.length; k++) {
            const a = ing[i], b = ing[j], c = ing[k];
            const bins = results[race].filter((l) => l !== a && l !== b && l !== c);
            const bin = findBin((a + b + c) / 3 + TRI_MOD, bins);
            if (bin !== -1 && bins[bin] === lvl) out.push([byLevel[race][a], byLevel[race][b], byLevel[race][c]]);
          }
        }
      }
      return out;
    }

    // Forward triple fusion with the Persona `fixed` as one ingredient, reduced to those giving `target`.
    function triplesWith(fixed, target) {
      const out = [];
      const { race: fRace, lvl: fLvl } = pool[fixed];
      const mod = 3 * TRI_MOD;
      const keep = (a, b, resRace, bins, topLvl, sumLvl) => {
        const bin = findBin(topLvl, bins.map((l) => 3 * l - mod - sumLvl));
        if (bin === -1) return;
        let r = byLevel[resRace][bins[bin]];
        if (r === a || r === b || r === fixed) r = bin + 1 < bins.length ? byLevel[resRace][bins[bin + 1]] : null;
        if (r === target) out.push([a, b]);
      };

      // `fixed` is the highest ingredient
      const asTop = {};
      for (const [t2, resRace] of Object.entries(triFusion[fRace] || {})) {
        asTop[t2] = asTop[t2] || {};
        if (fRace !== t2) asTop[t2][t2] = resRace;
        for (const [n1, n2s] of Object.entries(normFission[t2] || {})) {
          asTop[n1] = asTop[n1] || {};
          n2s.forEach((n2) => { asTop[n1][n2] = resRace; });
        }
      }
      for (const [n1, n2s] of Object.entries(asTop)) {
        each(n1, (a, la) => {
          if (a === fixed || !above(fixed, a)) return;
          for (const [n2, resRace] of Object.entries(n2s)) {
            each(n2, (b, lb) => {
              if (b === a || b === fixed || (n1 === n2 && la >= lb) || !above(fixed, b)) return;
              keep(a, b, resRace, results[resRace], lb, fLvl + la);
            });
          }
        });
      }

      // `fixed` is one of the two lower ingredients
      const asLow = {};
      asLow[fRace] = Object.assign({}, triFusion[fRace]);
      delete asLow[fRace][fRace];
      for (const [n2, t2] of Object.entries(normFusion[fRace] || {})) asLow[n2] = triFusion[t2] || {};
      for (const [n2, tops] of Object.entries(asLow)) {
        each(n2, (a, la) => {
          if (a === fixed) return;
          for (const [t1, resRace] of Object.entries(tops)) {
            each(t1, (b, lb) => {
              if (b === a || b === fixed || !above(b, fixed) || !above(b, a)) return;
              keep(a, b, resRace, results[resRace], lb, fLvl + la);
            });
          }
        });
      }
      return out;
    }

    // Fusing "up": two others plus the previous Persona of the same arcana give the next one.
    function triplePrevLevel(id) {
      const { race, lvl } = pool[id];
      const at = results[race].indexOf(lvl);
      if (at <= 0) return [];
      const prev = byLevel[race][results[race][at - 1]];
      return triplesWith(prev, id).map(([a, b]) => [a, b, prev]);
    }

    /** Every way to obtain a Persona by fusion. Triples are optional because there can be thousands.
     *  Returns null for Personas that never take part in fusion (party members, no data). */
    function recipes(id, opts) {
      if (!pool[id]) return null;
      const special = data.special[id] || null;
      const triples = [];
      if (opts && opts.triple && !special) {
        const seen = new Set();
        for (const t of tripleDiffRace(id).concat(tripleSameRace(id), triplePrevLevel(id))) {
          const key = t.slice().sort((a, b) => a - b).join();
          if (!seen.has(key)) { seen.add(key); triples.push(t); }
        }
      }
      return { special, pairs: special ? [] : pairsFor(id), triples };
    }

    /** Sorts recipes: fewest missing ingredients first, then the lowest total level.
     *  `owned` is a Set of Persona ids. */
    function rank(list, owned) {
      return list.map((ids) => ({
        ids, missing: ids.filter((x) => !owned.has(x)).length, total: ids.reduce((n, x) => n + pool[x].lvl, 0),
      })).sort((a, b) => a.missing - b.missing || a.total - b.total);
    }

    return {
      info, defaults, applyDefaults, affinities, teamSummary, recipes, rank, fusePair,
      canFuse: (id) => !!pool[id],
      base: (id) => pool[id] || null,
      /** Ids that can be a fusion result, by arcana then level. */
      targets: () => Object.keys(pool).map(Number).sort((a, b) => raceOrder[pool[a].race] - raceOrder[pool[b].race] || pool[a].lvl - pool[b].lvl),
      unlock: (id) => data.unlock[id] || '',
    };
  }

  return { create, ELEMENTS };
});
