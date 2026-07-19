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
const webpush = require('web-push');

// Web Push: configure VAPID keys for browser push notifications.
// If the keys aren't set yet, push features just silently skip.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:alerts@tradetrack.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
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

// PWA icons served from embedded data (before static middleware so
// these take priority over any files in public/)
const ICON_192 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAADFUlEQVR4nO3cQU7bUBRA0VB1D2ygU8QmGKOOugHWxQY6qtgK0y6mg0gdgED4XyAv5py5E0v/6iW2v3xxeXN9gFXfTn0CnDcBkQiIREAkAiIREImASAREIiASAZEIiERAJN/j8Q93V+9yHpzQ7f3j8rEXy0/jpbMzaxktBvS/nhIvQ5TV3ByQdPZqbWUX/0SrZ3/W1nRbQMdI1bNXx5Xd9O92Q0Dq+Qq2NuQ+EMlbAzJ+vo5NQ8gEIhEQiYBIBEQiIJL6NJ6P8OQKaPLFrwk0zvPr58kbHwQ0y0utjG1IQIO8XsnMhgREIiASAZEIiERAg7x+v2fm3SABzfJSJTPrOQhooOetjK3n4FHGTJOLecIEIhEQiYBIBEQiIBIBkQiIREAkAiJxJ/r01rYaDrlbbQKd2PJG1SE7XAVEIiASAZEIiERAJAIiERCJgEgERCIgEgGRCIhEQCQCIhEQiYBIBEQiIBIBkdhUv83f338Wjvrx6+c7n8cYJtAGa/WUA+cTEImASAREIiASAZEIiERAJAIiERCJgEgERCIgEgGRCIhEQCQCItnzjkS7Bz/BbieQ3YOfY7cB8TkERCIgEgGRCIhEQCQCIhEQiYBIBEQiIBIBkQiIREAkAiKZsqHM5q8zNWIC2fx1vkYExPkSEImASAREIiASAZEIiERAJAIiERCJgEgERCIgEgGRCIhEQCQCIhEQiYBIBEQiIBIBkQiIREAkAiIREImASAREIiASAZEIiERAJAIiERDJiICWX3X4yoHn8pm3949rn7l84Pua8pLNj3hd5rl85pAU1oyYQJwvAZEIiERAJAIiERCJgEgERCIgEgGRCIhEQCQCIhEQiYBIBEQiIBIBkQiIREAkAiIREImASAREIiASAZEIiERAJAIiERDJWwM6voLk4e7qI0+GEY6r/MaXzphAJBsCMoS+gk3j57B1Amlo37bWc1j+CdPQ/qyt6cXlzXX5srN+vx9HZTUXAzoYQruzNgvWAzqS0Q6Un5EaEF+c+0AkAiIREImASAREIiASAZEIiERAJAIiERDJP48EjLPegtlzAAAAAElFTkSuQmCC', 'base64');
const ICON_512 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAKbUlEQVR4nO3dMW5TWRiGYTPKHtgALWIT1IiKDbAuNkCF2Aoti5kiUYRmiGMn9j3/9fs87Yzg+Bbf62OL5M3bjx8OAPT8s/oAAKwhAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUXerD/ASP7++X30EgP/69O3X6iOc583bjx9Wn+EkRh/YkV3EYAcBMP3ATg3PwNwA2H3gZswswdAvga0/cEtmbtq4G8DMxwRwEaOuArNuANYfuG2jVm7QDeCs5zKqogB7XLApATjl2Q15ZADH7WXQRgTg2Yc14UkBnGX+sq0PwPFntPwBAbzG5Ilb/CXw5EcD8HrHd2ztd8IrbwBHXrnpB27MwMVbdgMY+CwArufIsq26B8z6dwAH6w/crmn7tiYAT+Vu2tMBuKynVm7JJWBBAEb9QziAIbbfxkEfAXn7DxTM2bopAZjzRACubcjibR0An/8APGXjhRxxAxgSQ4DNTNi9TQPg7T/AcVvu5PobwIQMAmxv+fqtDwAASwgAQNR2AfAFAMApNlvLxTeA5R+BASyU/n0AAKwiAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUXerDwDcgr/++Bo/62U4AQBe7viPLXv8r0owkwAAL3HWT6y8/59lYBrfAQBne9nPK/Yz4acRAOA8r9lxDRhFAIAzvH7BNWAOAQBOdant1oAhBAA4yWVXWwMmEACAKAEAnneNN+wuAcsJAECUAABECQDwjOt9VuNToLUEACBKAACiBAAgSgAAogQAIEoAAKIEAHjG9X6Ri18Rs5YAAEQJAECUAADPu8ZnNT7/WU4AAKIEADjJZd+we/s/gQAAp7rUalv/IQQAOMPrt9v6zyEAwHles+DWfxQBAM72sh23/tPcrT4AsEv3a37ib3Qx/TMJAPByj8v+1xLY/eEEALgAW79HvgMAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAqLvVBwAG+fn1/eojPPj07dfqI9w+NwDgwZz1Pww7zK0SAOBwGDm4A490YwQAmDu1Yw92GwQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACi7lYfAHbj9/cfq4/w4N2Xz6uPwC1wA4CTzFn/w7DDsF8CAM8bOLgDj8TuCAA8Y+zUjj0YeyEAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAEHW3+gDciN/ff6w+woN3Xz6vPgLsgxsAFzBn/Q/DDgOTCQCvNXBwBx4JBhIAXmXs1I49GMwhAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABAlAABRAgAQJQAAUQIAECUAAFECABB1t/oICb+//1h9hAfvvnxefQRgCjeAq5uz/odhhwHWEoDrGji4A48ELCEAVzR2asceDNiSAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECcAVvfvyefUR/u6CB/MaF7rgwT59+3WpP+qyxh7sNgjAdQ3cjosfyWtc4uJHGji1A490YwTg6kZtx5UO4zVu7EqHGTW4ow5zq+5WHyBh1HZcidd4G8xuihsAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBA1OIA/Pz6fu0BABZau4HbBeDTt1+b/V0A+7XZWvoICCBKAACi1gfA1wBA0/L12zQAvgYAOG7LnVx/AzgMyCDAxibs3tYBcAkAeMrGCzniBnCYEUOAbQxZvCkBOIx5IgBXNWfrFgTAp0AA/7f9Nq65ATz1OueEEeAanlq5Je+MB30EdE8DgFs1bd+WBeBI7qY9I4DXO7Jsqz4Yf/P244clf/G941vv2wLgBowdusUfAR1/5a4CwN6NXf/D8hvAvWeH3lUA2J35yzYiAIfT3uwvf1gAp9jLoE0JwOHMD3wmPDuAR3tcsEEBOPjQHwgYsv6H5V8C/8ec5wJwDaNWbtYN4JGrAHBjRk3/vVk3gEcDnxTAi83ctKE3gD+5DQA7NXP3H+0gAPdkANiR4dN/bzcB+JMYAAPtYvT/tMsAAPB6Q78EBuDaBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAov4FjsNntiXcJvkAAAAASUVORK5CYII=', 'base64');

