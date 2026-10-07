// Vercel serverless function: SOL price in USD, cached for a minute.
// Tries Jupiter first, then CoinGecko.
export default async function handler(req, res) {
  const SOL = 'So11111111111111111111111111111111111111112';
  const sources = [
    async () => { const j = await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`)).json(); return j && j[SOL] && (j[SOL].usdPrice || j[SOL].price); },
    async () => { const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).json(); return j && j.solana && j.solana.usd; },
  ];
  for (const get of sources) {
    try {
      const usd = parseFloat(await get());
      if (Number.isFinite(usd) && usd > 0) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({ usd });
      }
    } catch (e) {}
  }
  return res.status(502).json({ error: "We couldn't load the SOL price." });
}
