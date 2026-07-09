// ============================================================
// STOCK TRACKER — server.js
// Phase 3: user accounts. Every watchlist and every alert now
// belongs to a specific logged-in person, instead of one shared
// list for whoever visits the URL.
// ============================================================

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();

// REQUIRED when running behind any reverse proxy (which Railway
// always is — your browser talks to Railway's edge, which then
// forwards the request to our server). Without this, Express can't
// correctly tell the connection is HTTPS, which breaks "secure"
// cookies like our login session — they'd get set on signup, but
// silently fail to be sent back on the very next request. This one
// line is the documented fix.
app.set('trust proxy', 1);
app.use(express.json());

const isLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

let dbReady = false;

function requireDb(res) {
  if (!dbReady) {
    res.status(503).json({ error: 'Database is still starting up — try again in a few seconds' });
    return false;
  }
  return true;
}

// ------------------------------------------------------------
// SESSIONS — how the server remembers "you're logged in" between
// requests. connect-pg-simple stores session data in Postgres
// (in its own auto-created "session" table), so — same principle
// as everything else in this app — a restart doesn't log everyone
// out. The browser holds only a small signed cookie that points
// at that stored session; it never contains the password or
// anything sensitive itself.
// ------------------------------------------------------------
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,   // 30 days
    httpOnly: true,                     // JavaScript can't read this cookie — blocks a common attack
    secure: !isLocal,                   // HTTPS-only in production; Railway terminates HTTPS for us
    sameSite: 'lax',
  },
}));

// Serve static files AFTER session middleware, so cookies are
// available to every request, static or not.
app.use(express.static(path.join(__dirname, 'public')));

// Any route wrapped with this must have a logged-in user, or it
// short-circuits with 401 before the route's own code ever runs.
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Please log in' });
  }
  next();
}

// ------------------------------------------------------------
// initDb() — schema setup and migrations, same retry pattern as
// before. New this phase: a "users" table, a user_id column on
// both watchlist and alerts, and a corrected UNIQUE constraint —
// tickers must now be unique PER USER, not globally (two different
// people both watching AAPL is normal, not a conflict).
// ------------------------------------------------------------
async function initDb(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS watchlist (
          id SERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          added_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS name TEXT`);
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS logo TEXT`);
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
      await pool.query(`
        UPDATE watchlist SET sort_order = sub.rn
        FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY added_at ASC) AS rn FROM watchlist) sub
        WHERE watchlist.id = sub.id AND watchlist.sort_order IS NULL
      `);

      // ---- USERS ----
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // MIGRATION: give watchlist and alerts an owner. Existing rows
      // (created back when there was only ever one shared list) get
      // user_id = NULL for now — the very first person to sign up
      // automatically inherits them, handled in the /signup route.
      await pool.query(`ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`);

      // MIGRATION: the old rule was "no duplicate ticker, period."
      // The correct rule now is "no duplicate ticker for the SAME
      // user" — otherwise a second person could never add AAPL just
      // because someone else already has it on their own list.
      await pool.query(`ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_ticker_key`);
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'watchlist_user_ticker_unique'
          ) THEN
            ALTER TABLE watchlist ADD CONSTRAINT watchlist_user_ticker_unique UNIQUE (user_id, ticker);
          END IF;
        END $$;
      `);

      const { rows } = await pool.query('SELECT COUNT(*) FROM watchlist');
      if (parseInt(rows[0].count, 10) === 0) {
        await pool.query(
          `INSERT INTO watchlist (ticker, sort_order) VALUES ($1, 0), ($2, 1) ON CONFLICT DO NOTHING`,
          ['AAPL', 'NVDA']
        );
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS price_history (
          id SERIAL PRIMARY KEY,
          ticker TEXT NOT NULL,
          price NUMERIC NOT NULL,
          recorded_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_price_history_ticker_time
        ON price_history (ticker, recorded_at)
      `);

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
      // This can only run now that both "alerts" and "users" definitely
      // exist — ordering matters for ALTER TABLE ... REFERENCES.
      await pool.query(`ALTER TABLE alerts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`);

      console.log('Database connected and ready.');
      dbReady = true;
      return;
    } catch (err) {
      console.log(`Database not ready yet (attempt ${attempt}/${retries}): code=${err.code} message=${err.message}`);
      if (attempt === retries) {
        console.error('Giving up on database connection after all retries.');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function getAllWatchlistItems(userId) {
  const { rows } = await pool.query(
    'SELECT ticker, name, logo, sort_order FROM watchlist WHERE user_id = $1 ORDER BY sort_order ASC',
    [userId]
  );
  return rows;
}

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
// AUTH ROUTES
// ------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/auth/signup', async (req, res) => {
  if (!requireDb(res)) return;

  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Hashing turns the password into a one-way scrambled string —
    // we never store (or could even recover) the actual password.
    // The "10" is the cost factor: how many times to scramble. Higher
    // is slower but harder to brute-force; 10 is a solid default.
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, passwordHash]
    );
    const userId = rows[0].id;

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM users');
    const isFirstUserEver = parseInt(countRows[0].count, 10) === 1;

    if (isFirstUserEver) {
      // Whoever signs up first inherits whatever was on the shared
      // list before accounts existed — nobody's existing data
      // vanishes just because login now exists.
      await pool.query('UPDATE watchlist SET user_id = $1 WHERE user_id IS NULL', [userId]);
      await pool.query('UPDATE alerts SET user_id = $1 WHERE user_id IS NULL', [userId]);
    } else {
      // Everyone after that starts fresh with a small starter list.
      await pool.query(
        `INSERT INTO watchlist (ticker, sort_order, user_id) VALUES ($1, 0, $3), ($2, 1, $3)`,
        ['AAPL', 'NVDA', userId]
      );
    }

    req.session.userId = userId;
    req.session.userEmail = email;
    res.json({ email });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!requireDb(res)) return;

  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  try {
    const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);

    // Deliberately the SAME error message whether the email doesn't
    // exist or the password is wrong. Being specific ("no account
    // with that email") would let an attacker discover which emails
    // have accounts here just by trying them — a real, well-known
    // security leak called a "user enumeration" bug.
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = rows[0].id;
    req.session.userEmail = email;
    res.json({ email });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  try {
    const { rows } = await pool.query('SELECT created_at FROM users WHERE id = $1', [req.session.userId]);
    res.json({
      email: req.session.userEmail,
      createdAt: rows[0] ? rows[0].created_at : null,
    });
  } catch (err) {
    // Even if the extra lookup fails, the person is still legitimately
    // logged in — don't block that on a non-essential detail.
    res.json({ email: req.session.userEmail, createdAt: null });
  }
});

