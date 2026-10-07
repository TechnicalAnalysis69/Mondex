// Vercel serverless function: reads real Collector Crypt card tokens from Solana
// through the Helius DAS API. The key never reaches the browser.
//
// Environment variables (Vercel → Settings → Environment Variables):
//   HELIUS_API_KEY  — from dashboard.helius.dev
//   CC_COLLECTION   — the Collector Crypt collection address (from any of their
//                     cards on Solscan: the "Collection" field)
//
// GET /api/slabs?page=1          → a page of vaulted slabs in the collection
// GET /api/slabs?owner=<wallet>  → the slabs a wallet holds
export default async function handler(req, res) {
  const key = process.env.HELIUS_API_KEY;
  const collection = process.env.CC_COLLECTION;
  if (!key || !collection) {
    return res.status(503).json({ error: 'Live slabs are not set up yet.', missing: { HELIUS_API_KEY: !key, CC_COLLECTION: !collection } });
  }
  const page = Math.max(1, Math.min(200, parseInt(req.query.page, 10) || 1));
  const owner = String(req.query.owner || '');
  if (owner && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) {
    return res.status(400).json({ error: "That doesn't look like a Solana wallet address." });
  }

  const body = owner
    ? { jsonrpc: '2.0', id: 'mondex', method: 'getAssetsByOwner', params: { ownerAddress: owner, page, limit: 100 } }
    : { jsonrpc: '2.0', id: 'mondex', method: 'getAssetsByGroup', params: { groupKey: 'collection', groupValue: collection, page, limit: 48, sortBy: { sortBy: 'recent_action', sortDirection: 'desc' } } };

  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const detail = (j && j.error && j.error.message) || `HTTP ${r.status}`;
      console.error('Helius error:', detail);
      return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail });
    }

    let items = (j.result && j.result.items) || [];
    if (owner) items = items.filter((a) => (a.grouping || []).some((g) => g.group_key === 'collection' && g.group_value === collection));

    const slabs = items.filter((a) => !a.burnt).map((a) => {
      const m = (a.content && a.content.metadata) || {};
      const attrs = {};
      (m.attributes || []).forEach((t) => { if (t && t.trait_type) attrs[String(t.trait_type).toLowerCase()] = t.value; });
      const pick = (...names) => { for (const n of names) for (const k in attrs) if (k.includes(n)) return attrs[k]; return null; };
      const files = (a.content && a.content.files) || [];
      return {
        id: a.id,
        name: m.name || 'Graded card',
        image: (files[0] && (files[0].cdn_uri || files[0].uri)) || (a.content && a.content.links && a.content.links.image) || null,
        grade: pick('grade') ,
        grader: pick('grading company', 'grader', 'company'),
        set: pick('set'),
        year: pick('year'),
        cert: pick('cert', 'serial'),
        owner: a.ownership && a.ownership.owner,
        attributes: m.attributes || [],
      };
    });

    res.setHeader('Cache-Control', owner ? 'no-store' : 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json({ page, total: j.result && j.result.total, slabs });
  } catch (e) {
    console.error('slabs failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String(e && e.message || e) });
  }
}
