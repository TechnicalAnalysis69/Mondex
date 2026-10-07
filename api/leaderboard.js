// Vercel serverless function: MONDEX leaderboard.
//   GET  /api/leaderboard                      → top 50 collectors
//   POST /api/leaderboard { wallet, message, signature }
//        The wallet signs a short sign-in message (free, no transaction). The server
//        checks the signature, recomputes Collector Score from the wallet's real
//        Collector Crypt slabs, and saves it. Scores are never taken from the browser.
// Storage: Upstash Redis (Vercel → Storage / Marketplace → Upstash for Redis).
// Env: HELIUS_API_KEY, CC_COLLECTION, and UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//      (or KV_REST_API_URL + KV_REST_API_TOKEN, which the integration may create instead).
import crypto from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let bytes = [0];
  for (const c of s) {
    const v = B58.indexOf(c); if (v < 0) throw new Error('bad base58');
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const c of s) { if (c === '1') bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}
function verifySig(wallet, message, sigB64) {
  const pub = b58decode(wallet);
  if (pub.length !== 32) return false;
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sigB64, 'base64'));
}

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  return (await r.json()).map((x) => x.result);
}

const tierOf = (v) => (v == null ? 'Rare' : v < 60 ? 'Common' : v < 200 ? 'Rare' : v < 600 ? 'Epic' : v < 2500 ? 'Legendary' : 'Mythic');
const POINTS = { Common: 1, Rare: 5, Epic: 15, Legendary: 50, Mythic: 250 };

async function holdings(wallet) {
  const key = process.env.HELIUS_API_KEY, collection = process.env.CC_COLLECTION;
  const slabs = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method: 'getAssetsByOwner', params: { ownerAddress: wallet, page, limit: 1000 } }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const items = (j.result && j.result.items) || [];
    items.filter((a) => !a.burnt && (a.grouping || []).some((g) => g.group_key === 'collection' && g.group_value === collection)).forEach((a) => {
      const attrs = {};
      ((a.content && a.content.metadata && a.content.metadata.attributes) || []).forEach((t) => { if (t && t.trait_type) attrs[String(t.trait_type).toLowerCase()] = t.value; });
      const insured = parseFloat(attrs['insured value']);
      const grade = parseFloat(attrs['gradenum'] || (String(attrs['the grade'] || '').match(/\d+(\.\d+)?(?!.*\d)/) || [])[0]);
      slabs.push({ insured: Number.isFinite(insured) ? insured : null, grade: Number.isFinite(grade) ? grade : null });
    });
    if (items.length < 1000) break;
  }
  const score = Math.round(slabs.reduce((a, s) => a + POINTS[tierOf(s.insured)] * (s.grade >= 10 ? 1.5 : 1), 0));
  const value = Math.round(slabs.reduce((a, s) => a + (s.insured || 0), 0));
  const top = Math.round(slabs.reduce((a, s) => Math.max(a, s.insured || 0), 0));
  const gems = slabs.filter((s) => s.grade >= 10).length;
  return { score, slabs: slabs.length, value, top, gems };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: 'The leaderboard is not set up yet.' });
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { wallet, message, signature } = body;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet || '') || typeof message !== 'string' || typeof signature !== 'string' || message.length > 500) {
        return res.status(400).json({ error: 'That sign-in request is not valid.' });
      }
      const m = message.match(/^MONDEX sign-in\nWallet: (\S+)\nIssued: (\S+)\n/);
      if (!m || m[1] !== wallet) return res.status(400).json({ error: 'That sign-in message is not valid.' });
      const age = Date.now() - Date.parse(m[2]);
      if (!(age >= -60000 && age < 10 * 60000)) return res.status(400).json({ error: 'That sign-in has expired. Please sign again.' });
      if (!verifySig(wallet, message, signature)) return res.status(401).json({ error: 'The signature did not match this wallet.' });

      const h = await holdings(wallet);
      await redis([
        ['ZADD', 'lb:score', h.score, wallet],
        ['HSET', `lb:meta:${wallet}`, 'slabs', h.slabs, 'value', h.value, 'top', h.top, 'gems', h.gems, 'updated', new Date().toISOString()],
      ]);
      const [rank] = await redis([['ZREVRANK', 'lb:score', wallet]]);
      return res.status(200).json({ ...h, rank: rank == null ? null : rank + 1 });
    }

    const [flat] = await redis([['ZREVRANGE', 'lb:score', 0, 49, 'WITHSCORES']]);
    const rows = [];
    for (let i = 0; i < (flat || []).length; i += 2) rows.push({ wallet: flat[i], score: Number(flat[i + 1]) });
    const metas = rows.length ? await redis(rows.map((r) => ['HGETALL', `lb:meta:${r.wallet}`])) : [];
    const out = rows.map((r, i) => {
      const arr = metas[i] || [], meta = {};
      for (let k = 0; k < arr.length; k += 2) meta[arr[k]] = arr[k + 1];
      return { rank: i + 1, wallet: r.wallet, score: r.score, slabs: Number(meta.slabs || 0), value: Number(meta.value || 0), top: Number(meta.top || 0), gems: Number(meta.gems || 0), updated: meta.updated || null };
    });
    return res.status(200).json({ leaders: out });
  } catch (e) {
    console.error('leaderboard failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
