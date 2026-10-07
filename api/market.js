// One serverless function for the market pages (the Hobby plan allows 12 functions per deployment).
// vercel.json routes /api/card, /api/screener, /api/search and /c/<key> here.
import card from './_card.js';
import screener from './_screener.js';
import search from './_search.js';
import share from './_share.js';

const routes = { card, screener, search, share };

export default function handler(req, res) {
  const fn = routes[String(req.query.fn || '')];
  if (!fn) return res.status(404).json({ error: 'Not found.' });
  return fn(req, res);
}
