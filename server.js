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

// Tracks whether the database has finished connecting. Routes
// that need the database check this first, so a request arriving
// during the brief startup window gets a clean "still starting"
// message instead of hanging or erroring strangely.
let dbReady = false;

function requireDb(res) {
  if (!dbReady) {
    res.status(503).json({ error: 'Database is still starting up — try again in a few seconds' });
    return false;
  }
  return true;
}

// ------------------------------------------------------------
// initDb() — runs once when the server starts.
// CREATE TABLE IF NOT EXISTS means: make the table if it's
// missing, do nothing if it's already there. This is why we
// never had to click "Create table" in Railway's UI — the code
// sets up its own schema, every time, on every environment.
// ------------------------------------------------------------
// Retries connecting up to `retries` times, waiting `delayMs`
// between attempts. This protects us from a very real timing
// issue: on a redeploy, Postgres and our server can both restart
// around the same moment, and Postgres may need a few extra
// seconds to be ready. Without a retry, our server gives up on
// the very first attempt and crashes. With it, we patiently wait.
async function initDb(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS watchlist (
          id SERIAL PRIMARY KEY,
          ticker TEXT UNIQUE NOT NULL,
          added_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // MIGRATION: add a "name" column for company names (e.g. "Apple
      // Inc."), needed for the redesigned UI. IF NOT EXISTS means this
      // is safe to run every single startup — it only actually does
      // anything the first time, then becomes a harmless no-op forever
      // after. This is how real apps evolve their database shape over
      // time without ever touching production data by hand.
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS name TEXT`);
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS logo TEXT`);

      // MIGRATION: add a "sort_order" column so drag-and-drop reordering
      // has somewhere to live. For rows that already exist (added before
      // this feature), backfill their sort_order from their original
      // added_at order — so nothing visually jumps around the first
      // time this deploys. New tickers get their sort_order set
      // explicitly when inserted (see the POST route below).
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      await pool.query(`
        UPDATE watchlist SET sort_order = sub.rn
        FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY added_at ASC) AS rn FROM watchlist) sub
        WHERE watchlist.id = sub.id AND watchlist.sort_order IS NULL
      `);

      const { rows } = await pool.query('SELECT COUNT(*) FROM watchlist');
      if (parseInt(rows[0].count, 10) === 0) {
        await pool.query(
          `INSERT INTO watchlist (ticker, sort_order) VALUES ($1, 0), ($2, 1) ON CONFLICT DO NOTHING`,
          ['AAPL', 'NVDA']
        );
      }

      // A brand new table for historical price points, one row per
      // (ticker, moment we checked). This is a DIFFERENT table from
      // "watchlist" on purpose — watchlist is "what you're tracking",
      // price_history is "what we've observed over time" for those
      // tickers. Keeping them separate keeps each table's job simple.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS price_history (
          id SERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          price NUMERIC NOT NULL,
          recorded_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // An index makes "give me all the points for ticker X, in order"
      // fast even once this table has thousands of rows — without it,
      // Postgres would have to scan the entire table every single time.
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_price_history_ticker_time
        ON price_history (ticker, recorded_at)
      `);

      // Alert rules. condition_type is one of:
      //   percent_drop / percent_gain — checked against today's % move,
      //     allowed to refire once every 24h (the underlying % change
      //     itself resets daily, so this pairs naturally)
      //   price_above / price_below — a fixed dollar threshold, fires
      //     once and then auto-deactivates (active = false), since a
      //     stock parked above/below a price for weeks shouldn't email
      //     you daily about it
      await pool.query(`
        CREATE TABLE IF NOT EXISTS alerts (
          id SERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          condition_type TEXT NOT NULL,
          threshold NUMERIC NOT NULL,
          active BOOLEAN DEFAULT true,
          last_triggered_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      console.log('Database connected and ready.');
      dbReady = true;
      return;   // success — stop retrying
    } catch (err) {
      console.log(`Database not ready yet (attempt ${attempt}/${retries}): code=${err.code} message=${err.message} address=${err.address} port=${err.port} host=${err.hostname || ''}`);
      if (attempt === retries) {
        // Out of attempts. Don't crash the whole process — just
        // leave dbReady false. The health check and every DB
        // route will keep reporting "not ready" instead of the
        // entire site going dark.
        console.error('Giving up on database connection after all retries.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Small helper so every route doesn't repeat this same query.
// Returns [{ ticker, name }, ...] — name may be null for tickers
// added before this column existed, or added by raw ticker typed
// directly rather than picked from search.
async function getAllWatchlistItems() {
  const { rows } = await pool.query('SELECT ticker, name, logo, sort_order FROM watchlist ORDER BY sort_order ASC');
  return rows;
}

// Looks up a company's logo (and canonical name) from Finnhub's free
// company-profile endpoint. Used once, at the moment a ticker is
// added — not on every price refresh, since a logo never changes.
// If this fails for any reason (bad ticker, Finnhub hiccup), we
// simply store no logo — the frontend falls back to a colored
// initial badge, so nothing breaks.
async function fetchCompanyProfile(ticker) {
  try {
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    return {
      name: data && data.name ? data.name : null,
      logo: data && data.logo ? data.logo : null,
    };
  } catch (err) {
    return { name: null, logo: null };
  }
}

// ------------------------------------------------------------
// WATCHLIST ROUTES — same URLs and behavior as before, but now
// every handler is async and talks to Postgres instead of an array.
// ------------------------------------------------------------

app.get('/api/watchlist', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const items = await getAllWatchlistItems();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/watchlist', async (req, res) => {
  if (!requireDb(res)) return;
  const raw = (req.body.ticker || '').trim().toUpperCase();
  const suppliedName = (req.body.name || '').trim() || null;

  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  // Look up the logo (and a canonical name as backup) once, right
  // now, at add-time — not on every future price refresh.
  const profile = process.env.FINNHUB_API_KEY
    ? await fetchCompanyProfile(raw)
    : { name: null, logo: null };
  const name = suppliedName || profile.name;

  try {
    // New tickers land at the end of the list: their sort_order is
    // one more than the current highest. COALESCE handles the very
    // first insert ever, when MAX(sort_order) is NULL (empty table).
    await pool.query(
      `INSERT INTO watchlist (ticker, name, logo, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM watchlist), 0) + 1)`,
      [raw, name, profile.logo]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: raw + ' is already on the list' });
    }
    return res.status(500).json({ error: 'Database error' });
  }

  const items = await getAllWatchlistItems();
  res.json({ items });
});

app.delete('/api/watchlist/:ticker', async (req, res) => {
  if (!requireDb(res)) return;
  const target = req.params.ticker.toUpperCase();
  try {
    await pool.query('DELETE FROM watchlist WHERE ticker = $1', [target]);
    const items = await getAllWatchlistItems();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ROUTE: POST /api/watchlist/reorder
// Takes the full new ticker order as an array, e.g.
// { order: ["NVDA", "AAPL", "GOOG"] }, and rewrites every row's
// sort_order to match its position in that array.
//
// This uses a TRANSACTION: pool.connect() checks out one dedicated
// connection, BEGIN starts it, and every UPDATE inside either all
// succeed together (COMMIT) or all get undone together (ROLLBACK)
// if anything fails partway through. Without this, a crash halfway
// through updating 5 rows could leave your watchlist in a broken,
// half-reordered state. With it, reordering is all-or-nothing.
// ------------------------------------------------------------
app.post('/api/watchlist/reorder', async (req, res) => {
  if (!requireDb(res)) return;
  const order = req.body.order;

  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of tickers' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE watchlist SET sort_order = $1 WHERE ticker = $2',
        [i, String(order[i]).toUpperCase()]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();   // always return the connection to the pool
  }

  const items = await getAllWatchlistItems();
  res.json({ items });
});

// ------------------------------------------------------------
// PRICES — now also captures day high/low/open, needed for the
// day-range bar in the redesigned UI.
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
      dayHigh: data.h,
      dayLow: data.l,
      dayOpen: data.o,
    };
  } catch (err) {
    return { ticker, error: 'Failed to fetch' };
  }
}

