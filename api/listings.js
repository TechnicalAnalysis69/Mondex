// Vercel serverless function: live Collector Crypt Pokémon listings from Magic Eden.
// GET /api/listings?offset=0 → up to 100 listings per page, Pokémon cards only.
// "2022 #182 Galarian Zapdos V CGC 9 Brilliant Stars - English" -> "Galarian Zapdos V"
// "2021 #175 Full Art/Celebi V CGC" -> "Celebi V"
function cleanTitle(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/^\d{4}\s+#\S+\s+(.*?)\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)\b/i);
  if (m) s = m[1]; else s = s.replace(/^\d{4}\s+#\S+\s+/, '');
  if (s.includes('/')) s = s.split('/').slice(1).join('/');
  s = s.replace(/\s+(PSA|CGC|BGS|SGC|TAG|BECKETT)(\s+\d+(\.\d+)?)?\s*$/i, '').trim();
  return s || String(raw || 'Graded card');
}
const gradeNum = (num, text) => num || ((String(text || '').match(/\d+(\.\d+)?(?!.*\d)/) || [])[0]) || null;

export default async function handler(req, res) {
  const offset = Math.max(0, Math.min(5000, parseInt(req.query.offset, 10) || 0));
  const url = `https://api-mainnet.magiceden.dev/v2/collections/collector_crypt/listings?offset=${offset}&limit=100`;
  const headers = process.env.MAGICEDEN_API_KEY ? { Authorization: `Bearer ${process.env.MAGICEDEN_API_KEY}` } : {};
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: `HTTP ${r.status}` });
    const data = await r.json();
    const rows = Array.isArray(data) ? data : [];
    const listings = rows.map((l) => {
      const t = l.token || {};
      const attrs = {};
      (t.attributes || []).forEach((a) => { if (a && a.trait_type) attrs[String(a.trait_type).toLowerCase()] = a.value; });
      const pick = (...names) => { for (const n of names) { if (attrs[n] != null && attrs[n] !== '') return attrs[n]; } return null; };
      const rawName = t.name || 'Graded card';
      const title = cleanTitle(rawName);
      const insured = parseFloat(pick('insured value'));
      const mint = l.tokenMint || t.mintAddress;
      return {
        id: mint,
        name: rawName,
        title,
        image: (l.extra && l.extra.img) || t.image || null,
        grade: gradeNum(pick('gradenum'), pick('the grade', 'grade')),
        gradeText: pick('the grade', 'grade'),
        grader: pick('grading company'),
        cert: pick('grading id'),
        set: pick('set'),
        year: pick('year'),
        insured: Number.isFinite(insured) ? insured : null,
        vault: pick('vault'),
        category: pick('category'),
        type: pick('type'),
        price: l.price,
        seller: l.seller,
        url: `https://magiceden.io/item-details/${mint}`,
      };
    }).filter((x) => /pok[eé]mon/i.test(x.category || '') && (!x.type || /card/i.test(x.type)));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ offset, nextOffset: rows.length === 100 ? offset + 100 : null, listings });
  } catch (e) {
    return res.status(502).json({ error: "We couldn't connect to the network. Please try again.", detail: String((e && e.message) || e) });
  }
}
