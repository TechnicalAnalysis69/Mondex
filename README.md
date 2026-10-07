# MONDEX — prototype site

Static site (`index.html`) plus one serverless function (`api/cards.js`) that pulls
real card images and TCGplayer market prices from the Pokémon TCG API.

## Deploy on Vercel
1. Put this folder in a GitHub repo and import it in Vercel (framework preset: Other).
2. Optional: add `POKEMONTCG_API_KEY` under Settings → Environment Variables
   (free key from https://dev.pokemontcg.io). Without it the API still works at a lower rate limit.
3. Deploy. The site calls `/api/cards` on load; if that fails it calls the public API directly,
   and if both fail it shows placeholder card faces.

## Live Slabs (real Collector Crypt cards)
Add these in Vercel → Settings → Environment Variables, then redeploy:
- `HELIUS_API_KEY` — from dashboard.helius.dev
- `CC_COLLECTION` — Collector Crypt's collection address (open any of their cards on Solscan and copy the "Collection" address)

## Where real services plug in
Search `index.html` for `INTEGRATION POINT`: wallet (Solana wallet adapter), marketplace
listings, vault/custody, verifiable randomness for pack pulls, pricing, and Collector Crypt.

## Still demo data
Listings, users, balances, graded/insured values, pack odds and buyback are demo values.
Raw TCGplayer market prices are live when the API responds.