app.get('/api/prices', async (req, res) => {
  if (!requireDb(res)) return;
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const items = await getAllWatchlistItems();
    const quotes = await Promise.all(items.map(item => fetchQuote(item.ticker)));
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ROUTE: GET /api/history
// Returns every stored price point for every ticker currently on
// the watchlist, grouped by ticker, oldest first — exactly what a
// sparkline needs to draw a trend line. One request covers the
// whole list, same pattern as /api/prices.
// ------------------------------------------------------------
app.get('/api/history', async (req, res) => {
  if (!requireDb(res)) return;

  try {
    const items = await getAllWatchlistItems();
    const tickers = items.map(i => i.ticker);

    if (tickers.length === 0) {
      return res.json({ history: {} });
    }

    const { rows } = await pool.query(
      'SELECT ticker, price, recorded_at FROM price_history WHERE ticker = ANY($1) ORDER BY recorded_at ASC',
      [tickers]
    );

    // Build { AAPL: [{price, recorded_at}, ...], NVDA: [...] } so the
    // frontend can look up each card's points by ticker directly.
    const history = {};
    tickers.forEach(t => { history[t] = []; });
    rows.forEach(r => {
      history[r.ticker].push({ price: parseFloat(r.price), recordedAt: r.recorded_at });
    });

    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ALERT ROUTES — create, list, and delete alert rules. The actual
// checking and emailing happens in runScheduledChecks() below,
// not here — these routes only manage the rules themselves.
// ------------------------------------------------------------
const VALID_ALERT_TYPES = ['percent_drop', 'percent_gain', 'price_above', 'price_below'];

app.get('/api/alerts', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC');
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/alerts', async (req, res) => {
  if (!requireDb(res)) return;

  const ticker = (req.body.ticker || '').trim().toUpperCase();
  const conditionType = req.body.conditionType;
  const threshold = parseFloat(req.body.threshold);

  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }
  if (!VALID_ALERT_TYPES.includes(conditionType)) {
    return res.status(400).json({ error: 'Invalid alert type' });
  }
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return res.status(400).json({ error: 'Threshold must be a positive number' });
  }

  try {
    await pool.query(
      'INSERT INTO alerts (ticker, condition_type, threshold) VALUES ($1, $2, $3)',
      [ticker, conditionType, threshold]
    );
    const { rows } = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC');
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/alerts/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    await pool.query('DELETE FROM alerts WHERE id = $1', [req.params.id]);
    const { rows } = await pool.query('SELECT * FROM alerts ORDER BY created_at DESC');
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// SCHEDULED SNAPSHOTS — the first piece of the app that runs on
// its own, independent of anyone having the page open.
//
// Every SNAPSHOT_INTERVAL_MS, we record the current price of every
// watchlist ticker into price_history. Over hours and days, this
// naturally builds up the trend line the sparkline draws — Finnhub's
// free tier doesn't give us historical data directly, so we're
// generating our own by simply checking regularly and remembering.
// ------------------------------------------------------------
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const HISTORY_RETENTION_DAYS = 7;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;   // 24 hours

// Checks a single alert rule against a fresh quote. Returns true if
// its condition is currently met — pure comparison logic, no side
// effects, which makes it easy to test on its own.
function alertConditionMet(alert, quote) {
  const threshold = parseFloat(alert.threshold);
  switch (alert.condition_type) {
    case 'percent_drop': return quote.changePercent <= -threshold;
    case 'percent_gain': return quote.changePercent >= threshold;
    case 'price_above': return quote.price >= threshold;
    case 'price_below': return quote.price <= threshold;
    default: return false;
  }
}

function describeAlert(alert) {
  const t = parseFloat(alert.threshold);
  switch (alert.condition_type) {
    case 'percent_drop': return `dropped ${t}% or more today`;
    case 'percent_gain': return `rose ${t}% or more today`;
    case 'price_above': return `reached $${t.toFixed(2)} or higher`;
    case 'price_below': return `fell to $${t.toFixed(2)} or lower`;
    default: return 'met your alert condition';
  }
}

// Sends one alert email via Resend's API — same fetch-based pattern
// as every other external call in this app. If Resend isn't
// configured, this quietly does nothing rather than erroring —
// alerts still get created and evaluated, they just won't email
// until both EMAIL_API_KEY and ALERT_EMAIL are set in Railway.
async function sendAlertEmail(alert, quote) {
  if (!process.env.EMAIL_API_KEY || !process.env.ALERT_EMAIL) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Stock Tracker <onboarding@resend.dev>',
        to: [process.env.ALERT_EMAIL],
        subject: `${alert.ticker} alert: ${describeAlert(alert)}`,
        text: `${alert.ticker} is now $${quote.price.toFixed(2)} ` +
          `(${quote.changePercent > 0 ? '+' : ''}${quote.changePercent.toFixed(2)}% today).\n\n` +
          `This alert was set to notify you when it ${describeAlert(alert)}.`,
      }),
    });
    console.log(`Sent alert email for ${alert.ticker}.`);
  } catch (err) {
    console.log('Failed to send alert email:', err.message);
  }
}

