// ============================================================
// STOCK TRACKER — server.js
// Phase 1c: search by company name.
// New concept: a SEARCH route that proxies Finnhub's symbol
// lookup, so the frontend never talks to Finnhub directly
// (keeps our API key server-side, where it belongs).
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let watchlist = ['AAPL', 'NVDA'];

// ------------------------------------------------------------
// WATCHLIST ROUTES (unchanged)
// ------------------------------------------------------------
app.get('/api/watchlist', (req, res) => {
  res.json({ tickers: watchlist });
});

app.post('/api/watchlist', (req, res) => {
  const raw = (req.body.ticker || '').trim().toUpperCase();

  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }
  if (watchlist.includes(raw)) {
    return res.status(409).json({ error: raw + ' is already on the list' });
  }

  watchlist.push(raw);
  res.json({ tickers: watchlist });
});

app.delete('/api/watchlist/:ticker', (req, res) => {
  const target = req.params.ticker.toUpperCase();
  watchlist = watchlist.filter(t => t !== target);
  res.json({ tickers: watchlist });
});

// ------------------------------------------------------------
// PRICES (unchanged from Phase 1b)
// ------------------------------------------------------------
const FINNHUB_QUOTE_URL = 'https://finnhub.io/api/v1/quote';

async function fetchQuote(ticker) {
  try {
    const url = `${FINNHUB_QUOTE_URL}?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data || data.c === 0) {
      return { ticker, error: 'No data found' };
    }

    return {
      ticker,
      price: data.c,
      change: data.d,
      changePercent: data.dp,
    };
  } catch (err) {
    return { ticker, error: 'Failed to fetch' };
  }
}

app.get('/api/prices', async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const quotes = await Promise.all(watchlist.map(ticker => fetchQuote(ticker)));
  res.json({ quotes });
});

// ------------------------------------------------------------
// SEARCH — the new part.
// ROUTE: GET /api/search?q=amazon
// Looks up company names / tickers via Finnhub's search endpoint
// and hands back a short, clean list: [{ symbol, name }, ...]
// ------------------------------------------------------------
const FINNHUB_SEARCH_URL = 'https://finnhub.io/api/v1/search';

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();

  if (!query) {
    return res.json({ results: [] });   // empty box = empty results, no error
  }
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const url = `${FINNHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    // Finnhub returns lots of noise (foreign listings, odd symbol
    // formats). Keep it simple: plain tickers (no dots), max 6
    // characters, top 6 matches. Not perfect, but clean for common
    // stocks — which covers the vast majority of real searches.
    const results = (data.result || [])
      .filter(r => r.symbol && !r.symbol.includes('.') && r.symbol.length <= 6 && r.description)
      .slice(0, 6)
      .map(r => ({ symbol: r.symbol, name: r.description }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'alive',
    time: new Date().toISOString(),
    message: 'Stock tracker server is running',
    hasApiKey: Boolean(process.env.FINNHUB_API_KEY)
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});
