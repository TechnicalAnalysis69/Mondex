// Vercel serverless function: proxies the Pokémon TCG API (pokemontcg.io) so the
// API key stays on the server. Set POKEMONTCG_API_KEY in Vercel → Settings →
// Environment Variables (free key at https://dev.pokemontcg.io). Works without a
// key too, at a lower rate limit.
export default async function handler(req, res) {
  const ids = String(req.query.ids || '')
    .split(',')
    .filter((id) => /^[a-z0-9]+-\d+$/i.test(id))
    .slice(0, 250);
  if (!ids.length) return res.status(400).json({ error: 'No valid card ids.' });

  const q = ids.map((id) => `id:${id}`).join(' OR ');
  const url = `https://api.pokemontcg.io/v2/cards?pageSize=250&select=id,name,number,set,images,tcgplayer&q=${encodeURIComponent(q)}`;
  const headers = process.env.POKEMONTCG_API_KEY ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY } : {};

  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return res.status(502).json({ error: `Card API returned ${r.status}.` });
    const data = await r.json();
    // Cache at the edge for an hour; serve stale for a day while refreshing.
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: "We couldn't reach the card API. Please try again." });
  }
}