app.get('/logo-192.png', (req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(ICON_192);
});

app.get('/logo-512.png', (req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(ICON_512);
});

// Serve static files AFTER session middleware and icon routes.
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

      // Push notification subscriptions
      await pool.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          endpoint TEXT NOT NULL,
          keys_p256dh TEXT NOT NULL,
          keys_auth TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, endpoint)
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
    'SELECT ticker, name, logo, sort_order FROM watchlist WHERE user_id = $1 ORDER BY ticker ASC',
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
      await sendPushToUser(alert.user_id, `${alert.ticker} Alert`, `${alert.ticker} is at $${quote.price.toFixed(2)} (${alertDescription(alert)})`);
      await pool.query('UPDATE alerts SET active = false, last_triggered_at = NOW() WHERE id = $1', [alert.id]);
    } else {
      const cooledDown = !alert.last_triggered_at ||
        (Date.now() - new Date(alert.last_triggered_at).getTime()) > ALERT_COOLDOWN_MS;
      if (cooledDown) {
        await sendAlertEmail(alert, quote);
        await sendPushToUser(alert.user_id, `${alert.ticker} Alert`, `${alert.ticker} is at $${quote.price.toFixed(2)} (${alertDescription(alert)})`);
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

// International market ETFs for global market overview
const INTL_ETFS = [
  { ticker: 'EWJ', name: 'Japan (Nikkei)' },
  { ticker: 'EWG', name: 'Germany (DAX)' },
  { ticker: 'EWU', name: 'United Kingdom (FTSE)' },
  { ticker: 'FXI', name: 'China (Large Cap)' },
  { ticker: 'EWY', name: 'South Korea (KOSPI)' },
  { ticker: 'EWA', name: 'Australia (ASX)' },
  { ticker: 'EWC', name: 'Canada (TSX)' },
  { ticker: 'EWZ', name: 'Brazil (Bovespa)' },
  { ticker: 'INDA', name: 'India (Nifty)' },
  { ticker: 'EWT', name: 'Taiwan (TWSE)' },
];

app.get('/api/markets/international', requireAuth, async (req, res) => {
  if (!process.env.FINNHUB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FINNHUB_API_KEY' });
  }

  const cached = newsCacheGet('intl-markets');
  if (cached) return res.json({ markets: cached });

  try {
    const results = [];
    for (const etf of INTL_ETFS) {
      const quote = await fetchQuote(etf.ticker);
      results.push({
        ticker: etf.ticker,
        name: etf.name,
        price: quote.price,
        changePercent: quote.changePercent,
        error: quote.error || null,
      });
    }
    newsCacheSet('intl-markets', results);
    res.json({ markets: results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load international data' });
  }
});

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
  {
    name: 'get_financials',
    description: 'Get detailed financial metrics for a company: PE ratio, EPS, revenue, profit margins, cash per share, debt/equity, dividend yield, beta, 52-week range, and more. Use when the user asks about fundamentals, valuation, financials, DCF, or whether a stock is overvalued/undervalued. The AI should use these numbers to provide analysis.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_chart_data',
    description: 'Get price history data points for a stock to display as an inline chart in the chat. Use when the user asks to see a chart, graph, price history, or trend visualization. Returns data that will be rendered as a visual chart in the chat. Always use this when the user says "show me a chart" or "graph" or "price history."',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'set_alert',
    description: 'Set a price alert for a stock. Use when the user says things like "alert me if X drops below $200" or "notify me when TSLA hits $300." Condition types: price_below, price_above, drops_pct, rises_pct.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        condition: { type: 'string', enum: ['price_below', 'price_above', 'drops_pct', 'rises_pct'], description: 'Alert condition type' },
        threshold: { type: 'number', description: 'Threshold value (dollar amount for price alerts, percentage for pct alerts)' },
      },
      required: ['ticker', 'condition', 'threshold'],
    },
  },
  {
    name: 'place_trade',
    description: 'Place a paper trade (buy or sell) for a stock. This uses paper trading with fake money for practice. Use when the user says "buy 10 shares of AAPL" or "sell my Tesla" or "trade NVDA." Always confirm the order details before placing.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol' },
        qty: { type: 'number', description: 'Number of shares' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Buy or sell' },
      },
      required: ['ticker', 'qty', 'side'],
    },
  },
  {
    name: 'get_positions',
    description: 'Get the user\'s current paper trading portfolio positions showing what they own, cost basis, current value, and profit/loss. Use when they ask about their positions, portfolio, holdings, or "what do I own."',
    input_schema: {
      type: 'object',
      properties: {},
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
    case 'get_financials': {
      if (!process.env.FINNHUB_API_KEY) return { error: 'No API key configured' };
      try {
        const [metricRes, profileRes] = await Promise.all([
          fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${process.env.FINNHUB_API_KEY}`).then(r => r.json()),
          fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`).then(r => r.json()),
        ]);
        const m = metricRes.metric || {};
        const p = profileRes || {};
        const data = {
          company: p.name || ticker,
          industry: p.finnhubIndustry || 'N/A',
          marketCap: p.marketCapitalization ? `$${(p.marketCapitalization / 1e3).toFixed(1)}B` : 'N/A',
          peRatio: m.peNormalizedAnnual || m.peTTM || 'N/A',
          epsAnnual: m.epsNormalizedAnnual || m.epsTTM || 'N/A',
          revenuePerShare: m.revenuePerShareAnnual || 'N/A',
          profitMargin: m.netProfitMarginTTM ? `${m.netProfitMarginTTM.toFixed(1)}%` : 'N/A',
          grossMargin: m.grossMarginTTM ? `${m.grossMarginTTM.toFixed(1)}%` : 'N/A',
          operatingMargin: m.operatingMarginTTM ? `${m.operatingMarginTTM.toFixed(1)}%` : 'N/A',
          roe: m.roeTTM ? `${m.roeTTM.toFixed(1)}%` : 'N/A',
          roa: m.roaTTM ? `${m.roaTTM.toFixed(1)}%` : 'N/A',
          debtToEquity: m.totalDebtToEquityQuarterly || 'N/A',
          currentRatio: m.currentRatioQuarterly || 'N/A',
          cashPerShare: m.cashPerSharePerShareQuarterly || 'N/A',
          dividendYield: m.dividendYieldIndicatedAnnual ? `${m.dividendYieldIndicatedAnnual.toFixed(2)}%` : 'N/A',
          beta: m.beta || 'N/A',
          weekHigh52: m['52WeekHigh'] ? `$${m['52WeekHigh'].toFixed(2)}` : 'N/A',
          weekLow52: m['52WeekLow'] ? `$${m['52WeekLow'].toFixed(2)}` : 'N/A',
          avgVolume10d: m['10DayAverageTradingVolume'] ? `${m['10DayAverageTradingVolume'].toFixed(1)}M` : 'N/A',
          revenueGrowth3y: m.revenueGrowth3Y ? `${m.revenueGrowth3Y.toFixed(1)}%` : 'N/A',
          epsGrowth3y: m.epsGrowth3Y ? `${m.epsGrowth3Y.toFixed(1)}%` : 'N/A',
          freeCashFlowPerShare: m.fcfPerShareTTM || 'N/A',
        };
        return { result: JSON.stringify(data) };
      } catch (err) {
        return { error: `Could not fetch financials for ${ticker}` };
      }
    }
    case 'get_chart_data': {
      try {
        const { rows } = await pool.query(
          'SELECT price, recorded_at FROM price_history WHERE ticker = $1 ORDER BY recorded_at ASC',
          [ticker]
        );
        if (rows.length === 0) {
          return { result: JSON.stringify({ ticker, points: [], message: 'No price history available yet. The stock may need to be added to the watchlist first so the server starts collecting snapshots.' }) };
        }
        const points = rows.map(r => ({ price: parseFloat(r.price), time: r.recorded_at }));
        const prices = points.map(p => p.price);
        return {
          result: JSON.stringify({
            ticker,
            points: points.length,
            first: points[0],
            last: points[points.length - 1],
            min: Math.min(...prices).toFixed(2),
            max: Math.max(...prices).toFixed(2),
            chartData: points.map(p => p.price),
          }),
          _chartRender: {
            ticker,
            prices: points.map(p => p.price),
            startDate: points[0].time,
            endDate: points[points.length - 1].time,
          }
        };
      } catch (err) {
        return { error: `Could not fetch chart data for ${ticker}` };
      }
    }
    case 'set_alert': {
      const condition = input.condition || '';
      const threshold = input.threshold;
      if (!condition || threshold == null) return { error: 'Missing condition or threshold' };
      const validConditions = ['price_below', 'price_above', 'drops_pct', 'rises_pct'];
      if (!validConditions.includes(condition)) return { error: `Invalid condition. Use: ${validConditions.join(', ')}` };
      try {
        await pool.query(
          'INSERT INTO alerts (ticker, condition_type, threshold, user_id) VALUES ($1, $2, $3, $4)',
          [ticker, condition, threshold, userId]
        );
        const labels = { price_below: 'drops below $', price_above: 'goes above $', drops_pct: 'drops by ', rises_pct: 'rises by ' };
        const suffix = condition.includes('pct') ? '%' : '';
        return { result: `Alert set: you'll be notified when ${ticker} ${labels[condition]}${threshold}${suffix}.` };
      } catch (err) {
        return { error: `Could not set alert: ${err.message}` };
      }
    }
    case 'place_trade': {
      if (!tradingEnabled()) return { error: 'Paper trading is not configured yet.' };
      const qty = input.qty;
      const side = input.side;
      if (!qty || !side) return { error: 'Missing quantity or side (buy/sell)' };
      try {
        const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: 'POST',
          headers: alpacaHeaders(),
          body: JSON.stringify({
            symbol: ticker,
            qty: String(qty),
            side,
            type: 'market',
            time_in_force: 'day',
          }),
        });
        const data = await r.json();
        if (!r.ok) return { error: data.message || 'Order rejected by broker' };
        logActivity(userId, 'trade', `${side} ${qty} ${ticker}`);
        return { result: `Order placed: ${side} ${qty} shares of ${ticker}. Order status: ${data.status}. This is paper trading (practice money).` };
      } catch (err) {
        return { error: 'Could not reach the trading service' };
      }
    }
    case 'get_positions': {
      if (!tradingEnabled()) return { error: 'Paper trading is not configured yet.' };
      try {
        const [posRes, acctRes] = await Promise.all([
          fetch(`${ALPACA_BASE}/v2/positions`, { headers: alpacaHeaders() }),
          fetch(`${ALPACA_BASE}/v2/account`, { headers: alpacaHeaders() }),
        ]);
        const positions = await posRes.json();
        const account = await acctRes.json();
        if (!posRes.ok) return { error: 'Could not fetch positions' };
        const posText = Array.isArray(positions) && positions.length > 0
          ? positions.map(p => `${p.symbol}: ${p.qty} shares, avg entry $${parseFloat(p.avg_entry_price).toFixed(2)}, current $${parseFloat(p.current_price).toFixed(2)}, P/L $${parseFloat(p.unrealized_pl).toFixed(2)} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%)`).join('\n')
          : 'No open positions.';
        return { result: `Account equity: $${parseFloat(account.equity).toFixed(2)}, buying power: $${parseFloat(account.buying_power).toFixed(2)}, cash: $${parseFloat(account.cash).toFixed(2)}\n\nPositions:\n${posText}\n\n(Paper trading account, practice money)` };
      } catch (err) {
        return { error: 'Could not reach the trading service' };
      }
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

    const systemPrompt = `You are Trackr, the AI built into Trade Track. You're sharp, direct, and you know markets. Think of yourself as the smart friend who actually works in finance: you don't hedge every sentence, you give real takes, and you back them up with numbers. You're not a chatbot pretending to know about stocks. You have live data.

User: ${userName}

${watchlistContext}${alertsContext}

Your tools:
- add_to_watchlist / remove_from_watchlist: manage their watchlist when asked
- get_stock_quote: pull live price for any ticker (use this before answering about stocks not in the watchlist above)
- get_financials: pull PE, EPS, margins, cash flow, growth rates, etc. Use for valuation questions, "is X overvalued," DCF requests, or fundamental analysis
- get_chart_data: pull price history to render a visual chart in the chat. Use when they want to see a chart or trend
- set_alert: create price alerts. Understand natural language like "tell me if AAPL drops below 200"
- place_trade: place a paper trade (buy or sell shares). This is practice trading with fake money. When the user says "buy 10 shares of NVDA," use this tool. Always state the order details before placing.
- get_positions: show the user's paper trading portfolio, positions, P/L, and account balance. Use when they ask "what do I own" or "show my positions" or "how's my portfolio doing" (in the trading sense, not watchlist sense)

How to behave:
- Lead with the answer, not the caveats. If they ask "how's my portfolio," start with the verdict, then the breakdown.
- Use numbers. Don't say "the stock is doing well." Say "up 4% today, trading near its 52-week high."
- When pulling financials for valuation, walk through the logic: what the PE tells you, how margins compare, what growth looks like. Make it educational.
- Keep it tight. 2-3 short paragraphs max unless they're asking for deep analysis.
- Never use em dashes. Use periods or commas instead.
- Use their name occasionally but not every message.
- If you don't know something, say so. Don't make up numbers.
- End investment-related answers with one brief line noting you're an AI, not a financial advisor. Keep it casual, not legalistic.`;

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
    let charts = [];
    while (data.stop_reason === 'tool_use' && rounds < 3) {
      rounds++;
      const toolBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolBlocks) {
        const result = await executeChatTool(block.name, block.input, req.session.userId);
        // If tool returned chart data, capture it for the frontend
        if (result._chartRender) {
          charts.push(result._chartRender);
        }
        // Send the text result to the AI (strip internal fields)
        const forAI = { result: result.result, error: result.error };
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(forAI),
        });
      }

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

    const reply = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const watchlistChanged = rounds > 0;

    logActivity(req.session.userId, 'chat', trimmed[trimmed.length - 1].content.slice(0, 100));
    res.json({ reply, watchlistChanged, charts });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// ------------------------------------------------------------
