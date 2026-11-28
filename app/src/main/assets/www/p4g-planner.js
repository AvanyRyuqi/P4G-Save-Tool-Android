/*
 * P4G Save Tool - dream Persona planner: finds a chain of fusions that ends with a chosen Persona
 * holding chosen skills. Runs unchanged in the Android WebView and in Node (see /tests).
 *
 * Rules used (data in persona-data.js, from aqiu384/megaten-fusion-tool):
 *  - a skill reaches a result only if the result's inheritance type allows its element and the
 *    skill is not exclusive; passive skills have no element restriction;
 *  - the number of inherited skills depends on how many different skills the ingredients carry
 *    (thresholds as observed in the original Persona 4, see SLOT_STEPS);
 *  - a Persona may also learn wanted skills itself by levelling up.
 * The planner only counts skills it can be sure about, so it never promises more inherit slots
 * than those thresholds give.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P4GPlanner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_WANTED = 6;
  // [different skills among the ingredients, inherited skills]
  const SLOT_STEPS = [[24, 5], [12, 4], [9, 3], [6, 2], [1, 1]];
  const slotsFor = (n) => { for (const [min, slots] of SLOT_STEPS) if (n >= min) return slots; return 0; };

  // search costs: one fusion = 1
  const COST_NEW = 2;           // obtain a Persona you do not own, plus level / 50
  const COST_LEVEL = 0.3;       // level one up, plus 1/20 per level
  const MAX_SETTLED = 3500;     // search budget; beyond it the planner gives up
  const GUIDE = 0.6;            // queue order favours states that already hold more wanted skills
  const RICH = 6;               // a Persona with this many skills raises the inherit slots on its own
  const IDS = 256;              // Persona ids fit below this

  const bits = (m) => { let n = 0; for (; m; m &= m - 1) n++; return n; };

  /** Minimal binary heap ordered by cost, then insertion. */
  function heap() {
    const a = [];
    const less = (x, y) => x.rank < y.rank || (x.rank === y.rank && x.seq < y.seq);
    return {
      push(v) {
        let i = a.push(v) - 1;
        while (i > 0) { const p = (i - 1) >> 1; if (!less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
      },
      pop() {
        if (!a.length) return null;
        const top = a[0], last = a.pop();
        if (a.length) {
          a[0] = last;
          for (let i = 0; ;) {
            let m = i; const l = 2 * i + 1, r = l + 1;
            if (l < a.length && less(a[l], a[m])) m = l;
            if (r < a.length && less(a[r], a[m])) m = r;
            if (m === i) break;
            [a[i], a[m]] = [a[m], a[i]]; i = m;
          }
        }
        return top;
      },
    };
  }

  function create(data, PK) {
    const meta = (sid) => data.skills[sid] || null;
    const entry = (id) => data.personas[id];

    /** Can this Persona receive the skill through fusion? */
    function canInherit(id, sid) {
      const d = entry(id), m = meta(sid);
      if (!d || !d.i || !m || m[1]) return false;
      return m[0] === 'pas' || data.inherit[d.i].includes(m[0]);
    }
    /** Level at which the Persona learns the skill by itself (0 = comes with it), or null. */
    function learnLevel(id, sid) {
      const d = entry(id);
      const k = d && d.k && d.k.find((x) => x[0] === sid && x[1] < 100);
      return k ? k[1] : null;
    }
    const innateSkills = (id) => { const d = entry(id); return d.k.filter((k) => k[1] <= d.l).map((k) => k[0]); };

    /** Why a skill can never be on the target: null (possible), 'exclusive', 'element' or 'nosource'. */
    function blocker(target, sid, owned) {
      if (learnLevel(target, sid) != null) return null;
      const m = meta(sid);
      if (!m || m[1]) return 'exclusive';
      if (!canInherit(target, sid)) return 'element';
      const held = (owned || []).some((o) => o.id !== target && o.skills.includes(sid));
      if (!held && !PK.targets().some((id) => id !== target && learnLevel(id, sid) != null)) return 'nosource';
      return null;
    }

    const SKILLS = 1024;     // skill ids fit below this
    const tables = {};
    /** Per Persona: which skills it can inherit (2) and which it comes with (1). */
    function skillTable(id) {
      if (!tables[id]) {
        const row = new Uint8Array(SKILLS);
        for (const sid in data.skills) if (canInherit(id, Number(sid))) row[sid] = 2;
        for (const sid of innateSkills(id)) row[sid] = 1;
        tables[id] = row;
      }
      return tables[id];
    }

    let pairCache = null; // result of every two-Persona fusion, built on first use
    function pairTable() {
      if (!pairCache) {
        pairCache = new Int16Array(IDS * IDS);
        const ids = PK.targets();
        for (const a of ids) for (const b of ids) if (a < b) pairCache[a * IDS + b] = pairCache[b * IDS + a] = PK.fusePair(a, b) || 0;
      }
      return pairCache;
    }

    /**
     * start({target, skills, owned, allowNew, maxLevel}) -> generator. Each next() does a slice of the
     * search; its final value is the result. plan() runs it to the end in one go.
     *   owned: [{id, level, skills, src}]  Personas in the save
     *   allowNew: also use Personas that are not owned
     *   maxLevel: highest base level that may be fused or obtained (the protagonist's level), 0 = no limit
     * Result: {status: 'ok', cost, steps} | {status: 'owned', owned}
     *    | {status: 'blocked', blocked: [{skill, why}]} | {status: 'none', exhausted, level?}
     */
    function* start(opts) {
      const target = opts.target;
      const wanted = [...new Set(opts.skills.filter(Boolean))];
      if (!PK.canFuse(target) || !wanted.length || wanted.length > MAX_WANTED) throw new Error('bad planner request');
      const owned = (opts.owned || []).filter((o) => PK.canFuse(o.id));
      const blocked = wanted.map((skill) => ({ skill, why: blocker(target, skill, owned) })).filter((b) => b.why);
      if (blocked.length) return { status: 'blocked', blocked };
      const have = owned.find((o) => o.id === target && wanted.every((s) => o.skills.includes(s)));
      if (have) return { status: 'owned', owned: have };
      return yield* search(target, wanted, owned, opts);
    }
    function plan(opts) {
      const run = start(opts);
      for (let x = run.next(); ; x = run.next()) if (x.done) return x.value;
    }

    function* search(target, wanted, owned, opts) {
      const full = (1 << wanted.length) - 1;
      const maskOf = (ids) => wanted.reduce((m, s, i) => (ids.includes(s) ? m | (1 << i) : m), 0);
      const skillsOf = (mask) => wanted.filter((s, i) => mask & (1 << i));
      const allowed = (id) => !opts.maxLevel || PK.base(id).lvl <= opts.maxLevel;
      /** The latest eight skills; a wanted one is never the one that gets replaced. */
      const keepEight = (skills) => {
        const out = skills.slice();
        while (out.length > 8) out.splice(Math.max(0, out.findIndex((x) => !wanted.includes(x))), 1);
        return out;
      };
      if (!allowed(target)) return { status: 'none', exhausted: true, level: PK.base(target).lvl };

      const cache = {};
      const facts = (id) => {
        if (!cache[id]) {
          const innate = innateSkills(id);
          cache[id] = {
            innate, innateMask: maskOf(innate),
            inheritMask: maskOf(wanted.filter((s) => canInherit(id, s))),
            // wanted skills it can still learn after fusion
            laterMask: maskOf(wanted.filter((s) => learnLevel(id, s) != null)),
          };
        }
        return cache[id];
      };

      const queue = heap();
      const settled = {};      // id -> states
      const ids = [];          // ids with at least one settled state
      let total = 0;
      // covered[id * 2 + rich][mask] = a settled state holds at least these skills (and is at least as rich)
      const covered = [], queued = new Float64Array(IDS * 64 * 4).fill(Infinity);
      /** A settled state of this Persona that is at least as good in every way. */
      const dominated = (id, mask, rich, level) => {
        const row = covered[id * 2 + rich];
        if (!row || !row[mask]) return false;
        // a lower level matters only while there is still something to learn
        return level >= row[mask] - 1 || !(facts(id).laterMask & ~mask);
      };
      const cover = (s) => {
        for (let rich = s.rich; rich >= 0; rich--) {
          const row = covered[s.id * 2 + rich] || (covered[s.id * 2 + rich] = new Uint8Array(64));
          for (let sub = s.mask; ; sub = (sub - 1) & s.mask) {
            if (!row[sub] || row[sub] > s.level + 1) row[sub] = s.level + 1;
            if (!sub) break;
          }
        }
      };
      let seq = 0;
      /** Queues a state unless an equal or better one is already queued or settled. */
      const add = (s) => {
        s.rich = s.count >= RICH ? 1 : 0;
        if (dominated(s.id, s.mask, s.rich, s.level)) return;
        const key = ((s.id * 64 + s.mask) * 2 + s.rich) * 2 + (s.level === PK.base(s.id).lvl ? 0 : 1);
        if (queued[key] <= s.cost) return;
        queued[key] = s.cost;
        s.rank = s.cost + GUIDE * (wanted.length - bits(s.mask));
        s.seq = seq++;
        queue.push(s);
      };

      for (const o of owned) {
        // an edited save may hold unknown or repeated skills and odd levels; none of that may open extra slots
        const known = keepEight([...new Set(o.skills)].filter(meta));
        const level = Math.max(1, Math.min(99, o.level));
        add({ id: o.id, mask: maskOf(known), known, count: known.length, level, cost: 0, how: 'own', src: o.src, own: o });
      }
      if (opts.allowNew) {
        for (const id of PK.targets()) {
          // special-fusion results are made through their recipe, never listed as something to go and find
          if (id === target || data.special[id] || !allowed(id)) continue;
          const lvl = PK.base(id).lvl;
          const known = PK.defaults(id).skills.filter(Boolean);
          add({ id, mask: maskOf(known), known, count: known.length, level: lvl, cost: COST_NEW + lvl / 50, how: 'new' });
        }
      }

      // special recipes with more than two ingredients
      const groups = {};       // ingredient id -> [{result, ids}]
      const addGroup = (result, ids) => ids.forEach((x) => (groups[x] = groups[x] || []).push({ result, ids }));
      for (const r of Object.keys(data.special).map(Number)) {
        if (data.special[r].length > 2 && allowed(r)) addGroup(r, data.special[r]);
      }

      const seen = new Uint32Array(SKILLS); // skill id -> stamp, to count the different skills of the ingredients
      let stamp = 0;

      /** Pushes the result states of fusing the given ingredient states. */
      function fuse(result, parts, cost) {
        const f = facts(result), level = PK.base(result).lvl;
        let mask = 0, most = 0;
        for (const p of parts) { mask |= p.mask; most = Math.max(most, p.count); }
        const candidates = mask & f.inheritMask & ~f.innateMask;
        if (result === target && (f.innateMask | f.laterMask | candidates) !== full) return;
        // even in the best case this would add nothing new
        const best = f.innateMask | candidates;
        if (dominated(result, best, 1, level) || queued[((result * 64 + best) * 2 + 1) * 2] <= cost) return;
        const table = skillTable(result);
        stamp++;
        let size = 0, eligible = 0;
        for (const p of parts) {
          for (const sid of p.known) {
            if (seen[sid] === stamp) continue;
            seen[sid] = stamp;
            size++;
            if (table[sid] === 2) eligible++;
          }
        }
        const distinct = Math.max(size, most);
        const slots = slotsFor(distinct);
        const take = Math.min(slots, bits(candidates));
        const count = Math.min(8, f.innate.length + Math.min(slots, eligible));
        const offer = (sub) => {
          const got = f.innateMask | sub;
          if (result === target && (got | f.laterMask) !== full) return;
          const rich = count >= RICH ? 1 : 0;
          if (queued[((result * 64 + got) * 2 + rich) * 2] <= cost) return;
          add({ id: result, mask: got, known: f.innate.concat(skillsOf(sub)), count, level, cost, how: 'fuse', parts, inherit: skillsOf(sub), slots, distinct });
        };
        if (take === bits(candidates)) return offer(candidates);
        // not everything fits: every largest subset of the wanted skills that does
        for (let sub = candidates; sub; sub = (sub - 1) & candidates) if (bits(sub) === take) offer(sub);
        if (!take) offer(0);
      }

      /** The cheapest state per (skills, count) obtained by combining one state of every other ingredient. */
      function combine(first, others) {
        let combos = new Map([['', first]]);
        for (const x of others) {
          const next = new Map();
          for (const c of combos.values()) {
            for (const o of settled[x]) {
              const v = { parts: c.parts.concat(o), mask: c.mask | o.mask, count: Math.max(c.count, o.count), cost: c.cost + o.cost };
              const key = v.mask + ':' + v.count;
              if (!next.has(key) || next.get(key).cost > v.cost) next.set(key, v);
            }
          }
          combos = next;
        }
        return combos.values();
      }
      // keep the recipe's ingredient order
      const ordered = (ids, parts) => ids.map((x) => parts.find((p) => p.id === x));

      /** Fuses a newly settled state with settled states of the other ingredients of a special recipe. */
      function fuseGroup(s, g) {
        const others = g.ids.filter((x) => x !== s.id);
        if (others.some((x) => !settled[x])) return;
        for (const c of combine({ parts: [s], mask: s.mask, count: s.count, cost: s.cost }, others)) {
          fuse(g.result, ordered(g.ids, c.parts), c.cost + 1);
        }
      }

      /** Last resort when no chain of other fusions ends on the target: a three-Persona fusion as the last step. */
      function* lastTriple() {
        const reach = {}; // id -> every wanted skill any of its states holds
        for (const id of ids) reach[id] = settled[id].reduce((m, s) => m | s.mask, 0);
        const f = facts(target);
        let found = null, n = 0;
        const triples = PK.recipes(target, { triple: true }).triples;
        for (const t of triples) {
          if (++n % 500 === 0) yield n;
          if (t.some((x) => !settled[x])) continue;
          if ((f.innateMask | f.laterMask | ((reach[t[0]] | reach[t[1]] | reach[t[2]]) & f.inheritMask)) !== full) continue;
          for (const c of combine({ parts: [], mask: 0, count: 0, cost: 0 }, t)) {
            if (c.cost + 1 >= (found ? found.total : Infinity)) continue;
            fuse(target, c.parts, c.cost + 1);
            // fuse() queued at most a few results; follow each up with the level-ups it still needs
            for (let s = queue.pop(); s; s = queue.pop()) {
              const end = s.mask === full ? s : levelled(s, full);
              if (end && (!found || end.cost < found.total)) found = { state: end, total: end.cost };
            }
            queued.fill(Infinity, target * 256, (target + 1) * 256);
          }
        }
        return found && found.state;
      }

      /** The state after levelling until every skill in `need` is there, or null if that never happens. */
      function levelled(s, need) {
        const d = entry(s.id);
        let top = s.level;
        for (const sid of skillsOf(need & ~s.mask)) {
          const lv = learnLevel(s.id, sid);
          if (lv == null || lv <= s.level) return null;
          top = Math.max(top, lv);
        }
        const gained = d.k.filter((k) => k[1] > s.level && k[1] <= top).map((k) => k[0]);
        const mask = s.mask | maskOf(gained);
        return { id: s.id, mask, known: keepEight(s.known.concat(gained.filter((g) => !s.known.includes(g)))),
          count: Math.min(8, s.count + gained.length), level: top, cost: s.cost + COST_LEVEL + (top - s.level) / 20,
          how: 'level', parts: [s], learn: skillsOf(mask & ~s.mask) };
      }

      const table = pairTable();
      const done = (s) => ({ status: 'ok', cost: s.cost, steps: steps(s, wanted), settled: total });
      let exhausted = true;
      for (let s = queue.pop(); s; s = queue.pop()) {
        if (s.id === target && s.mask === full && s.how !== 'own') return done(s);
        if (dominated(s.id, s.mask, s.rich, s.level)) continue;
        if (!settled[s.id]) { settled[s.id] = []; ids.push(s.id); }
        settled[s.id].push(s);
        cover(s);
        if (++total >= MAX_SETTLED) { exhausted = false; break; }
        if (total % 100 === 0) yield total;

        // learn more by levelling up
        const d = entry(s.id);
        for (const [sid, lv] of d.k) {
          const i = wanted.indexOf(sid);
          if (i < 0 || lv <= s.level || lv >= 100 || s.mask & (1 << i)) continue;
          const gained = d.k.filter((k) => k[1] > s.level && k[1] <= lv).map((k) => k[0]);
          const known = keepEight(s.known.concat(gained.filter((g) => !s.known.includes(g))));
          const mask = s.mask | maskOf(gained), count = Math.min(8, s.count + gained.length);
          add({ id: s.id, mask, known, count, level: lv, cost: s.cost + COST_LEVEL + (lv - s.level) / 20,
            how: 'level', parts: [s], learn: skillsOf(mask & ~s.mask) });
        }
        // a Persona that already is the target cannot be an ingredient of the target
        if (s.id === target) continue;
        for (const other of ids) {
          const r = table[s.id * IDS + other];
          if (!r || other === target || !allowed(r)) continue;
          for (const o of settled[other]) fuse(r, [s, o], s.cost + o.cost + 1);
        }
        for (const g of groups[s.id] || []) fuseGroup(s, g);
      }
      if (!data.special[target]) {
        // start from an empty queue so that it only holds results of the triple
        while (queue.pop());
        for (let id = target * 256; id < (target + 1) * 256; id++) queued[id] = Infinity;
        delete covered[target * 2]; delete covered[target * 2 + 1];
        const end = yield* lastTriple();
        if (end) return done(end);
      }
      return { status: 'none', exhausted };
    }

    /** Turns the result tree into an ordered list: ingredients always come before their use. */
    function steps(goal, wanted) {
      const out = [];
      const walk = (s) => {
        const parts = (s.parts || []).map(walk);
        const step = { type: s.how === 'own' || s.how === 'new' ? 'get' : s.how, id: s.id, level: s.level,
          has: wanted.filter((x, i) => s.mask & (1 << i)) };
        if (s.how === 'own' || s.how === 'new') Object.assign(step, { src: s.how === 'own' ? s.src : 'new', own: s.own || null });
        if (s.how === 'level') Object.assign(step, { from: parts[0], learn: s.learn });
        if (s.how === 'fuse') Object.assign(step, { from: parts, inherit: s.inherit, slots: s.slots, distinct: s.distinct });
        return out.push(step) - 1;
      };
      walk(goal);
      return out;
    }

    return { plan, start, canInherit, learnLevel, blocker, MAX_WANTED };
  }

  return { create, slotsFor, MAX_WANTED };
});
