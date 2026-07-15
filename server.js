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
    res.status(503).json({ error: 'Database is still starting up. Try again in a few seconds.' });
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
    httpOnly: true,                     // JavaScript can't read this cookie. Blocks a common attack
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

// Lightweight activity logger. Fire-and-forget (doesn't block the
// response). Logs are capped by a cleanup job so they don't grow
// forever.
function logActivity(userId, action, detail) {
  if (!dbReady || !pool) return;
  pool.query(
    'INSERT INTO activity_log (user_id, action, detail) VALUES ($1, $2, $3)',
    [userId, action, detail || null]
  ).catch(() => {});
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

      // MIGRATION: give users a display name for greetings.
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`);

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

      // Saved articles — bookmarked news items, per user.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS saved_articles (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          url TEXT NOT NULL,
          headline TEXT NOT NULL,
          source TEXT,
          datetime BIGINT,
          saved_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, url)
        )
      `);

      // Activity log for admin analytics
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER,
          action TEXT NOT NULL,
          detail TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_time
        ON activity_log (created_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_log_user
        ON activity_log (user_id, created_at DESC)
      `);

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
  const name = (req.body.name || '').trim() || null;

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, name]
    );
    const userId = rows[0].id;

    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM users');
    const isFirstUserEver = parseInt(countRows[0].count, 10) === 1;

    if (isFirstUserEver) {
      await pool.query('UPDATE watchlist SET user_id = $1 WHERE user_id IS NULL', [userId]);
      await pool.query('UPDATE alerts SET user_id = $1 WHERE user_id IS NULL', [userId]);
    } else {
      await pool.query(
        `INSERT INTO watchlist (ticker, sort_order, user_id) VALUES ($1, 0, $3), ($2, 1, $3)`,
        ['AAPL', 'NVDA', userId]
      );
    }

    req.session.userId = userId;
    req.session.userEmail = email;
    req.session.userName = name;
    logActivity(userId, 'signup');
    res.json({ email, name });
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
    const { rows } = await pool.query('SELECT id, password_hash, name FROM users WHERE email = $1', [email]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = rows[0].id;
    req.session.userEmail = email;
    req.session.userName = rows[0].name || null;
    logActivity(rows[0].id, 'login');
    res.json({ email, name: rows[0].name || null });
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
    const { rows } = await pool.query('SELECT name, created_at FROM users WHERE id = $1', [req.session.userId]);
    res.json({
      email: req.session.userEmail,
      name: rows[0] ? rows[0].name : null,
      createdAt: rows[0] ? rows[0].created_at : null,
    });
  } catch (err) {
    res.json({ email: req.session.userEmail, name: req.session.userName || null, createdAt: null });
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
      // 400, not 401 — the person IS validly logged in here (that's
      // what requireAuth already confirmed); they just got one field
      // wrong. Using 401 would make this indistinguishable from "your
      // session expired," which is about to matter: the frontend is
      // going to treat any 401 from a protected route as "bounce back
      // to login." We don't want a wrong-password typo doing that.
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ROUTE: POST /api/auth/change-name
// Updates the display name shown in greetings and settings.
// ------------------------------------------------------------
app.post('/api/auth/change-name', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;

  const name = (req.body.name || '').trim();
  if (!name || name.length > 50) {
    return res.status(400).json({ error: 'Name must be between 1 and 50 characters' });
  }

  try {
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name, req.session.userId]);
    req.session.userName = name;
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// ADMIN API — only accessible to user_id = 1. Powers the admin
// dashboard with user stats, usage metrics, and activity logs.
// ------------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!req.session || req.session.userId !== 1) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// Overview stats
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows: userCount } = await pool.query('SELECT COUNT(*) FROM users');
    const { rows: tickerCount } = await pool.query('SELECT COUNT(DISTINCT ticker) FROM watchlist');
    const { rows: alertCount } = await pool.query('SELECT COUNT(*) FROM alerts');
    const { rows: savedCount } = await pool.query('SELECT COUNT(*) FROM saved_articles');

    // Signups per day (last 30 days)
    const { rows: signupTrend } = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    // Users list
    const { rows: users } = await pool.query(
      'SELECT id, email, name, created_at FROM users ORDER BY created_at DESC LIMIT 50'
    );

    // Per-user watchlist counts
    const { rows: userWatchlists } = await pool.query(`
      SELECT u.id, u.email, u.name, COUNT(w.id) AS stock_count
      FROM users u LEFT JOIN watchlist w ON u.id = w.user_id
      GROUP BY u.id, u.email, u.name
      ORDER BY stock_count DESC
    `);

    res.json({
      totalUsers: parseInt(userCount[0].count, 10),
      totalTickers: parseInt(tickerCount[0].count, 10),
      totalAlerts: parseInt(alertCount[0].count, 10),
      totalSavedArticles: parseInt(savedCount[0].count, 10),
      signupTrend: signupTrend.map(r => ({ day: r.day, count: parseInt(r.count, 10) })),
      users: users.map(u => ({ id: u.id, email: u.email, name: u.name, joinedAt: u.created_at })),
      userWatchlists: userWatchlists.map(u => ({
        id: u.id, email: u.email, name: u.name,
        stockCount: parseInt(u.stock_count, 10),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Usage metrics
app.get('/api/admin/usage', requireAuth, requireAdmin, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    // Action counts (last 7 days)
    const { rows: actionCounts } = await pool.query(`
      SELECT action, COUNT(*) AS count
      FROM activity_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY action
      ORDER BY count DESC
    `);

    // Daily active users (last 14 days)
    const { rows: dailyActive } = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(DISTINCT user_id) AS users
      FROM activity_log
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    // Most tracked stocks across all users
    const { rows: popularStocks } = await pool.query(`
      SELECT ticker, COUNT(DISTINCT user_id) AS user_count
      FROM watchlist
      GROUP BY ticker
      ORDER BY user_count DESC
      LIMIT 20
    `);

    // Chat usage (last 7 days)
    const { rows: chatUsage } = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS messages
      FROM activity_log
      WHERE action = 'chat' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY day
    `);

    res.json({
      actionCounts: actionCounts.map(r => ({ action: r.action, count: parseInt(r.count, 10) })),
      dailyActive: dailyActive.map(r => ({ day: r.day, users: parseInt(r.users, 10) })),
      popularStocks: popularStocks.map(r => ({ ticker: r.ticker, userCount: parseInt(r.user_count, 10) })),
      chatUsage: chatUsage.map(r => ({ day: r.day, messages: parseInt(r.messages, 10) })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Activity log (paginated)
app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res) => {
  if (!requireDb(res)) return;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const userFilter = req.query.user_id ? parseInt(req.query.user_id) : null;
  const actionFilter = req.query.action || null;

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (userFilter) { params.push(userFilter); where += ` AND user_id = $${params.length}`; }
    if (actionFilter) { params.push(actionFilter); where += ` AND action = $${params.length}`; }

    params.push(limit);
    params.push(offset);

    const { rows } = await pool.query(`
      SELECT al.id, al.user_id, u.email, al.action, al.detail, al.created_at
      FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const { rows: total } = await pool.query(
      `SELECT COUNT(*) FROM activity_log ${where}`,
      params.slice(0, -2)
    );

    res.json({
      logs: rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        email: r.email,
        action: r.action,
        detail: r.detail,
        time: r.created_at,
      })),
      total: parseInt(total[0].count, 10),
      limit,
      offset,
    });
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

  // Immediately snapshot the price so the sparkline has data right
  // away instead of showing "collecting data — check back soon".
  try {
    const quote = await fetchQuote(raw);
    if (quote.price) {
      await pool.query(
        'INSERT INTO price_history (ticker, price) VALUES ($1, $2)',
        [raw, quote.price]
      );
    }
  } catch (err) {} // non-critical, the background job will catch it

  logActivity(userId, 'add_stock', raw);
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
        from: 'Trade Track <onboarding@resend.dev>',
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

// ------------------------------------------------------------
// STOCK DETAIL — endpoints for the single-stock detail page.
// Each returns data for one ticker, so the page can load them
// independently and render progressively.
// ------------------------------------------------------------

// Extended profile: reuses the existing fetchCompanyProfile() but
// also grabs basic financials (52-week high/low, market cap) from
// Finnhub's /stock/metric endpoint (available on free tier).
app.get('/api/stock/:symbol/profile', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cacheKey = `profile:${symbol}`;
  const cached = newsCacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`;
    const metricUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${process.env.FINNHUB_API_KEY}`;

    const [profileRes, metricRes] = await Promise.all([
      fetch(profileUrl).then(r => r.json()).catch(() => ({})),
      fetch(metricUrl).then(r => r.json()).catch(() => ({})),
    ]);

    const m = metricRes.metric || {};
    const profile = {
      name: profileRes.name || symbol,
      logo: profileRes.logo || null,
      industry: profileRes.finnhubIndustry || null,
      exchange: profileRes.exchange || null,
      marketCap: profileRes.marketCapitalization || null,
      weburl: profileRes.weburl || null,
      ipo: profileRes.ipo || null,
      weekHigh52: m['52WeekHigh'] || null,
      weekLow52: m['52WeekLow'] || null,
      avgVolume: m['10DayAverageTradingVolume'] || null,
    };

    newsCacheSet(cacheKey, profile);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load company profile' });
  }
});

// Single-ticker quote — thin wrapper around the existing fetchQuote().
app.get('/api/stock/:symbol/quote', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }
  const quote = await fetchQuote(symbol);
  res.json(quote);
});

// Single-ticker news — same logic as the watchlist news route, but
// returns more articles (8 instead of 4) and covers a longer window.
app.get('/api/stock/:symbol/news', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cacheKey = `company:detail:${symbol}`;
  const cached = newsCacheGet(cacheKey);
  if (cached) return res.json({ articles: cached });

  try {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const to = fmt(new Date());
    const from = fmt(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000));
    const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    const articles = Array.isArray(data)
      ? data.filter(a => a.headline && a.url).slice(0, 8).map(mapArticle)
      : [];
    newsCacheSet(cacheKey, articles);
    res.json({ articles });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load company news' });
  }
});

// Single-ticker price history from our own snapshots table.
app.get('/api/stock/:symbol/history', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const symbol = req.params.symbol.toUpperCase();
  try {
    const { rows } = await pool.query(
      'SELECT price, recorded_at FROM price_history WHERE ticker = $1 ORDER BY recorded_at ASC',
      [symbol]
    );
    const points = rows.map(r => ({ price: parseFloat(r.price), recordedAt: r.recorded_at }));
    res.json({ points });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Analyst recommendations from Finnhub — returns the most recent
// month's buy/sell/hold/strongBuy/strongSell consensus. Cached
// because this data only changes monthly.
app.get('/api/stock/:symbol/recommendation', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cacheKey = `rec:${symbol}`;
  const cached = newsCacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      const empty = { available: false };
      newsCacheSet(cacheKey, empty);
      return res.json(empty);
    }

    // Most recent month's consensus
    const latest = data[0];
    const result = {
      available: true,
      period: latest.period,
      strongBuy: latest.strongBuy || 0,
      buy: latest.buy || 0,
      hold: latest.hold || 0,
      sell: latest.sell || 0,
      strongSell: latest.strongSell || 0,
    };

    newsCacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load recommendations' });
  }
});

// ------------------------------------------------------------
// NEWS — two Finnhub endpoints power the Articles page:
//   /news?category=general       → broad market headlines
//   /company-news?symbol=&from=&to= → headlines about ONE company
//
// Both routes cache their results in memory for a few minutes.
// Why: news barely changes minute-to-minute, but every page load
// would otherwise cost real Finnhub API calls — and the watchlist
// route makes one call PER TICKER. With, say, 8 tickers, five
// people refreshing the page a few times could burn through the
// free tier's 60-calls-per-minute limit for no benefit. A tiny
// { fetchedAt, data } map fixes that. (This cache lives in the
// server's memory, so a redeploy clears it — that's fine, it just
// refetches once.)
// ------------------------------------------------------------
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const newsCache = new Map();

function newsCacheGet(key) {
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < NEWS_CACHE_TTL_MS) return hit.data;
  return null;
}

function newsCacheSet(key, data) {
  newsCache.set(key, { fetchedAt: Date.now(), data });
}

// Finnhub returns a lot of fields we don't need — trim each article
// down to exactly what the frontend renders, so the response stays
// small and the frontend never depends on Finnhub's raw shape.
function mapArticle(a) {
  return {
    headline: a.headline,
    source: a.source || 'Unknown source',
    url: a.url,
    image: a.image || null,
    summary: a.summary || '',
    datetime: a.datetime,   // unix timestamp in seconds
  };
}

app.get('/api/news/market', requireAuth, async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cached = newsCacheGet('market');
  if (cached) return res.json({ articles: cached });

  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${process.env.FINNHUB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (!Array.isArray(data)) {
      return res.status(502).json({ error: 'Unexpected response from news provider' });
    }

    const articles = data
      .filter(a => a.headline && a.url)
      .slice(0, 18)
      .map(mapArticle);

    newsCacheSet('market', articles);
    res.json({ articles });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load market news' });
  }
});

// Company news for the logged-in user's own tickers, grouped by
// ticker: { news: { AAPL: [...], NVDA: [...] } }. Capped at the
// first 10 tickers (by the user's own sort order) — each ticker is
// its own Finnhub call, and an enormous watchlist shouldn't be able
// to fire off 50 API calls from one page load.
const COMPANY_NEWS_MAX_TICKERS = 10;
const COMPANY_NEWS_PER_TICKER = 4;
const COMPANY_NEWS_LOOKBACK_DAYS = 7;

app.get('/api/news/watchlist', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  try {
    const items = await getAllWatchlistItems(req.session.userId);
    const tickers = items.map(i => i.ticker).slice(0, COMPANY_NEWS_MAX_TICKERS);

    if (tickers.length === 0) {
      return res.json({ news: {} });
    }

    // Finnhub wants YYYY-MM-DD date bounds; look back one week.
    const fmt = (d) => d.toISOString().slice(0, 10);
    const to = fmt(new Date());
    const from = fmt(new Date(Date.now() - COMPANY_NEWS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

    const news = {};
    // Deliberately sequential (not Promise.all) — one call at a time
    // is gentler on the shared rate limit, and with caching most
    // loads won't reach Finnhub at all.
    for (const ticker of tickers) {
      const cacheKey = `company:${ticker}`;
      let articles = newsCacheGet(cacheKey);

      if (!articles) {
        try {
          const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${process.env.FINNHUB_API_KEY}`;
          const response = await fetch(url);
          const data = await response.json();
          articles = Array.isArray(data)
            ? data.filter(a => a.headline && a.url).slice(0, COMPANY_NEWS_PER_TICKER).map(mapArticle)
            : [];
          newsCacheSet(cacheKey, articles);
        } catch (err) {
          articles = [];   // one ticker failing shouldn't sink the whole page
        }
      }

      news[ticker] = articles;
    }

    res.json({ news });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load watchlist news' });
  }
});

