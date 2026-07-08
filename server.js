// ============================================================
// STOCK TRACKER — server.js
// Phase 1a: the watchlist.
// New concepts: POST routes (receiving data), DELETE routes,
// URL parameters, input validation, and in-memory storage.
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// STORAGE (temporary version)
// A plain array living in the server's memory.
// IMPORTANT LIMITATION we accept for now: when Railway restarts
// the server (redeploys, maintenance), this array resets.
// A real database fixes that — it's a later step, on purpose.
// ------------------------------------------------------------
let watchlist = ['AAPL', 'NVDA'];   // start with two so the page isn't empty

// ------------------------------------------------------------
// ROUTE 1: GET /api/watchlist
// "Give me the current list."
// ------------------------------------------------------------
app.get('/api/watchlist', (req, res) => {
  res.json({ tickers: watchlist });
});

// ------------------------------------------------------------
// ROUTE 2: POST /api/watchlist
// "Here's a new ticker, add it."
// POST = the browser is SENDING data. The data arrives in
// req.body (unpacked for us by express.json()).
// ------------------------------------------------------------
app.post('/api/watchlist', (req, res) => {
  // 1. Pull the ticker out of the request body.
  //    "|| ''" means: if it's missing, use an empty string
  //    instead of crashing.
  const raw = (req.body.ticker || '').trim().toUpperCase();

  // 2. VALIDATE. Never trust incoming data — rule #1 of backends.
  //    This regex allows 1-6 letters (with an optional dot,
  //    for tickers like BRK.B). Anything else is rejected.
  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  // 3. No duplicates.
  if (watchlist.includes(raw)) {
    return res.status(409).json({ error: raw + ' is already on the list' });
  }

  // 4. All checks passed — save it and confirm.
  watchlist.push(raw);
  res.json({ tickers: watchlist });
});

// ------------------------------------------------------------
// ROUTE 3: DELETE /api/watchlist/:ticker
// "Remove this one."
// The :ticker part is a URL PARAMETER — a blank that the
// requester fills in. DELETE /api/watchlist/NVDA makes
// req.params.ticker equal "NVDA".
// ------------------------------------------------------------
app.delete('/api/watchlist/:ticker', (req, res) => {
  const target = req.params.ticker.toUpperCase();

  // .filter() builds a new array keeping only items that pass
  // the test — i.e. everything EXCEPT the target.
  watchlist = watchlist.filter(t => t !== target);

  res.json({ tickers: watchlist });
});

// Health check from Phase 0 — keeping it, it's useful forever.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'alive',
    time: new Date().toISOString(),
    message: 'Stock tracker server is running'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});
