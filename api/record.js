// Records Collector Crypt Pokémon market activity into the MONDEX database.
//   GET /api/record          → quick run (called in the background when people visit; at most every 5 minutes)
//   GET /api/record?deep=1   → deeper run (daily Vercel cron): pages further back and builds the search index faster
// What it stores (Upstash Redis):
//   s:seen            set of Magic Eden activity signatures already processed
//   m:key             hash mint → card key ("-" for non-Pokémon tokens)
//   idx               hash card key → small card record (title, set, grade, image…), used by search and card pages
//   c:sales:<key>     sorted set of sales for that card, "time|price|mint|signature"
//   c:sum             hash card key → { n, rec: last 60 [time, price] } for the screener
//   l:<key>           hash mint → list price, the live order book for that card
//   l:min             hash card key → "price|mint", cheapest listing per card
//   s:feed            sorted set of the latest 3,000 sales across all cards
import { ME, meHeaders, sleep, hasRedis, redis, pairs, parseJSON, cardFrom, cardKey, slim, heliusBatch } from './_lib.js';

export const config = { maxDuration: 60 };
const COLL = `${ME}/collections/collector_crypt`;

async function meJSON(url) {
  const r = await fetch(url, { headers: meHeaders() });
  if (!r.ok) throw new Error(`Magic Eden HTTP ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasRedis() || !process.env.HELIUS_API_KEY) return res.status(503).json({ error: 'Recording is not set up yet.' });
  const deep = req.query.deep === '1' || /vercel-cron/i.test(req.headers['user-agent'] || '');
  const started = Date.now();
  const timeLeft = () => 50000 - (Date.now() - started);
  try {
    const [lock] = await redis([['SET', 'rec:lock', String(Date.now()), 'NX', 'EX', deep ? 120 : 300]]);
    if (!lock) return res.status(200).json({ skipped: true, reason: 'Ran recently.' });

    /* 1. New activity since the last run (newest first from Magic Eden). */
    const maxPages = deep ? 24 : 4;
    let fresh = [];
    for (let p = 0; p < maxPages && timeLeft() > 30000; p++) {
      let page;
      try { page = await meJSON(`${COLL}/activities?offset=${p * 500}&limit=500`); } catch (e) { break; }
      if (!Array.isArray(page) || !page.length) break;
      const sigs = page.map((a) => a.signature || `${a.type}:${a.tokenMint}:${a.blockTime}`);
      const [seen] = await redis([['SMISMEMBER', 's:seen', ...sigs]]);
      page.forEach((a, i) => { if (!seen[i]) fresh.push({ ...a, sig: sigs[i] }); });
      if (seen.some(Boolean)) break; // reached what we already have
      if (page.length < 500) break;
      await sleep(350);
    }
    const acts = fresh.filter((a) => a.tokenMint && ['buyNow', 'list', 'delist'].includes(a.type)).sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));

    /* 2. Listings snapshot, a few pages per run, to fill in listings made before we started recording. */
    const snap = [];
    const [cur, bfDone] = await redis([['GET', 'l:cur'], ['GET', 'l:bfdone']]);
    if (!bfDone || Date.now() - Number(bfDone) > 86400000) {
      let off = Number(cur) || 0;
      const pages = deep ? 20 : 3;
      for (let p = 0; p < pages && timeLeft() > 25000; p++) {
        let page;
        try { page = await meJSON(`${COLL}/listings?offset=${off}&limit=100`); } catch (e) { break; }
        page = Array.isArray(page) ? page : [];
        page.forEach((l) => { const t = l.token || {}; const mint = l.tokenMint || t.mintAddress; if (mint) snap.push({ mint, price: l.price, card: cardFrom(t.name, t.attributes, (l.extra && l.extra.img) || t.image) }); });
        if (page.length < 100) { off = 0; await redis([['SET', 'l:bfdone', String(Date.now())]]); break; }
        off += 100;
        await sleep(300);
      }
      await redis([['SET', 'l:cur', String(off)]]);
    }

    /* 3. Card key for every mint we touched. */
    const mints = [...new Set(acts.map((a) => a.tokenMint))];
    const keyOf = {};
    if (mints.length) {
      const [known] = await redis([['HMGET', 'm:key', ...mints]]);
      mints.forEach((m, i) => { if (known[i]) keyOf[m] = known[i]; });
    }
    const write = [];
    const idxAdd = {}, mkAdd = {};
    const unknown = mints.filter((m) => !keyOf[m]);
    if (unknown.length) {
      const meta = await heliusBatch(unknown);
      unknown.forEach((m) => {
        const c = meta[m];
        if (!c) return; // try again next run
        const k = c.poke ? cardKey(c) : '-';
        keyOf[m] = k; mkAdd[m] = k;
        if (c.poke) idxAdd[k] = JSON.stringify(slim(c));
      });
    }
    snap.forEach((s) => {
      if (!s.card.poke) { mkAdd[s.mint] = '-'; return; }
      const k = cardKey(s.card);
      keyOf[s.mint] = k; mkAdd[s.mint] = k; idxAdd[k] = JSON.stringify(slim(s.card));
    });

    /* 4. Apply activity in time order. */
    const saleKeys = new Set(), bookKeys = new Set();
    let sales = 0;
    acts.forEach((a) => {
      const k = keyOf[a.tokenMint];
      if (!k || k === '-') return;
      const price = Number(a.price);
      if (a.type === 'buyNow' && price > 0) {
        write.push(['ZADD', `c:sales:${k}`, a.blockTime, `${a.blockTime}|${price}|${a.tokenMint}|${a.sig}`]);
        write.push(['ZADD', 's:feed', a.blockTime, JSON.stringify({ k, t: a.blockTime, p: price, m: a.tokenMint })]);
        write.push(['HDEL', `l:${k}`, a.tokenMint]);
        saleKeys.add(k); bookKeys.add(k); sales++;
      } else if (a.type === 'list' && price > 0) {
        write.push(['HSET', `l:${k}`, a.tokenMint, String(price)]); bookKeys.add(k);
      } else if (a.type === 'delist') {
        write.push(['HDEL', `l:${k}`, a.tokenMint]); bookKeys.add(k);
      }
    });
    snap.forEach((s) => { if (s.card.poke && s.price > 0) { const k = keyOf[s.mint]; write.push(['HSET', `l:${k}`, s.mint, String(s.price)]); bookKeys.add(k); } });

    const mk = Object.entries(mkAdd).flat();
    const ix = Object.entries(idxAdd).flat();
    if (mk.length) write.unshift(['HSET', 'm:key', ...mk]);
    if (ix.length) write.unshift(['HSET', 'idx', ...ix]);
    if (fresh.length) write.push(['SADD', 's:seen', ...fresh.map((a) => a.sig)]);
    write.push(['ZREMRANGEBYRANK', 's:feed', 0, -3001]);
    if (sales) write.push(['INCRBY', 'stat:sales', sales]);
    for (let i = 0; i < write.length; i += 400) await redis(write.slice(i, i + 400));

    /* 5. Refresh per-card summaries and cheapest listings. */
    const sk = [...saleKeys];
    if (sk.length) {
      const got = await redis(sk.flatMap((k) => [['ZCARD', `c:sales:${k}`], ['ZRANGE', `c:sales:${k}`, -60, -1]]));
      const fields = [];
      sk.forEach((k, i) => {
        const rec = (got[i * 2 + 1] || []).map((m) => { const [t, p] = m.split('|'); return [Number(t), Number(p)]; });
        fields.push(k, JSON.stringify({ n: got[i * 2], rec }));
      });
      await redis([['HSET', 'c:sum', ...fields]]);
    }
    const bk = [...bookKeys];
    for (let i = 0; i < bk.length; i += 300) {
      const part = bk.slice(i, i + 300);
      const books = await redis(part.map((k) => ['HGETALL', `l:${k}`]));
      const set = [], del = [];
      part.forEach((k, j) => {
        const b = pairs(books[j]);
        let best = null;
        Object.entries(b).forEach(([m, p]) => { p = Number(p); if (p > 0 && (!best || p < best[0])) best = [p, m]; });
        if (best) set.push(k, `${best[0]}|${best[1]}|${Object.keys(b).length}`); else del.push(k);
      });
      const cmds = [];
      if (set.length) cmds.push(['HSET', 'l:min', ...set]);
      if (del.length) cmds.push(['HDEL', 'l:min', ...del]);
      await redis(cmds);
    }

    /* 6. Search index: walk every Collector Crypt token with Helius, a few pages per run. */
    let indexed = 0;
    const [ipage, idone] = await redis([['GET', 'idx:page'], ['GET', 'idx:done']]);
    if (!idone || Date.now() - Number(idone) > 7 * 86400000) {
      let page = Number(ipage) || 1;
      const pages = deep ? 12 : 2;
      for (let p = 0; p < pages && timeLeft() > 8000; p++) {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method: 'getAssetsByGroup', params: { groupKey: 'collection', groupValue: process.env.CC_COLLECTION || 'CCryptWBYktukHDQ2vHGtVcmtjXxYzvw8XNVY64YN2Yf', page, limit: 1000 } }),
        });
        const j = await r.json();
        if (j.error) break;
        const items = (j.result && j.result.items) || [];
        const ix2 = {}, mk2 = {};
        items.forEach((a) => {
          if (a.burnt) return;
          const c = cardFrom(a.content && a.content.metadata && a.content.metadata.name, a.content && a.content.metadata && a.content.metadata.attributes,
            ((a.content && a.content.files) || [])[0] ? (a.content.files[0].cdn_uri || a.content.files[0].uri) : (a.content && a.content.links && a.content.links.image));
          const k = c.poke ? cardKey(c) : '-';
          mk2[a.id] = k;
          if (c.poke) ix2[k] = JSON.stringify(slim(c));
        });
        const cmds = [];
        if (Object.keys(ix2).length) cmds.push(['HSET', 'idx', ...Object.entries(ix2).flat()]);
        if (Object.keys(mk2).length) cmds.push(['HSET', 'm:key', ...Object.entries(mk2).flat()]);
        indexed += Object.keys(ix2).length;
        if (items.length < 1000) { page = 1; cmds.push(['SET', 'idx:done', String(Date.now())]); await redis(cmds.concat([['SET', 'idx:page', '1']])); break; }
        page++;
        cmds.push(['SET', 'idx:page', String(page)]);
        await redis(cmds);
      }
    }

    await redis([['SET', 'rec:last', String(Math.floor(Date.now() / 1000))]]);
    return res.status(200).json({ ok: true, deep, newActivity: fresh.length, sales, listingsSnapshot: snap.length, cardsIndexed: indexed, ms: Date.now() - started });
  } catch (e) {
    console.error('record failed:', e && e.message);
    try { await redis([['DEL', 'rec:lock']]); } catch (x) {}
    return res.status(502).json({ error: "We couldn't record market activity right now.", detail: String((e && e.message) || e) });
  }
}
