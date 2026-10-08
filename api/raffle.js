// MONDEX hourly holder raffle.
//   GET /api/raffle                 → token info, next draw time, recent winners (draws the current hour if it hasn't been drawn yet)
//   GET /api/raffle?wallet=<addr>   → also that wallet's balance and whether it's entered
// Env: TOKEN_MINT (the coin's mint address), TOKEN_TICKER (e.g. MONDEX), RAFFLE_MIN (default 1000000),
//      RAFFLE_EXCLUDE (comma-separated wallets to leave out, e.g. the liquidity pool and dev wallets), HELIUS_API_KEY, KV_*.
// Fairness: everyone holding at least RAFFLE_MIN at draw time is entered once. The list is sorted by wallet,
// and the winner is picked with SHA-256(latest Solana blockhash + draw hour), so anyone can re-check a draw.
import crypto from 'node:crypto';
import { hasRedis, redis, parseJSON } from './_lib.js';

const MINT = process.env.TOKEN_MINT || '';
const TICKER = process.env.TOKEN_TICKER || 'MONDEX';
const MIN = Number(process.env.RAFFLE_MIN || 1000000);
const EXCLUDE = new Set(String(process.env.RAFFLE_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean));
const rpc = (method, params) => fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method, params }),
}).then((r) => r.json());

async function decimals() {
  const [cached] = await redis([['GET', `raffle:dec:${MINT}`]]);
  if (cached != null) return Number(cached);
  const j = await rpc('getAsset', { id: MINT });
  const d = j.result && j.result.token_info && j.result.token_info.decimals;
  const dec = Number.isFinite(d) ? d : 6;
  await redis([['SET', `raffle:dec:${MINT}`, String(dec)]]);
  return dec;
}

// Every wallet's balance (in whole tokens), summed across its token accounts.
async function holders() {
  const dec = await decimals();
  const bal = {};
  for (let page = 1; page <= 50; page++) {
    const j = await rpc('getTokenAccounts', { mint: MINT, page, limit: 1000 });
    const list = (j.result && j.result.token_accounts) || [];
    list.forEach((a) => { bal[a.owner] = (bal[a.owner] || 0) + Number(a.amount) / 10 ** dec; });
    if (list.length < 1000) break;
  }
  return bal;
}

async function drawIfDue(hour) {
  const key = `raffle:draw:${hour}`;
  const [done] = await redis([['GET', key]]);
  if (done) return parseJSON(done);
  const [lock] = await redis([['SET', `raffle:lock:${hour}`, '1', 'NX', 'EX', 120]]);
  if (!lock) return null;
  try {
    const bal = await holders();
    const entrants = Object.keys(bal).filter((w) => bal[w] >= MIN && !EXCLUDE.has(w)).sort();
    const bh = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
    const blockhash = bh.result && bh.result.value && bh.result.value.blockhash;
    let winner = null;
    if (entrants.length && blockhash) {
      const h = crypto.createHash('sha256').update(`${blockhash}:${hour}`).digest();
      winner = entrants[Number(h.readBigUInt64BE(0) % BigInt(entrants.length))];
    }
    const rec = { hour, drawnAt: Math.floor(Date.now() / 1000), entrants: entrants.length, blockhash, winner, balance: winner ? Math.floor(bal[winner]) : null };
    await redis([
      ['SET', key, JSON.stringify(rec)],
      ['SET', 'raffle:entrants', String(entrants.length)],
      ...(winner ? [['LPUSH', 'raffle:winners', JSON.stringify(rec)], ['LTRIM', 'raffle:winners', 0, 49]] : []),
    ]);
    return rec;
  } catch (e) {
    await redis([['DEL', `raffle:lock:${hour}`]]);
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.floor(now / 3600) * 3600;
  const base = { live: !!MINT, mint: MINT || null, ticker: TICKER, min: MIN, nextDraw: hour + 3600 };
  if (!MINT || !hasRedis() || !process.env.HELIUS_API_KEY) return res.status(200).json({ ...base, winners: [] });
  try {
    const current = await drawIfDue(hour);
    const [list, entrants] = await redis([['LRANGE', 'raffle:winners', 0, 19], ['GET', 'raffle:entrants']]);
    const out = { ...base, current, entrants: entrants != null ? Number(entrants) : null, winners: (list || []).map(parseJSON).filter(Boolean) };
    const wallet = String(req.query.wallet || '');
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      const dec = await decimals();
      const j = await rpc('getTokenAccounts', { mint: MINT, owner: wallet, page: 1, limit: 100 });
      const b = ((j.result && j.result.token_accounts) || []).reduce((a, t) => a + Number(t.amount) / 10 ** dec, 0);
      out.you = { wallet, balance: Math.floor(b), entered: b >= MIN && !EXCLUDE.has(wallet) };
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error('raffle failed:', e && e.message);
    return res.status(200).json({ ...base, winners: [], error: "We couldn't load the raffle right now." });
  }
}
