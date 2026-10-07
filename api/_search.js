// Search every Collector Crypt Pokémon card MONDEX has indexed, by name, set, year, grader or grade.
//   GET /api/search?q=charizard psa 10
import { hasRedis, redis, pairs, parseJSON, summarize } from './_lib.js';

let cache = null; // the whole index, kept warm for 10 minutes per server instance

export default async function handler(req, res) {
  if (!hasRedis()) return res.status(503).json({ error: 'Search is getting set up.' });
  const words = String(req.query.q || '').toLowerCase().replace(/[^a-z0-9.\s'-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return res.status(400).json({ error: 'Type a card name to search.' });
  try {
    if (!cache || Date.now() - cache.at > 600000) {
      const [raw, size] = await redis([['HGETALL', 'idx'], ['HLEN', 'idx']]);
      const all = pairs(raw);
      cache = { at: Date.now(), size, list: Object.entries(all).map(([k, v]) => { const c = parseJSON(v) || {}; return { k, c, h: [c.t, c.s, c.y, c.g, c.gr, c.no].join(' ').toLowerCase() }; }) };
    }
    const hits = cache.list.filter((x) => words.every((w) => x.h.includes(w)));
    const top = hits.slice(0, 400);
    const keys = top.map((x) => x.k);
    const [mins, sums] = keys.length ? await redis([['HMGET', 'l:min', ...keys], ['HMGET', 'c:sum', ...keys]]) : [[], []];
    const rows = top.map((x, i) => {
      const [lp, lm, lc] = String(mins[i] || '').split('|');
      const s = parseJSON(sums[i]);
      const st = s && s.rec && s.rec.length ? summarize(s.rec) : null;
      return { k: x.k, ...x.c, ...(st || {}), n: s ? s.n : 0, floor: lp ? Number(lp) : null, floorMint: lm || null, listed: lc ? Number(lc) : 0 };
    });
    // Listed first, then most traded, then highest insured value.
    rows.sort((a, b) => (b.listed > 0) - (a.listed > 0) || (b.n || 0) - (a.n || 0) || (b.v || 0) - (a.v || 0));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).json({ rows: rows.slice(0, 60), total: hits.length, indexed: cache.size });
  } catch (e) {
    console.error('search failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