// ------------------------------------------------------------
// SECTORS — fetch quotes for a fixed set of sector ETFs and
// return them sorted by daily performance. The free tier can
// quote ETFs just like regular stocks.
// ------------------------------------------------------------
const SECTOR_ETFS = [
  { ticker: 'XLK', name: 'Technology' },
  { ticker: 'XLF', name: 'Financials' },
  { ticker: 'XLE', name: 'Energy' },
  { ticker: 'XLV', name: 'Healthcare' },
  { ticker: 'XLY', name: 'Consumer Discretionary' },
  { ticker: 'XLP', name: 'Consumer Staples' },
  { ticker: 'XLI', name: 'Industrials' },
  { ticker: 'XLB', name: 'Materials' },
  { ticker: 'XLRE', name: 'Real Estate' },
  { ticker: 'XLU', name: 'Utilities' },
  { ticker: 'XLC', name: 'Communication' },
];

app.get('/api/sectors', requireAuth, async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cached = newsCacheGet('sectors');
  if (cached) return res.json({ sectors: cached });

  try {
    const results = [];
    for (const etf of SECTOR_ETFS) {
      const quote = await fetchQuote(etf.ticker);
      results.push({
        ticker: etf.ticker,
        name: etf.name,
        price: quote.price,
        changePercent: quote.changePercent,
        dayHigh: quote.dayHigh,
        dayLow: quote.dayLow,
        error: quote.error || null,
      });
    }
    newsCacheSet('sectors', results);
    res.json({ sectors: results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load sector data' });
  }
});

// ------------------------------------------------------------
// SAVED ARTICLES — bookmark/unbookmark news articles.
// ------------------------------------------------------------
app.get('/api/saved-articles', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT url, headline, source, datetime, saved_at FROM saved_articles WHERE user_id = $1 ORDER BY saved_at DESC',
      [req.session.userId]
    );
    res.json({ articles: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/saved-articles', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const { url, headline, source, datetime } = req.body;
  if (!url || !headline) {
    return res.status(400).json({ error: 'URL and headline are required' });
  }
  try {
    await pool.query(
      'INSERT INTO saved_articles (user_id, url, headline, source, datetime) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, url) DO NOTHING',
      [req.session.userId, url, headline, source || null, datetime || null]
    );
    logActivity(req.session.userId, 'save_article', url);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/saved-articles', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    await pool.query(
      'DELETE FROM saved_articles WHERE user_id = $1 AND url = $2',
      [req.session.userId, url]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ------------------------------------------------------------
// AI CHAT — the Trade Track assistant with TOOL USE.
// The AI can add/remove stocks from the watchlist, look up
// live quotes for any ticker, and answer questions with the
// user's real portfolio context.
// ------------------------------------------------------------
const CHAT_TOOLS = [
  {
    name: 'add_to_watchlist',
    description: 'Add a stock ticker to the user\'s watchlist. Use this when the user asks to add, track, or watch a stock. Always confirm what you added.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol, e.g. TSLA, AAPL' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'remove_from_watchlist',
    description: 'Remove a stock ticker from the user\'s watchlist. Use this when the user asks to remove, untrack, or stop watching a stock.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol to remove' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_stock_quote',
    description: 'Get a live price quote for any stock ticker, including ones NOT on the user\'s watchlist. Use this when the user asks about a stock\'s current price that isn\'t in the watchlist context, or when you need fresh data.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
      },
      required: ['ticker'],
    },
  },
];

async function executeChatTool(toolName, input, userId) {
  const ticker = (input.ticker || '').toUpperCase().trim();
  if (!ticker) return { error: 'No ticker provided' };

  switch (toolName) {
    case 'add_to_watchlist': {
      try {
        const existing = await getAllWatchlistItems(userId);
        if (existing.some(i => i.ticker === ticker)) {
          return { result: `${ticker} is already on the watchlist.` };
        }
        const { rows: maxRows } = await pool.query(
          'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM watchlist WHERE user_id = $1',
          [userId]
        );
        await pool.query(
          'INSERT INTO watchlist (ticker, sort_order, user_id) VALUES ($1, $2, $3)',
          [ticker, maxRows[0].next, userId]
        );
        // Immediate price snapshot for sparkline
        try {
          const q = await fetchQuote(ticker);
          if (q.price) await pool.query('INSERT INTO price_history (ticker, price) VALUES ($1, $2)', [ticker, q.price]);
        } catch (e) {}
        return { result: `${ticker} has been added to the watchlist.` };
      } catch (err) {
        return { error: `Could not add ${ticker}: ${err.message}` };
      }
    }
    case 'remove_from_watchlist': {
      try {
        const { rowCount } = await pool.query(
          'DELETE FROM watchlist WHERE ticker = $1 AND user_id = $2',
          [ticker, userId]
        );
        if (rowCount === 0) return { result: `${ticker} wasn't on the watchlist.` };
        return { result: `${ticker} has been removed from the watchlist.` };
      } catch (err) {
        return { error: `Could not remove ${ticker}: ${err.message}` };
      }
    }
    case 'get_stock_quote': {
      const quote = await fetchQuote(ticker);
      if (quote.error) return { error: `Could not get quote for ${ticker}` };
      return {
        result: `${ticker}: $${quote.price.toFixed(2)}, ${quote.changePercent > 0 ? '+' : ''}${quote.changePercent.toFixed(2)}% today, range $${quote.dayLow.toFixed(2)}-$${quote.dayHigh.toFixed(2)}, open $${quote.dayOpen.toFixed(2)}`
      };
    }
    default:
      return { error: 'Unknown tool' };
  }
}

app.post('/api/chat', requireAuth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI assistant is not configured. Add ANTHROPIC_API_KEY in Railway.' });
  }
  if (!requireDb(res)) return;

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  const trimmed = messages.slice(-20);

  try {
    // Gather user context
    const items = await getAllWatchlistItems(req.session.userId);
    const tickers = items.map(i => i.ticker);

    let watchlistContext = 'User has no stocks on their watchlist.';
    if (tickers.length > 0) {
      const quotes = await Promise.all(tickers.slice(0, 15).map(t => fetchQuote(t)));
      watchlistContext = 'User\'s watchlist (with live prices):\n' +
        quotes.map(q => {
          if (q.error) return `- ${q.ticker}: data unavailable`;
          const dir = q.changePercent > 0 ? '+' : '';
          return `- ${q.ticker}: $${q.price.toFixed(2)} (${dir}${q.changePercent.toFixed(2)}% today, range $${q.dayLow.toFixed(2)}-$${q.dayHigh.toFixed(2)})`;
        }).join('\n');
    }

    let alertsContext = '';
    try {
      const { rows: alerts } = await pool.query(
        'SELECT ticker, condition_type, threshold, fired FROM alerts WHERE user_id = $1',
        [req.session.userId]
      );
      if (alerts.length > 0) {
        alertsContext = '\n\nUser\'s active alerts:\n' +
          alerts.map(a => `- ${a.ticker}: ${a.condition_type} ${a.threshold}${a.fired ? ' (already fired)' : ''}`).join('\n');
      }
    } catch (err) {}

    const userName = req.session.userName || req.session.userEmail;

    const systemPrompt = `You are the Trade Track AI assistant, a knowledgeable, concise stock market companion built into a personal stock tracking app called Trade Track.

The user's name is ${userName}.

${watchlistContext}${alertsContext}

You have tools to take actions:
- add_to_watchlist: Add a stock to the user's watchlist. Use it when they say things like "add Tesla" or "track GOOGL" or "watch Microsoft".
- remove_from_watchlist: Remove a stock. Use when they say "remove TSLA" or "stop tracking Amazon".
- get_stock_quote: Look up the live price of ANY stock, even ones not on the watchlist. Use when they ask about a stock's price that isn't in the watchlist data above.

Guidelines:
- Be concise and direct. Short paragraphs, not walls of text.
- When using tools, always confirm the result to the user naturally.
- If the user asks to add/remove a stock, use the tool. Don't just tell them to do it manually.
- For questions about specific stocks, check if you have the data in the watchlist above. If not, use get_stock_quote to look it up before answering.
- Always include a brief disclaimer when giving anything that could be read as investment advice.
- Keep responses under 200 words unless the question clearly needs more depth.
- Use plain language. No jargon without explanation.`;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };

    // First API call — may return text or tool_use
    let apiMessages = [...trimmed];
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: apiMessages,
        tools: CHAT_TOOLS,
      }),
    });
    let data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(502).json({ error: 'AI service error. Try again in a moment.' });
    }

    // Handle tool use loop (up to 3 rounds to prevent runaway)
    let rounds = 0;
    while (data.stop_reason === 'tool_use' && rounds < 3) {
      rounds++;
      const toolBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolBlocks) {
        const result = await executeChatTool(block.name, block.input, req.session.userId);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // Send tool results back to get the final text response
      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults },
      ];

      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages: apiMessages,
          tools: CHAT_TOOLS,
        }),
      });
      data = await response.json();

      if (!response.ok) {
        console.error('Anthropic API error (tool round):', data);
        return res.status(502).json({ error: 'AI service error. Try again in a moment.' });
      }
    }

    // Extract final text
    const reply = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Tell the frontend if the watchlist was modified so it can refresh
    const watchlistChanged = data.content.some(b => b.type === 'tool_use') ||
      (rounds > 0);

    logActivity(req.session.userId, 'chat', trimmed[trimmed.length - 1].content.slice(0, 100));
    res.json({ reply, watchlistChanged });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
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
    message: 'Trade Track server is running',
    hasApiKey: Boolean(process.env.FINNHUB_API_KEY),
    hasDatabase,
  });
});

// ------------------------------------------------------------
// STARTUP
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Trade Track running on port ${PORT}`);
});

initDb();

setTimeout(runScheduledChecks, 8000);
setInterval(runScheduledChecks, SNAPSHOT_INTERVAL_MS);
