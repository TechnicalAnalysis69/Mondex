// Vercel serverless function: MONDEX Pass (0.5 SOL, one-time, per wallet).
// Payments go straight from the visitor's wallet to the treasury wallet; this
// function only reads Solana to confirm them. Uses HELIUS_API_KEY.
//
//   GET  /api/pass?blockhash=1             → a recent blockhash for building the transfer
//   GET  /api/pass?wallet=W&sig=S          → confirm a specific payment transaction
//   GET  /api/pass?wallet=W                → check the wallet's history for an earlier payment
//   POST /api/pass  { tx: "<base64>" }     → broadcast a signed transaction (for wallets
//                                            that sign but don't send)
const TREASURY = process.env.TREASURY_WALLET || 'CPsky2ChMspRoXScoPHhCmUMF7Ac7ACAD4Tjv2JhScQr';
const PRICE_LAMPORTS = Math.round(parseFloat(process.env.PASS_PRICE_SOL || '0.5') * 1e9);
const isAddr = (v) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v || '');
const isSig = (v) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v || '');

async function rpc(key, method, params) {
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  return j.result;
}

// A transaction counts if it succeeded, the wallet signed it, and the treasury
// balance went up by at least the pass price.
function paidIn(tx, wallet) {
  if (!tx || !tx.meta || tx.meta.err) return false;
  const msg = tx.transaction && tx.transaction.message;
  const keys = ((msg && msg.accountKeys) || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const loaded = tx.meta.loadedAddresses ? [...(tx.meta.loadedAddresses.writable || []), ...(tx.meta.loadedAddresses.readonly || [])] : [];
  const all = keys.concat(loaded);
  const t = all.indexOf(TREASURY), w = all.indexOf(wallet);
  const signers = (msg && msg.header && msg.header.numRequiredSignatures) || 1;
  if (t < 0 || w < 0 || w >= signers) return false;
  return (tx.meta.postBalances[t] - tx.meta.preBalances[t]) >= PRICE_LAMPORTS;
}

export default async function handler(req, res) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Payments are not set up yet.' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!body.tx || typeof body.tx !== 'string' || body.tx.length > 4000) return res.status(400).json({ error: 'Missing transaction.' });
      const sig = await rpc(key, 'sendTransaction', [body.tx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      return res.status(200).json({ signature: sig });
    }

    if (req.query.blockhash) {
      const r = await rpc(key, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
      return res.status(200).json({ blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight, treasury: TREASURY, lamports: PRICE_LAMPORTS });
    }

    const wallet = String(req.query.wallet || '');
    if (!isAddr(wallet)) return res.status(400).json({ error: "That doesn't look like a Solana wallet address." });

    const sig = String(req.query.sig || '');
    if (sig) {
      if (!isSig(sig)) return res.status(400).json({ error: 'That transaction ID is not valid.' });
      const tx = await rpc(key, 'getTransaction', [sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (!tx) return res.status(200).json({ active: false, pending: true });
      return res.status(200).json({ active: paidIn(tx, wallet), pending: false, signature: sig });
    }

    // History check: look through the wallet's recent transfers for a payment to the treasury.
    let before = '';
    for (let page = 0; page < 3; page++) {
      const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&type=TRANSFER&limit=100${before ? `&before=${before}` : ''}`;
      const r = await fetch(url);
      if (!r.ok) break;
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) break;
      const total = (t) => (t.nativeTransfers || []).filter((x) => x.fromUserAccount === wallet && x.toUserAccount === TREASURY).reduce((a, x) => a + (x.amount || 0), 0);
      const hit = list.find((t) => !t.transactionError && total(t) >= PRICE_LAMPORTS);
      if (hit) return res.status(200).json({ active: true, signature: hit.signature });
      before = list[list.length - 1].signature;
      if (list.length < 100) break;
    }
    return res.status(200).json({ active: false });
  } catch (e) {
    console.error('pass failed:', e && e.message);
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