// PUSH NOTIFICATIONS - subscribe/unsubscribe and VAPID public key
// ------------------------------------------------------------
app.get('/api/push/vapid-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(500).json({ error: 'Push notifications not configured' });
  }
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription data' });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET keys_p256dh = $3, keys_auth = $4`,
      [req.session.userId, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  if (!requireDb(res)) return;
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'No endpoint' });
  try {
    await pool.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.session.userId, endpoint]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Send push notification to all of a user's subscriptions.
// Called from the scheduled alert job.
async function sendPushToUser(userId, title, body) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const { rows: subs } = await pool.query(
      'SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const payload = JSON.stringify({ title, body });
    for (const sub of subs) {
      const pushSub = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
      };
      try {
        await webpush.sendNotification(pushSub, payload);
      } catch (err) {
        // If the subscription is expired/invalid (410 Gone), remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
        }
      }
    }
  } catch (err) {}
}

// ------------------------------------------------------------
// TRADING — Alpaca paper trading integration. All requests proxy
// through our server so the user's browser never sees the Alpaca
// API keys. Paper trading uses fake money, no risk.
// ------------------------------------------------------------
const ALPACA_BASE = 'https://paper-api.alpaca.markets';

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY || '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET || '',
    'Content-Type': 'application/json',
  };
}

