// ============================================================
// STOCK TRACKER — server.js
// Phase 1b: real prices.
// New concepts: calling an EXTERNAL api (Finnhub), reading a
// secret from process.env, async/await with real network calls,
// Promise.all for parallel requests, and graceful per-item errors.
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// STORAGE (still temporary — same limitation as Phase 1a)
// ------------------------------------------------------------
let watchlist = ['AAPL', 'NVDA'];

// ------------------------------------------------------------
// WATCHLIST ROUTES (unchanged from Phase 1a)
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
// PRICES — the new part.
// ------------------------------------------------------------

const FINNHUB_QUOTE_URL = 'https://finnhub.io/api/v1/quote';

// Fetch ONE ticker's current quote from Finnhub.
// We control the exact shape of what this returns, no matter
// what Finnhub sends back — that way the rest of our app never
// has to know or care about Finnhub's specific field names.
async function fetchQuote(ticker) {
  try {
    const url = `${FINNHUB_QUOTE_URL}?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);      // built into Node — no library needed
    const data = await response.json();

    // Finnhub returns c (current price) = 0 for tickers it can't find.
    // Treat that as "no data" rather than showing a fake $0.00.
    if (!data || data.c === 0) {
      return { ticker, error: 'No data found' };
    }

    return {
      ticker,
      price: data.c,            // current price
      change: data.d,           // dollar change today
      changePercent: data.dp,   // percent change today
    };
  } catch (err) {
    // Network hiccup, bad key, Finnhub down, etc.
    // One failed ticker should never break the other nine.
    return { ticker, error: 'Failed to fetch' };
  }
}

// ------------------------------------------------------------
// ROUTE: GET /api/prices
// Fetches a live quote for EVERY ticker on the watchlist at once.
//
// Promise.all runs all the requests IN PARALLEL. Without it, we'd
// fetch AAPL, wait for it to finish, then fetch NVDA, wait, etc —
// five tickers would take 5x as long as one. With Promise.all,
// they all fire at the same time and we wait for the slowest one.
// ------------------------------------------------------------
app.get('/api/prices', async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    // This is what protects us: if the Railway variable is ever
    // missing or mistyped, we get a clear error instead of a
    // confusing silent failure.
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const quotes = await Promise.all(
    watchlist.map(ticker => fetchQuote(ticker))
  );

  res.json({ quotes });
});

// Health check — still here, still useful.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'alive',
    time: new Date().toISOString(),
    message: 'Stock tracker server is running',
    hasApiKey: Boolean(process.env.FINNHUB_API_KEY)   // handy for debugging
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});
