// One card's market page data: details, full sale history and live listings (cheapest first).
//   GET /api/card?k=<card key>   or   GET /api/card?mint=<token address>
import { ME, meHeaders, hasRedis, redis, pairs, parseJSON, cardFromAsset, cardKey, slim } from './_lib.js';

export default async function handler(req, res) {
  if (!hasRedis()) return res.status(503).json({ error: 'Market data is getting set up.' });
  try {
    let k = String(req.query.k || '').slice(0, 140);
    const mint = String(req.query.mint || '');
    if (!k && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
      const [known] = await redis([['HGET', 'm:key', mint]]);
      if (known && known !== '-') k = known;
      else if (!known && process.env.HELIUS_API_KEY) {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method: 'getAsset', params: { id: mint } }),
        });
        const j = await r.json();
        if (j.result) {
          const c = cardFromAsset(j.result);
          if (c.poke) { k = cardKey(c); await redis([['HSET', 'm:key', mint, k], ['HSET', 'idx', k, JSON.stringify(slim(c))]]); }
        }
      }
    }
    if (!k) return res.status(404).json({ error: 'We couldn’t find that card.' });

    const [meta, sales, book] = await redis([['HGET', 'idx', k], ['ZRANGE', `c:sales:${k}`, -1000, -1], ['HGETALL', `l:${k}`]]);
    if (!meta && !(sales || []).length) return res.status(404).json({ error: 'We couldn’t find that card.' });

    // Listings, cheapest first. Double-check the cheapest few with Magic Eden so sold or pulled ones drop off.
    let listings = Object.entries(pairs(book)).map(([m, p]) => ({ mint: m, price: Number(p) })).filter((x) => x.price > 0).sort((a, b) => a.price - b.price);
    const check = listings.slice(0, 4);
    const stale = [];
    await Promise.all(check.map(async (l) => {
      try {
        const r = await fetch(`${ME}/tokens/${l.mint}/listings`, { headers: meHeaders() });
        if (!r.ok) return;
        const arr = await r.json();
        if (Array.isArray(arr) && !arr.length) stale.push(l.mint);
        else if (Array.isArray(arr) && arr[0] && arr[0].price) l.price = Number(arr[0].price);
      } catch (e) {}
    }));
    if (stale.length) {
      listings = listings.filter((l) => !stale.includes(l.mint));
      const best = listings.slice().sort((a, b) => a.price - b.price)[0];
      await redis([['HDEL', `l:${k}`, ...stale], best ? ['HSET', 'l:min', k, `${best.price}|${best.mint}|${listings.length}`] : ['HDEL', 'l:min', k]]);
    }
    listings.sort((a, b) => a.price - b.price);

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      k,
      card: parseJSON(meta),
      sales: (sales || []).map((m) => { const [t, p, mt, sig] = m.split('|'); return { t: Number(t), p: Number(p), mint: mt, sig }; }),
      listings: listings.slice(0, 50).map((l) => ({ ...l, url: `https://magiceden.io/item-details/${l.mint}` })),
      listedCount: listings.length,
    });
  } catch (e) {
    console.error('card failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
