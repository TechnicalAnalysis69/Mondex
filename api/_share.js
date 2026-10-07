// Share page for one card: /c/<card key> (rewritten here by vercel.json).
// Link previews on X, Discord, Telegram and iMessage read the tags below;
// people who click the link are sent straight to the card's page on MONDEX.
import { hasRedis, cardSnapshot, fmtSol, cardLabel } from './_lib.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  const k = String(req.query.k || '').slice(0, 140);
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const target = `/#card/${encodeURIComponent(k)}`;
  let title = 'MONDEX · Pokémon slab prices on Solana';
  let desc = 'Live prices, sales history and the cheapest listing for every Collector Crypt Pokémon slab.';
  try {
    const c = hasRedis() && k ? await cardSnapshot(k) : null;
    if (c) {
      title = `${cardLabel(c)}${c.last != null ? ` · ${fmtSol(c.last)} SOL` : ''}`;
      const bits = [];
      if (c.last != null) bits.push(`Last sale ${fmtSol(c.last)} SOL`);
      if (c.ch7 != null) bits.push(`${c.ch7 > 0 ? '+' : ''}${c.ch7}% this week`);
      if (c.floor != null) bits.push(`cheapest listed ${fmtSol(c.floor)} SOL`);
      if (c.n) bits.push(`${c.n} sale${c.n === 1 ? '' : 's'} tracked`);
      desc = (bits.length ? bits.join(' · ') + '. ' : '') + [c.y, c.s].filter(Boolean).join(' ') + ' graded slab, live on MONDEX.';
    }
  } catch (e) { /* still send a working page */ }
  const img = `${origin}/api/og?k=${encodeURIComponent(k)}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="MONDEX">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + '/c/' + encodeURIComponent(k))}">
<meta property="og:image" content="${esc(img)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@MondexSolana">
<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<script>location.replace(${JSON.stringify(target)})</script>
</head><body style="background:#0C0A16;color:#EFEBF9;font-family:system-ui,sans-serif"><p><a href="${esc(target)}" style="color:#E9C77B">Open ${esc(title)} on MONDEX</a></p></body></html>`);
}
