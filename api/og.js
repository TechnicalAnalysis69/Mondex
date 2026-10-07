// Preview image (1200×630 PNG) for link shares.
//   GET /api/og?k=<card key>  → the card: slab photo, grade, last sale, 7-day change, cheapest listing
//   GET /api/og               → MONDEX market card
import { ImageResponse } from '@vercel/og';
import { hasRedis, redis, cardSnapshot, fmtSol } from './_lib.js';

const C = { ink: '#0C0A16', panel: '#15122A', line: '#2D2850', fg: '#EFEBF9', muted: '#A29BC2', dim: '#6E6890', foil: '#E9C77B', ok: '#5BD69A', bad: '#FF6F7D' };
const h = (type, style, ...children) => ({ type, props: { style: { display: 'flex', ...style }, children: children.flat().filter((x) => x != null && x !== false) } });
const img = (src, style) => ({ type: 'img', props: { src, style } });

async function fetchAsDataUrl(url, ms = 3500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_000_000) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch (e) { return null; }
}
let fontCache = null;
async function gfont(family, weight) {
  // Without a browser user agent Google Fonts serves TTF, which the renderer needs.
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`)).text();
  const url = (css.match(/src:\s*url\(([^)]+)\)/) || [])[1];
  if (!url) throw new Error('no font url');
  return (await fetch(url)).arrayBuffer();
}
async function loadFonts() {
  if (fontCache) return fontCache;
  try {
    const [d, b4, b7] = await Promise.all([gfont('Big+Shoulders+Display', 800), gfont('Figtree', 500), gfont('Figtree', 700)]);
    fontCache = [{ name: 'Display', data: d, weight: 800, style: 'normal' }, { name: 'Body', data: b4, weight: 500, style: 'normal' }, { name: 'Body', data: b7, weight: 700, style: 'normal' }];
  } catch (e) { fontCache = undefined; } // fall back to the built-in font
  return fontCache;
}

const logo = () => h('div', { alignItems: 'center', gap: 14 },
  h('div', { width: 34, height: 34, borderRadius: 8, border: `3px solid ${C.foil}`, alignItems: 'center', justifyContent: 'center', color: C.foil, fontSize: 20, fontWeight: 800 }, 'M'),
  h('div', { fontFamily: 'Display', fontSize: 34, letterSpacing: 2, color: C.fg }, 'MONDEX'));
const stat = (k, v, color) => h('div', { flexDirection: 'column', gap: 6, padding: '18px 22px', background: C.panel, border: `2px solid ${C.line}`, borderRadius: 18, flex: 1 },
  h('div', { fontSize: 18, color: C.dim, letterSpacing: 2, textTransform: 'uppercase' }, k),
  h('div', { fontSize: 38, fontWeight: 700, color: color || C.fg }, v));

function cardImage(c, photo) {
  const ch = c.ch7 == null ? null : `${c.ch7 > 0 ? '+' : ''}${c.ch7}%`;
  return h('div', { width: 1200, height: 630, background: C.ink, padding: 44, gap: 44, fontFamily: 'Body' },
    h('div', { width: 400, height: 542, borderRadius: 24, background: C.panel, border: `2px solid ${C.line}`, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
      photo ? img(photo, { width: 400, height: 542, objectFit: 'contain' }) : h('div', { color: C.dim, fontSize: 26 }, 'Vaulted slab')),
    h('div', { flexDirection: 'column', flex: 1, justifyContent: 'space-between' },
      h('div', { flexDirection: 'column', gap: 14 },
        logo(),
        h('div', { fontSize: 22, color: C.foil, letterSpacing: 3, textTransform: 'uppercase', marginTop: 18 }, [c.y, c.s].filter(Boolean).join(' · ') || 'Collector Crypt slab'),
        h('div', { fontFamily: 'Display', fontSize: c.t && c.t.length > 22 ? 64 : 82, lineHeight: 1, color: C.fg, textTransform: 'uppercase' }, c.t || 'Graded card'),
        h('div', { gap: 12, marginTop: 4 },
          c.g || c.gr ? h('div', { fontSize: 26, fontWeight: 700, padding: '6px 16px', borderRadius: 10, background: '#1D1938', border: `2px solid ${C.line}`, color: C.fg }, [c.g, c.gr].filter(Boolean).join(' ')) : null,
          c.v != null ? h('div', { fontSize: 22, padding: '8px 16px', borderRadius: 999, border: `2px solid ${C.line}`, color: C.muted }, `$${Math.round(c.v).toLocaleString('en-US')} insured`) : null)),
      h('div', { gap: 16 },
        stat('Last sale', c.last != null ? `${fmtSol(c.last)} SOL` : 'No sales yet'),
        stat('7-day change', ch || '—', c.ch7 > 0 ? C.ok : c.ch7 < 0 ? C.bad : C.fg),
        stat('Cheapest listed', c.floor != null ? `${fmtSol(c.floor)} SOL` : '—'))));
}

function marketImage(stats) {
  return h('div', { width: 1200, height: 630, background: C.ink, padding: 60, flexDirection: 'column', justifyContent: 'space-between', fontFamily: 'Body' },
    logo(),
    h('div', { flexDirection: 'column', gap: 18 },
      h('div', { fontSize: 24, color: C.foil, letterSpacing: 4, textTransform: 'uppercase' }, 'The market screener for graded Pokémon slabs'),
      h('div', { fontFamily: 'Display', fontSize: 104, lineHeight: 1, color: C.fg, textTransform: 'uppercase' }, 'Live prices for every slab'),
      h('div', { fontSize: 28, color: C.muted }, 'Sales history, volume and the cheapest listing. On Solana.')),
    h('div', { gap: 16 },
      stat('Slabs tracked', stats.cards != null ? stats.cards.toLocaleString('en-US') : '—'),
      stat('Sales recorded', stats.sales != null ? stats.sales.toLocaleString('en-US') : '—'),
      stat('Listed now', stats.listed != null ? stats.listed.toLocaleString('en-US') : '—')));
}

export default async function handler(req, res) {
  const k = String(req.query.k || '').slice(0, 140);
  let tree, fallback = null;
  try {
    const c = hasRedis() && k ? await cardSnapshot(k) : null;
    if (c) {
      fallback = c.i;
      tree = cardImage(c, c.i ? await fetchAsDataUrl(c.i) : null);
    } else {
      let stats = {};
      if (hasRedis()) {
        const [cards, listed, sales] = await redis([['HLEN', 'idx'], ['HLEN', 'l:min'], ['GET', 'stat:sales']]);
        stats = { cards, listed, sales: sales != null ? Number(sales) : null };
      }
      tree = marketImage(stats);
    }
    const fonts = await loadFonts();
    const image = new ImageResponse(tree, { width: 1200, height: 630, ...(fonts ? { fonts } : {}) });
    const buf = Buffer.from(await image.arrayBuffer());
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    return res.status(200).end(buf);
  } catch (e) {
    console.error('og failed:', e && e.message);
    // Never leave a share without an image: fall back to the slab photo.
    if (fallback) { res.setHeader('Location', fallback); return res.status(302).end(); }
    return res.status(500).end();
  }
}
