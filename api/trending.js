// Vercel serverless function: what's hot in Collector Crypt Pokémon slabs right now.
// Activity + stats from Magic Eden; card details (name, grade, insured value, photo)
// from Helius. Cached for 5 minutes.
// GET /api/trending
function cleanTitle(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/^\d{4}\s+#\S+\s+(.*?)\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)\b/i);
  if (m) s = m[1]; else s = s.replace(/^\d{4}\s+#\S+\s+/, '');
  if (s.includes('/')) s = s.split('/').slice(1).join('/');
  s = s.replace(/\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)(\s+\d+(\.\d+)?)?\s*$/i, '').trim();
  return s || String(raw || 'Graded card');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'https://api-mainnet.magiceden.dev/v2/collections/collector_crypt';

export default async function handler(req, res) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Trending is not set up yet.' });
  try {
    const stats = await fetch(`${ME}/stats`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    let acts = [];
    for (let offset = 0; offset < 1000; offset += 500) {
      const r = await fetch(`${ME}/activities?offset=${offset}&limit=500`);
      if (!r.ok) break;
      const page = await r.json();
      acts = acts.concat(page);
      if (page.length < 500) break;
      await sleep(300);
    }

    const sales = acts.filter((a) => a.type === 'buyNow' && a.tokenMint);
    const listings = acts.filter((a) => a.type === 'list' && a.tokenMint);
    const bidCount = {};
    acts.filter((a) => a.type === 'bid' && a.tokenMint).forEach((a) => { bidCount[a.tokenMint] = (bidCount[a.tokenMint] || 0) + 1; });
    const mostBid = Object.entries(bidCount).sort((a, b) => b[1] - a[1]).slice(0, 40);

    // Card details for every mint we'll show (Helius getAssetBatch, max 1000 ids).
    const ids = [...new Set([...sales.slice(0, 80).map((s) => s.tokenMint), ...listings.slice(0, 60).map((l) => l.tokenMint), ...mostBid.map(([m]) => m)])];
    const meta = {};
    if (ids.length) {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method: 'getAssetBatch', params: { ids } }),
      });
      const j = await r.json();
      ((j && j.result) || []).forEach((a) => {
        if (!a) return;
        const m = (a.content && a.content.metadata) || {};
        const attrs = {};
        (m.attributes || []).forEach((t) => { if (t && t.trait_type) attrs[String(t.trait_type).toLowerCase()] = t.value; });
        const files = (a.content && a.content.files) || [];
        const insured = parseFloat(attrs['insured value']);
        const gradeText = attrs['the grade'] || attrs['grade'] || null;
        meta[a.id] = {
          id: a.id,
          name: m.name || 'Graded card',
          title: cleanTitle(m.name),
          image: (files[0] && (files[0].cdn_uri || files[0].uri)) || (a.content && a.content.links && a.content.links.image) || null,
          grade: attrs['gradenum'] || ((String(gradeText || '').match(/\d+(\.\d+)?(?!.*\d)/) || [])[0]) || null,
          gradeText,
          grader: attrs['grading company'] || null,
          cert: attrs['grading id'] || null,
          set: attrs['set'] || null,
          year: attrs['year'] || null,
          insured: Number.isFinite(insured) ? insured : null,
          vault: attrs['vault'] || null,
          category: attrs['category'] || '',
          owner: a.ownership && a.ownership.owner,
        };
      });
    }
    const isPoke = (m) => m && /pok[eé]mon/i.test(m.category);
    const withMeta = (mint, extra) => (isPoke(meta[mint]) ? { ...meta[mint], ...extra, url: `https://magiceden.io/item-details/${mint}` } : null);

    const recentSales = sales.map((s) => withMeta(s.tokenMint, { price: s.price, time: s.blockTime })).filter(Boolean);
    const topSales = recentSales.slice().sort((a, b) => b.price - a.price).slice(0, 12);
    const mostWanted = mostBid.map(([mint, n]) => withMeta(mint, { bids: n })).filter(Boolean).slice(0, 12);
    const freshListings = listings.map((l) => withMeta(l.tokenMint, { price: l.price, time: l.blockTime })).filter(Boolean).slice(0, 12);
    const span = acts.length ? Math.round((Date.now() / 1000 - acts[acts.length - 1].blockTime) / 3600) : null;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.status(200).json({
      stats: {
        listed: stats.listedCount ?? null,
        floor: stats.floorPrice != null ? stats.floorPrice / 1e9 : null,
        volume7d: stats.volume7d != null ? stats.volume7d / 1e9 : null,
        avgSale24h: stats.avgPrice24hr != null ? stats.avgPrice24hr / 1e9 : null,
      },
      windowHours: span,
      topSales,
      recentSales: recentSales.slice(0, 12),
      mostWanted,
      freshListings,
    });
  } catch (e) {
    console.error('trending failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
