// Shared helpers for the MONDEX market data functions (not a route: files starting with _ are skipped).

export const ME = 'https://api-mainnet.magiceden.dev/v2';
export const meHeaders = () => (process.env.MAGICEDEN_API_KEY ? { Authorization: `Bearer ${process.env.MAGICEDEN_API_KEY}` } : {});
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const hasRedis = () => !!(REDIS_URL && REDIS_TOKEN);
// Runs a list of Redis commands in one round trip and returns their results in order.
export async function redis(commands) {
  if (!commands.length) return [];
  const r = await fetch(`${REDIS_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
  if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
  return (await r.json()).map((x) => x.result);
}
export const pairs = (arr) => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
export const parseJSON = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

// "2022 #182 Galarian Zapdos V CGC 9 Brilliant Stars - English" -> "Galarian Zapdos V"
export function cleanTitle(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/^\d{4}\s+#\S+\s+(.*?)\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)\b/i);
  if (m) s = m[1]; else s = s.replace(/^\d{4}\s+#\S+\s+/, '');
  if (s.includes('/')) s = s.split('/').slice(1).join('/');
  s = s.replace(/\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)(\s+\d+(\.\d+)?)?\s*$/i, '').trim();
  return s || String(raw || 'Graded card');
}

// Turns Collector Crypt token data (from Helius or Magic Eden) into one compact card record.
export function cardFrom(name, attributes, image) {
  const attrs = {};
  (attributes || []).forEach((t) => { if (t && t.trait_type) attrs[String(t.trait_type).toLowerCase()] = t.value; });
  const gradeText = attrs['the grade'] || attrs['grade'] || null;
  const insured = parseFloat(attrs['insured value']);
  const num = (String(name || '').match(/^\d{4}\s+#(\S+)/) || [])[1] || null;
  return {
    title: cleanTitle(name),
    year: attrs['year'] ? String(attrs['year']) : ((String(name || '').match(/^(\d{4})\s/) || [])[1] || null),
    num,
    grader: attrs['grading company'] || null,
    grade: attrs['gradenum'] != null && attrs['gradenum'] !== '' ? String(attrs['gradenum']) : ((String(gradeText || '').match(/\d+(\.\d+)?(?!.*\d)/) || [])[0] || null),
    set: attrs['set'] || null,
    img: image || null,
    insured: Number.isFinite(insured) ? insured : null,
    poke: /pok[eé]mon/i.test(attrs['category'] || '') && (!attrs['type'] || /card/i.test(attrs['type'])),
  };
}
export function cardFromAsset(a) {
  const m = (a.content && a.content.metadata) || {};
  const files = (a.content && a.content.files) || [];
  const img = (files[0] && (files[0].cdn_uri || files[0].uri)) || (a.content && a.content.links && a.content.links.image) || null;
  return cardFrom(m.name, m.attributes, img);
}
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
// One key per printed card + grader + grade, so every copy of the same slab shares one price history.
export const cardKey = (c) => slug([c.year, c.num, c.title, c.grader, c.grade].filter(Boolean).join(' ')).slice(0, 120);
// What we keep in the search index (small on purpose).
export const slim = (c) => ({ t: c.title, y: c.year, no: c.num, g: c.grader, gr: c.grade, s: c.set, i: c.img, v: c.insured });

export async function heliusBatch(ids) {
  const key = process.env.HELIUS_API_KEY;
  const out = {};
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'mondex', method: 'getAssetBatch', params: { ids: ids.slice(i, i + 1000) } }),
    });
    const j = await r.json();
    ((j && j.result) || []).forEach((a) => { if (a && a.id) out[a.id] = cardFromAsset(a); });
  }
  return out;
}

// Summary stats for one card from its sales ([[t, price], ...] oldest first).
export function summarize(sales, now = Date.now() / 1000) {
  if (!sales.length) return null;
  const last = sales[sales.length - 1];
  const inWin = (s) => sales.filter((x) => x[0] >= now - s);
  const before = (s) => { for (let i = sales.length - 1; i >= 0; i--) if (sales[i][0] < now - s) return sales[i][1]; return null; };
  const d1 = inWin(86400), d7 = inWin(7 * 86400);
  const ref7 = before(7 * 86400) ?? (sales.length > 1 ? sales[0][1] : null);
  const ref1 = before(86400);
  return {
    last: last[1], lastT: last[0],
    prev: sales.length > 1 ? sales[sales.length - 2][1] : null,
    n: sales.length,
    n1: d1.length, n7: d7.length,
    vol1: +d1.reduce((a, x) => a + x[1], 0).toFixed(4),
    vol7: +d7.reduce((a, x) => a + x[1], 0).toFixed(4),
    ch1: ref1 ? +(((last[1] - ref1) / ref1) * 100).toFixed(1) : null,
    ch7: ref7 && sales.length > 1 ? +(((last[1] - ref7) / ref7) * 100).toFixed(1) : null,
    hi: Math.max(...sales.map((x) => x[1])), lo: Math.min(...sales.map((x) => x[1])),
    spark: sales.slice(-24).map((x) => x[1]),
  };
}

// Everything a share preview needs for one card (or null when we don't know it).
export async function cardSnapshot(k) {
  const [meta, sum, min] = await redis([['HGET', 'idx', k], ['HGET', 'c:sum', k], ['HGET', 'l:min', k]]);
  const c = parseJSON(meta);
  if (!c) return null;
  const s = parseJSON(sum);
  const st = s && s.rec && s.rec.length ? summarize(s.rec) : null;
  const [lp, , lc] = String(min || '').split('|');
  return { k, ...c, last: st ? st.last : null, lastT: st ? st.lastT : null, ch7: st ? st.ch7 : null, n: s ? s.n : 0, floor: lp ? Number(lp) : null, listed: lc ? Number(lc) : 0, spark: st ? st.spark : [] };
}
export const fmtSol = (v) => (v == null ? null : Number(v).toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 3 : v < 100 ? 2 : 0 }));
export const cardLabel = (c) => [c.t, [c.g, c.gr].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