// For one ticker's fresh quote, check every active alert rule that
// watches it, and fire + update whichever ones are triggered.
async function checkAlertsForTicker(ticker, quote) {
  const { rows: activeAlerts } = await pool.query(
    'SELECT * FROM alerts WHERE ticker = $1 AND active = true',
    [ticker]
  );

  for (const alert of activeAlerts) {
    if (!alertConditionMet(alert, quote)) continue;

    const isOneTime = alert.condition_type === 'price_above' || alert.condition_type === 'price_below';

    if (isOneTime) {
      await sendAlertEmail(alert, quote);
      await pool.query(
        'UPDATE alerts SET active = false, last_triggered_at = NOW() WHERE id = $1',
        [alert.id]
      );
    } else {
      const cooledDown = !alert.last_triggered_at ||
        (Date.now() - new Date(alert.last_triggered_at).getTime()) > ALERT_COOLDOWN_MS;
      if (cooledDown) {
        await sendAlertEmail(alert, quote);
        await pool.query('UPDATE alerts SET last_triggered_at = NOW() WHERE id = $1', [alert.id]);
      }
    }
  }
}

// ------------------------------------------------------------
// runScheduledChecks() — runs every SNAPSHOT_INTERVAL_MS, on its
// own, independent of anyone having the page open. For every
// watchlist ticker it: fetches one fresh quote, stores it in
// price_history (feeding the sparkline), and checks that same
// quote against any alert rules for that ticker (feeding email
// notifications) — one Finnhub call serving two features.
// ------------------------------------------------------------
async function runScheduledChecks() {
  if (!dbReady) return;

  if (process.env.FINNHUB_API_KEY) {
    try {
      const items = await getAllWatchlistItems();
      for (const item of items) {
        const quote = await fetchQuote(item.ticker);
        if (!quote.error) {
          await pool.query(
            'INSERT INTO price_history (ticker, price) VALUES ($1, $2)',
            [item.ticker, quote.price]
          );
          await checkAlertsForTicker(item.ticker, quote);
        }
      }
      console.log(`Checked ${items.length} ticker(s): snapshotted + evaluated alerts.`);
    } catch (err) {
      console.log('Scheduled check failed:', err.message);
    }
  }

  try {
    await pool.query(
      `DELETE FROM price_history WHERE recorded_at < NOW() - INTERVAL '${HISTORY_RETENTION_DAYS} days'`
    );
  } catch (err) {
    console.log('History cleanup failed:', err.message);
  }
}

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
// STARTUP — the key fix.
//
// Previously we made app.listen() WAIT for the database to be
// fully ready first. That backfired: while retrying a slow
// database connection (up to 30 seconds), the server wasn't
// listening on its port at all, and Railway's proxy showed
// "Application failed to respond" — because nothing was there
// to respond.
//
// The correct pattern: start listening immediately, so the app
// is always reachable. Run the database connection separately,
// in the background. Any request that needs the database before
// it's ready gets a clean 503 "still starting up" message
// (handled by requireDb above), instead of the whole site
// appearing broken.
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});

initDb();   // fires immediately, retries quietly in the background

// Take one snapshot shortly after startup, so charts have at least
// one data point without waiting a full 15 minutes for the first
// scheduled run. Then keep snapshotting on the regular interval.
setTimeout(runScheduledChecks, 8000);
setInterval(runScheduledChecks, SNAPSHOT_INTERVAL_MS);