function tradingEnabled() {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
}

// Check if trading is configured
app.get('/api/trading/status', requireAuth, (req, res) => {
  res.json({ enabled: tradingEnabled() });
});

// Referral URLs (read from environment variables)
app.get('/api/referral-urls', requireAuth, (req, res) => {
  res.json({
    robinhood: process.env.ROBINHOOD_REFERRAL_URL || null,
    webull: process.env.WEBULL_REFERRAL_URL || null,
  });
});

// Account info: buying power, equity, cash
app.get('/api/trading/account', requireAuth, async (req, res) => {
  if (!tradingEnabled()) return res.status(500).json({ error: 'Trading not configured' });
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/account`, { headers: alpacaHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Alpaca error' });
    res.json({
      buyingPower: parseFloat(data.buying_power),
      cash: parseFloat(data.cash),
      equity: parseFloat(data.equity),
      portfolioValue: parseFloat(data.portfolio_value),
      patternDayTrader: data.pattern_day_trader,
      tradingBlocked: data.trading_blocked,
      accountStatus: data.status,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Alpaca' });
  }
});

// Current positions
app.get('/api/trading/positions', requireAuth, async (req, res) => {
  if (!tradingEnabled()) return res.status(500).json({ error: 'Trading not configured' });
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: alpacaHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Alpaca error' });
    res.json({
      positions: data.map(p => ({
        ticker: p.symbol,
        qty: parseFloat(p.qty),
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue: parseFloat(p.market_value),
        unrealizedPL: parseFloat(p.unrealized_pl),
        unrealizedPLPct: parseFloat(p.unrealized_plpc) * 100,
        side: p.side,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Alpaca' });
  }
});

// Place an order
app.post('/api/trading/orders', requireAuth, async (req, res) => {
  if (!tradingEnabled()) return res.status(500).json({ error: 'Trading not configured' });
  const { ticker, qty, side, type, limitPrice } = req.body;
  if (!ticker || !qty || !side) {
    return res.status(400).json({ error: 'Missing ticker, qty, or side' });
  }
  if (!['buy', 'sell'].includes(side)) {
    return res.status(400).json({ error: 'Side must be buy or sell' });
  }

  const order = {
    symbol: ticker.toUpperCase(),
    qty: String(qty),
    side,
    type: type || 'market',
    time_in_force: 'day',
  };
  if (type === 'limit' && limitPrice) {
    order.limit_price = String(limitPrice);
  }

  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders`, {
      method: 'POST',
      headers: alpacaHeaders(),
      body: JSON.stringify(order),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Order rejected' });

    logActivity(req.session.userId, 'trade', `${side} ${qty} ${ticker.toUpperCase()}`);

    res.json({
      orderId: data.id,
      ticker: data.symbol,
      side: data.side,
      qty: data.qty,
      type: data.type,
      status: data.status,
      filledAt: data.filled_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Alpaca' });
  }
});

// Recent orders
app.get('/api/trading/orders', requireAuth, async (req, res) => {
  if (!tradingEnabled()) return res.status(500).json({ error: 'Trading not configured' });
  try {
    const r = await fetch(`${ALPACA_BASE}/v2/orders?status=all&limit=20&direction=desc`, { headers: alpacaHeaders() });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Alpaca error' });
    res.json({
      orders: data.map(o => ({
        id: o.id,
        ticker: o.symbol,
        side: o.side,
        qty: o.qty,
        type: o.type,
        status: o.status,
        filledQty: o.filled_qty,
        filledAvgPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
        submittedAt: o.submitted_at,
        filledAt: o.filled_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Alpaca' });
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
