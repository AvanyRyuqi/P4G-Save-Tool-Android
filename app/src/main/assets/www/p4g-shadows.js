/*
 * P4G Save Tool - bestiary: searching shadows, summing up a dungeon and comparing it with the team.
 * Data comes from shadow-data.js. Runs unchanged in the Android WebView and in Node (see /tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P4GShadows = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // element columns, in the order of every 8-letter resistance code
  const WEAK = 'w';
  const BLOCKS = 'nrd';     // null, repel, drain: the attack is wasted or worse
  const words = (q) => String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

  function create(data) {
    const all = data.enemies;

    /** Filters (all optional): dungeon index, name/area words, element index the enemy is weak to.
     *  The result is in ascending level order, like the data. */
    function find(f) {
      const q = f || {};
      const w = words(q.query);
      return all.filter((e) => (q.dungeon == null || e.g.includes(q.dungeon))
        && (q.weakTo == null || e.x[q.weakTo] === WEAK)
        && w.every((x) => e.n.toLowerCase().includes(x)));
    }

    /** Per element for a list of shadows: how many are weak, resist, block it, or attack with it. */
    function summary(list) {
      return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        i,
        weak: list.filter((e) => e.x[i] === WEAK).length,
        strong: list.filter((e) => e.x[i] === 's').length,
        block: list.filter((e) => BLOCKS.includes(e.x[i])).length,
        back: list.filter((e) => e.x[i] === 'r' || e.x[i] === 'd').length,
        attackers: list.filter((e) => e.t.includes(i)).length,
      }));
    }

    /** Which elements to bring and which to leave at home.
     *  best: most shadows weak to it (ties: fewer that block it). risky: repelled or drained most often. */
    function advice(list) {
      const rows = summary(list);
      return {
        best: rows.filter((r) => r.weak > 0).sort((a, b) => b.weak - a.weak || a.block - b.block || a.i - b.i).slice(0, 3),
        risky: rows.filter((r) => r.back > 0).sort((a, b) => b.back - a.back || a.i - b.i).slice(0, 3),
      };
    }

    /** Team members against the attacks found in a dungeon.
     *  team: [{who, codes}] where codes[i] is the member's resistance code for element i (or null).
     *  -> [{i, attackers, weak: [who]}] for every element that both exists as an attack and hits someone. */
    function threats(list, team) {
      return summary(list)
        .map((r) => ({ i: r.i, attackers: r.attackers, weak: team.filter((m) => m.codes && m.codes[r.i] === WEAK).map((m) => m.who) }))
        .filter((r) => r.attackers && r.weak.length)
        .sort((a, b) => b.weak.length * b.attackers - a.weak.length * a.attackers || a.i - b.i);
    }

    /** Items matching every search word, with the shadows that drop them (highest chance first). */
    function drops(query) {
      const w = words(query);
      const items = new Map();
      for (const e of all) {
        for (const [item, odds] of e.d) {
          if (!w.every((x) => item.toLowerCase().includes(x))) continue;
          if (!items.has(item)) items.set(item, []);
          items.get(item).push({ enemy: e, odds });
        }
      }
      return [...items.keys()].sort().map((item) => ({ item, sources: items.get(item).sort((a, b) => b.odds - a.odds || a.enemy.l - b.enemy.l) }));
    }

    return { dungeons: data.dungeons, all, find, summary, advice, threats, drops };
  }

  return { create };
});