// ------------------------------------------------------------
// ROUTE: POST /api/auth/change-password
// Requires the CURRENT password before allowing a new one — this
// is what stops someone who's grabbed your unlocked laptop (but
// doesn't know your password) from locking you out of your own
// account by just setting a new one.
// ------------------------------------------------------------
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;

  const currentPassword = req.body.currentPassword || '';
  const newPassword = req.body.newPassword || '';

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const match = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// WATCHLIST ROUTES — every one now requires login, and every
// query is scoped to req.session.userId, so what you see is only
// ever your own list.
// ------------------------------------------------------------

app.get('/api/watchlist', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const items = await getAllWatchlistItems(req.session.userId);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const raw = (req.body.ticker || '').trim().toUpperCase();
  const suppliedName = (req.body.name || '').trim() || null;

  if (!/^[A-Z]{1,6}(\.[A-Z])?$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  const profile = process.env.FINNHUB_API_KEY
    ? await fetchCompanyProfile(raw)
    : { name: null, logo: null };
  const name = suppliedName || profile.name;
  const userId = req.session.userId;

  try {
    await pool.query(
      `INSERT INTO watchlist (ticker, name, logo, sort_order, user_id)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) FROM watchlist WHERE user_id = $4), 0) + 1, $4)`,
      [raw, name, profile.logo, userId]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: raw + ' is already on your list' });
    }
    return res.status(500).json({ error: 'Database error' });
  }

  const items = await getAllWatchlistItems(userId);
  res.json({ items });
});

app.delete('/api/watchlist/:ticker', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const target = req.params.ticker.toUpperCase();
  try {
    await pool.query('DELETE FROM watchlist WHERE ticker = $1 AND user_id = $2', [target, req.session.userId]);
    const items = await getAllWatchlistItems(req.session.userId);
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/watchlist/reorder', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const order = req.body.order;
  const userId = req.session.userId;

  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'order must be a non-empty array of tickers' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE watchlist SET sort_order = $1 WHERE ticker = $2 AND user_id = $3',
        [i, String(order[i]).toUpperCase(), userId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }

  const items = await getAllWatchlistItems(userId);
  res.json({ items });
});

// ------------------------------------------------------------
// PRICES
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

