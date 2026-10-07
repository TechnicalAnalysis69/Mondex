// MONDEX screener: every Pokémon slab card that has sold or is listed, with volume, price change and cheapest listing.
//   GET /api/screener?sort=vol|trades|gainers|losers|new|price|cheap&grader=PSA&grade=10&q=charizard&min=0.1&max=5
//   GET /api/screener?keys=k1,k2,…   → just those cards (used by the watchlist)
import { hasRedis, redis, pairs, parseJSON, summarize } from './_lib.js';

let cache = null; // { at, rows } kept warm for 2 minutes per server instance

async function loadRows() {
  if (cache && Date.now() - cache.at < 120000) return cache.rows;
  const [sumRaw, minRaw, last] = await redis([['HGETALL', 'c:sum'], ['HGETALL', 'l:min'], ['GET', 'rec:last']]);
  const sums = pairs(sumRaw), mins = pairs(minRaw);
  const keys = [...new Set([...Object.keys(sums), ...Object.keys(mins)])];
  const metas = [];
  for (let i = 0; i < keys.length; i += 2000) metas.push(...((await redis([['HMGET', 'idx', ...keys.slice(i, i + 2000)]]))[0] || []));
  const now = Date.now() / 1000;
  const rows = [];
  keys.forEach((k, i) => {
    const c = parseJSON(metas[i]);
    if (!c) return;
    const s = parseJSON(sums[k]);
    const st = s && s.rec && s.rec.length ? summarize(s.rec, now) : null;
    if (st) st.n = s.n;
    const [lp, lm, lc] = String(mins[k] || '').split('|');
    rows.push({ k, ...c, ...(st || {}), floor: lp ? Number(lp) : null, floorMint: lm || null, listed: lc ? Number(lc) : 0 });
  });
  cache = { at: Date.now(), rows, updated: Number(last) || null };
  return rows;
}

export default async function handler(req, res) {
  if (!hasRedis()) return res.status(503).json({ error: 'Market data is getting set up.' });
  try {
    let rows = await loadRows();
    const q = req.query;
    if (q.keys) {
      const want = new Set(String(q.keys).split(',').slice(0, 200));
      rows = rows.filter((r) => want.has(r.k));
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return res.status(200).json({ rows, updated: cache.updated });
    }
    const words = String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) rows = rows.filter((r) => { const h = [r.t, r.s, r.y, r.g, r.gr, r.no].join(' ').toLowerCase(); return words.every((w) => h.includes(w)); });
    if (q.grader) rows = rows.filter((r) => String(r.g || '').toUpperCase() === String(q.grader).toUpperCase());
    if (q.grade) rows = rows.filter((r) => parseFloat(r.gr) >= parseFloat(q.grade));
    const price = (r) => r.floor ?? r.last ?? null;
    if (q.min) rows = rows.filter((r) => price(r) != null && price(r) >= Number(q.min));
    if (q.max) rows = rows.filter((r) => price(r) != null && price(r) <= Number(q.max));
    const sort = String(q.sort || 'vol');
    const by = {
      vol: (r) => (r.vol7 || 0) * 1e6 + (r.n || 0),
      trades: (r) => (r.n7 || 0) * 1e6 + (r.vol7 || 0),
      gainers: (r) => (r.ch7 == null ? -1e9 : r.ch7),
      losers: (r) => (r.ch7 == null ? -1e9 : -r.ch7),
      new: (r) => r.lastT || 0,
      price: (r) => price(r) || 0,
      cheap: (r) => (price(r) == null ? -1e9 : -price(r)),
      listed: (r) => r.listed || 0,
    }[sort] || ((r) => r.vol7 || 0);
    if (sort === 'gainers' || sort === 'losers') rows = rows.filter((r) => r.ch7 != null);
    const total = rows.length;
    rows = rows.slice().sort((a, b) => by(b) - by(a)).slice(0, Math.min(200, Number(q.limit) || 100));
    res.setHeader('Cache-Control', 's-maxage=90, stale-while-revalidate=300');
    return res.status(200).json({ rows, total, updated: cache.updated });
  } catch (e) {
    console.error('screener failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
