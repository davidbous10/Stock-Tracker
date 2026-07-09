// ============================================================
// STOCK TRACKER — server.js
// Phase 2: real persistence with PostgreSQL.
// The in-memory "let watchlist = [...]" array is GONE. Every
// watchlist route now reads from / writes to a real database,
// so the list survives restarts, redeploys, everything.
// ============================================================

const express = require('express');
const path = require('path');
const { Pool } = require('pg');   // the Postgres library

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------
// DATABASE CONNECTION
// A "Pool" manages a small set of reusable connections to
// Postgres, rather than opening a brand new one for every
// request (which would be slow). connectionString comes from
// the DATABASE_URL environment variable — on Railway that's a
// reference to the Postgres service; locally, we point it at
// our own test database.
// ------------------------------------------------------------
const isLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// ------------------------------------------------------------
// initDb() — runs once when the server starts.
// CREATE TABLE IF NOT EXISTS means: make the table if it's
// missing, do nothing if it's already there. This is why we
// never had to click "Create table" in Railway's UI — the code
// sets up its own schema, every time, on every environment.
// ------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      ticker TEXT UNIQUE NOT NULL,
      added_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed two starter tickers, but ONLY the very first time ever
  // (empty table). Otherwise every restart would silently re-add
  // AAPL/NVDA even after you removed them.
  const { rows } = await pool.query('SELECT COUNT(*) FROM watchlist');
  if (parseInt(rows[0].count, 10) === 0) {
    await pool.query(
      `INSERT INTO watchlist (ticker) VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
      ['AAPL', 'NVDA']
    );
  }
}

// Small helper so every route doesn't repeat this same query
async function getAllTickers() {
  const { rows } = await pool.query('SELECT ticker FROM watchlist ORDER BY added_at ASC');
  return rows.map(r => r.ticker);
}

// ------------------------------------------------------------
// WATCHLIST ROUTES — same URLs and behavior as before, but now
// every handler is async and talks to Postgres instead of an array.
// ------------------------------------------------------------

app.get('/api/watchlist', async (req, res) => {
  try {
    const tickers = await getAllTickers();
    res.json({ tickers });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/watchlist', async (req, res) => {
  const raw = (req.body.ticker || '').trim().toUpperCase();

  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  try {
    await pool.query('INSERT INTO watchlist (ticker) VALUES ($1)', [raw]);
  } catch (err) {
    // Postgres error code 23505 = "unique_violation" — our own
    // UNIQUE constraint on the ticker column caught a duplicate.
    if (err.code === '23505') {
      return res.status(409).json({ error: raw + ' is already on the list' });
    }
    return res.status(500).json({ error: 'Database error' });
  }

  const tickers = await getAllTickers();
  res.json({ tickers });
});

app.delete('/api/watchlist/:ticker', async (req, res) => {
  const target = req.params.ticker.toUpperCase();
  try {
    await pool.query('DELETE FROM watchlist WHERE ticker = $1', [target]);
    const tickers = await getAllTickers();
    res.json({ tickers });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// PRICES — now pulls the ticker list from the database first
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

    return { ticker, price: data.c, change: data.d, changePercent: data.dp };
  } catch (err) {
    return { ticker, error: 'Failed to fetch' };
  }
}

app.get('/api/prices', async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const tickers = await getAllTickers();
    const quotes = await Promise.all(tickers.map(ticker => fetchQuote(ticker)));
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// SEARCH (unchanged from Phase 1c)
// ------------------------------------------------------------
const FINNHUB_SEARCH_URL = 'https://finnhub.io/api/v1/search';

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();

  if (!query) {
    return res.json({ results: [] });
  }
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const url = `${FINNHUB_SEARCH_URL}?q=${encodeURIComponent(query)}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    const results = (data.result || [])
      .filter(r => r.symbol && !r.symbol.includes('.') && r.symbol.length <= 6 && r.description)
      .slice(0, 6)
      .map(r => ({ symbol: r.symbol, name: r.description }));

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/health', async (req, res) => {
  let hasDatabase = false;
  try {
    await pool.query('SELECT 1');
    hasDatabase = true;
  } catch (err) {
    hasDatabase = false;
  }

  res.json({
    status: 'alive',
    time: new Date().toISOString(),
    message: 'Stock tracker server is running',
    hasApiKey: Boolean(process.env.FINNHUB_API_KEY),
    hasDatabase,
  });
});

// ------------------------------------------------------------
// STARTUP — we now wait for the database to be ready (table
// created) BEFORE accepting any traffic, avoiding a race where
// the very first request arrives before the table exists.
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Stock tracker running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
