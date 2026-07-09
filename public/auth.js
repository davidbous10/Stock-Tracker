// ============================================================
// auth.js — shared login/session logic.
//
// Every page in this app (watchlist, home, settings, and future
// ones like sectors/articles) needs the SAME thing: check if
// someone's logged in, show a login/signup card if not, wire up
// logout, and show who's logged in. Rather than copy-pasting that
// logic into every page's own <script> block, it lives here once.
//
// This does assume each page's HTML includes the same auth-screen
// markup (ids: authScreen, authForm, authEmail, authPassword,
// authHint, authMsg, authSubmit, tabLogin, tabSignup) and, inside
// the sidebar, a logout button (id: logoutBtn) and optionally
// #accountEmail / #accountAvatar elements, which this file fills
// in automatically if present — a page that doesn't have them
// just doesn't get that piece, nothing breaks either way.
// ============================================================

const AuthGuard = (function () {
  let onReadyCallback = null;

  // Same deterministic color-from-text trick used for ticker
  // avatars on the watchlist page, reused here so a person's
  // account initial is always the same color everywhere.
  const BADGE_COLORS = ['#6C8EEF', '#3DDC97', '#FFB454', '#FF6B6B', '#B892FF', '#4FD1E8'];
  function colorFor(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
    return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length];
  }

  function populateAccountInfo(email) {
    const emailEl = document.getElementById('accountEmail');
    if (emailEl) emailEl.textContent = email;

    const avatarEl = document.getElementById('accountAvatar');
    if (avatarEl && email) {
      avatarEl.textContent = email[0].toUpperCase();
      avatarEl.style.background = colorFor(email);
    }
  }

  function setAuthMode(mode) {
    const tabLogin = document.getElementById('tabLogin');
    const tabSignup = document.getElementById('tabSignup');
    const authSubmit = document.getElementById('authSubmit');
    const authHint = document.getElementById('authHint');
    const authPassword = document.getElementById('authPassword');
    const authMsg = document.getElementById('authMsg');

    authMsg.textContent = '';
    tabLogin.classList.toggle('active', mode === 'login');
    tabSignup.classList.toggle('active', mode === 'signup');
    authSubmit.textContent = mode === 'login' ? 'Log in' : 'Sign up';
    authHint.textContent = mode === 'signup' ? 'Password must be at least 8 characters' : '';
    authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authSubmit.dataset.mode = mode;
  }

  function showApp(email) {
    document.getElementById('authScreen').style.display = 'none';
    const appRoot = document.getElementById('appRoot');
    appRoot.style.display = appRoot.dataset.display || 'block';
    populateAccountInfo(email);
    if (onReadyCallback) onReadyCallback(email);
  }

  function showLogin() {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
  }

  function wireAuthForm() {
    const authForm = document.getElementById('authForm');
    const authEmail = document.getElementById('authEmail');
    const authPassword = document.getElementById('authPassword');
    const authMsg = document.getElementById('authMsg');
    const authSubmit = document.getElementById('authSubmit');
    const tabLogin = document.getElementById('tabLogin');
    const tabSignup = document.getElementById('tabSignup');

    tabLogin.addEventListener('click', () => setAuthMode('login'));
    tabSignup.addEventListener('click', () => setAuthMode('signup'));

    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      authMsg.textContent = '';
      authSubmit.disabled = true;

      const mode = authSubmit.dataset.mode || 'login';
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail.value, password: authPassword.value }),
        });
        const data = await res.json();

        if (!res.ok) {
          authMsg.textContent = data.error;
          authSubmit.disabled = false;
          return;
        }

        showApp(data.email);
      } catch (err) {
        authMsg.textContent = 'Could not reach the server';
        authSubmit.disabled = false;
      }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        authForm.reset();
        document.getElementById('authSubmit').disabled = false;
        setAuthMode('login');
        showLogin();
      });
    }
  }

  // init(callback): call once per page, right when the script
  // loads. Wires up the login form, checks whether a session
  // already exists, and either shows the app immediately (existing
  // session) or shows the login card (none yet). `callback` only
  // ever fires once we're sure someone's logged in, and receives
  // the person's email as its argument.
  async function init(callback) {
    onReadyCallback = callback;
    wireAuthForm();
    setAuthMode('login');

    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (res.ok) {
        showApp(data.email);
      } else {
        showLogin();
      }
    } catch (err) {
      showLogin();
    }
  }

  return { init };
})();