app.get('/api/prices', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const items = await getAllWatchlistItems(req.session.userId);
    const quotes = await Promise.all(items.map(item => fetchQuote(item.ticker)));
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ROUTE: GET /api/indexes
// A small fixed set of quotes for the homepage's "market pulse"
// strip. Finnhub's free tier doesn't support real index tickers
// (like ^GSPC for the S&P 500) — those need a paid plan. Instead
// we use the ETFs that track each index almost exactly: SPY
// tracks the S&P 500, DIA tracks the Dow, QQQ tracks the Nasdaq
// 100. They're ordinary, fully-supported stock tickers as far as
// Finnhub is concerned, so this reuses fetchQuote() unchanged.
// ------------------------------------------------------------
const MARKET_INDEXES = [
  { ticker: 'SPY', label: 'S&P 500' },
  { ticker: 'DIA', label: 'Dow Jones' },
  { ticker: 'QQQ', label: 'Nasdaq 100' },
];

app.get('/api/indexes', requireAuth, async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const quotes = await Promise.all(
      MARKET_INDEXES.map(async (idx) => ({ ...idx, ...(await fetchQuote(idx.ticker)) }))
    );
    res.json({ indexes: quotes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load market indexes' });
  }
});

// ------------------------------------------------------------
// HISTORY — price_history itself stays a SHARED table (a price
// snapshot for AAPL at a given moment is the same fact regardless
// of who's watching it — no reason to duplicate that data per
// user). Only the "which tickers do I care about" part is scoped
// to the logged-in user.
// ------------------------------------------------------------
app.get('/api/history', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;

  try {
    const items = await getAllWatchlistItems(req.session.userId);
    const tickers = items.map(i => i.ticker);

    if (tickers.length === 0) {
      return res.json({ history: {} });
    }

    const { rows } = await pool.query(
      'SELECT ticker, price, recorded_at FROM price_history WHERE ticker = ANY($1) ORDER BY recorded_at ASC',
      [tickers]
    );

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
// ALERT ROUTES — scoped to the logged-in user, same pattern.
// ------------------------------------------------------------
const VALID_ALERT_TYPES = ['percent_drop', 'percent_gain', 'price_above', 'price_below'];

app.get('/api/alerts', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;

  const ticker = (req.body.ticker || '').trim().toUpperCase();
  const conditionType = req.body.conditionType;
  const threshold = parseFloat(req.body.threshold);
  const userId = req.session.userId;

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
      'INSERT INTO alerts (ticker, condition_type, threshold, user_id) VALUES ($1, $2, $3, $4)',
      [ticker, conditionType, threshold, userId]
    );
    const { rows } = await pool.query('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/alerts/:id', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const userId = req.session.userId;
  try {
    // The "AND user_id = $2" here matters a lot: without it, anyone
    // logged in could delete anyone else's alert just by guessing
    // its id. This is the same scoping principle as every other
    // route, just easy to forget on a delete-by-id route specifically.
    await pool.query('DELETE FROM alerts WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const { rows } = await pool.query('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    res.json({ alerts: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// SCHEDULED CHECKS
// ------------------------------------------------------------
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_RETENTION_DAYS = 7;
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

// Now emails whichever user owns the alert, not a single hardcoded
// address — each person gets notified at their own signup email.
async function sendAlertEmail(alert, quote) {
  if (!process.env.EMAIL_API_KEY || !alert.user_email) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.EMAIL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Stock Tracker <onboarding@resend.dev>',
        to: [alert.user_email],
        subject: `${alert.ticker} alert: ${describeAlert(alert)}`,
        text: `${alert.ticker} is now $${quote.price.toFixed(2)} ` +
          `(${quote.changePercent > 0 ? '+' : ''}${quote.changePercent.toFixed(2)}% today).\n\n` +
          `This alert was set to notify you when it ${describeAlert(alert)}.`,
      }),
    });
    console.log(`Sent alert email for ${alert.ticker} to ${alert.user_email}.`);
  } catch (err) {
    console.log('Failed to send alert email:', err.message);
  }
}

// Checks every active alert across ALL users for one ticker —
// joined to users so we know each alert's owner's email address.
async function checkAlertsForTicker(ticker, quote) {
  const { rows: activeAlerts } = await pool.query(
    `SELECT alerts.*, users.email AS user_email
     FROM alerts
     JOIN users ON users.id = alerts.user_id
     WHERE alerts.ticker = $1 AND alerts.active = true`,
    [ticker]
  );

  for (const alert of activeAlerts) {
    if (!alertConditionMet(alert, quote)) continue;

    const isOneTime = alert.condition_type === 'price_above' || alert.condition_type === 'price_below';

    if (isOneTime) {
      await sendAlertEmail(alert, quote);
      await pool.query('UPDATE alerts SET active = false, last_triggered_at = NOW() WHERE id = $1', [alert.id]);
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

// Snapshots every DISTINCT ticker across ALL users' watchlists —
// one Finnhub call per ticker serves everyone tracking it, whether
// that's 1 person or 50.
async function runScheduledChecks() {
  if (!dbReady) return;

  if (process.env.FINNHUB_API_KEY) {
    try {
      const { rows: tickerRows } = await pool.query('SELECT DISTINCT ticker FROM watchlist');
      for (const row of tickerRows) {
        const ticker = row.ticker;
        const quote = await fetchQuote(ticker);
        if (!quote.error) {
          await pool.query('INSERT INTO price_history (ticker, price) VALUES ($1, $2)', [ticker, quote.price]);
          await checkAlertsForTicker(ticker, quote);
        }
      }
      console.log(`Checked ${tickerRows.length} distinct ticker(s) across all users.`);
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
// SEARCH — doesn't touch user data, so no auth needed here.
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
// STARTUP
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stock tracker running on port ${PORT}`);
});

initDb();

setTimeout(runScheduledChecks, 8000);
setInterval(runScheduledChecks, SNAPSHOT_INTERVAL_MS);
