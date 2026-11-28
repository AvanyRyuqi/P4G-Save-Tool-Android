/*
 * P4G Save Tool - broadcast card: draws the team (or one Persona) onto a canvas for sharing.
 * An original TV test-pattern design; no game art.
 */
(function (root, factory) {
  root.P4GCard = factory();
})(self, function () {
  'use strict';

  const WIDTH = 1080, PAD = 40, HEAD = 190, MEMBER = 392, GAP = 24, FOOT = 74;
  const FONT = 'sans-serif-condensed, "Roboto Condensed", "Arial Narrow", Roboto, sans-serif';
  const BARS = ['#f4f1e4', '#ffd21a', '#2fd3d6', '#45cf62', '#e25aa4', '#ef493d', '#4263e0'];
  const STYLES = {
    tv: { page: '#ffd21a', ink: '#17130a', panel: '#1b160b', cell: '#2c2512', text: '#fff4cc', muted: '#cbb97c', accent: '#ffd21a', weak: '#ff7a6b', ok: '#72e59c' },
    midnight: { page: '#0b0e1d', ink: '#ffd21a', panel: '#161b31', cell: '#222945', text: '#f5f1de', muted: '#abb1d0', accent: '#ffd21a', weak: '#ff7a6b', ok: '#72e59c' },
  };

  /** model: {title, subtitle, footer, elements: [8 names], stats: [5 names],
   *          members: [{who, persona, arcana, level, stats: [5], skills: [names], aff: [{code, label}]}]} */
  function draw(canvas, model, styleName) {
    const c = STYLES[styleName] || STYLES.tv;
    const height = HEAD + model.members.length * (MEMBER + GAP) + FOOT;
    canvas.width = WIDTH;
    canvas.height = height;
    const g = canvas.getContext('2d');

    const rect = (x, y, w, h, color) => { g.fillStyle = color; g.fillRect(x, y, w, h); };
    /** A parallelogram leaning to the right, the shape used throughout the app theme. */
    const slant = (x, y, w, h, color) => {
      g.fillStyle = color; g.beginPath();
      g.moveTo(x + h * 0.2, y); g.lineTo(x + w + h * 0.2, y); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.closePath(); g.fill();
    };
    /** Text that shrinks, then is cut with an ellipsis, to stay inside maxWidth. */
    function text(str, x, y, size, color, opts) {
      const o = opts || {};
      let s = String(str), px = size;
      const font = () => { g.font = (o.italic ? 'italic ' : '') + (o.weight || 700) + ' ' + px + 'px ' + FONT; };
      font();
      if (o.max) {
        while (px > size * 0.7 && g.measureText(s).width > o.max) { px -= 1; font(); }
        if (g.measureText(s).width > o.max) {
          while (s.length > 1 && g.measureText(s + '…').width > o.max) s = s.slice(0, -1);
          s += '…';
        }
      }
      g.fillStyle = color;
      g.textAlign = o.align || 'left';
      g.textBaseline = 'alphabetic';
      g.fillText(s, x, y);
      return g.measureText(s).width;
    }

    rect(0, 0, WIDTH, height, c.page);
    for (let y = 0; y < height; y += 5) rect(0, y, WIDTH, 1, 'rgba(0,0,0,.05)'); // scan lines
    BARS.forEach((color, i) => rect(i * WIDTH / BARS.length, 0, WIDTH / BARS.length + 1, 22, color));
    text(model.title, PAD, 112, 68, c.ink, { italic: true, weight: 900, max: WIDTH - 2 * PAD });
    text(model.subtitle, PAD, 162, 32, c.ink, { weight: 600, max: WIDTH - 2 * PAD });

    model.members.forEach((m, n) => {
      const x = PAD, y = HEAD + n * (MEMBER + GAP), w = WIDTH - 2 * PAD;
      rect(x + 10, y + 10, w, MEMBER, 'rgba(0,0,0,.25)');
      rect(x, y, w, MEMBER, c.panel);

      const left = x + 30, right = x + w - 28;
      g.font = 'italic 900 38px ' + FONT;
      const lv = 'Lv ' + m.level, lvWidth = g.measureText(lv).width + 44;
      slant(right - lvWidth, y + 22, lvWidth - 12, 58, c.accent);
      text(lv, right - lvWidth / 2, y + 64, 38, c.panel, { italic: true, weight: 900, align: 'center' });
      text(m.persona, left, y + 66, 50, c.text, { italic: true, weight: 900, max: w - lvWidth - 90 });
      text([m.who, m.arcana].filter(Boolean).join('  /  '), left, y + 108, 28, c.muted, { weight: 600, max: w - 70 });

      model.stats.forEach((name, i) => {
        const sx = left + i * 138;
        const used = text(name, sx, y + 150, 24, c.muted, { weight: 700 });
        text(m.stats[i], sx + used + 10, y + 150, 32, c.text, { weight: 900 });
      });

      const half = (w - 70) / 2;
      m.skills.slice(0, 8).forEach((s, i) => {
        const sx = left + (i % 2) * half, sy = y + 166 + Math.floor(i / 2) * 34;
        rect(sx, sy + 12, 8, 14, c.accent);
        text(s, sx + 20, sy + 28, 28, c.text, { weight: 600, max: half - 34 });
      });

      const cw = (w - 64) / 8;
      m.aff.forEach((a, i) => {
        const ax = left + i * cw, ay = y + 312;
        const weak = a.code === 'w', guard = 'snrd'.includes(a.code);
        rect(ax, ay, cw - 8, 62, weak ? c.weak : c.cell);
        text(model.elements[i], ax + (cw - 8) / 2, ay + 24, 20, weak ? c.panel : c.muted, { weight: 700, align: 'center', max: cw - 14 });
        text(a.label, ax + (cw - 8) / 2, ay + 52, 28, weak ? c.panel : guard ? c.ok : c.muted, { weight: 900, align: 'center' });
      });
    });

    text(model.footer, WIDTH / 2, height - 28, 24, c.ink, { weight: 600, align: 'center', max: WIDTH - 2 * PAD });
    return canvas;
  }

  return { draw };
});
