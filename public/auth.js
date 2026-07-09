// ============================================================
// auth.js — shared login/session logic.
//
// Every page in this app (watchlist, home, and future ones like
// sectors/articles) needs the SAME thing: check if someone's
// logged in, show a login/signup card if not, and wire up logout.
// Rather than copy-pasting that logic into every page's own
// <script> block, it lives here once. Each page includes this
// file, then calls AuthGuard.init(callback) — the callback only
// ever runs once we KNOW someone is logged in.
//
// This does assume each page's HTML includes the same auth-screen
// markup (ids: authScreen, authForm, authEmail, authPassword,
// authHint, authMsg, authSubmit, tabLogin, tabSignup) and a
// logout button (id: logoutBtn). That HTML is small enough that
// duplicating IT (not the JS) across pages is a reasonable
// trade-off — see the SKILL notes in each page for exactly what
// to copy.
// ============================================================

const AuthGuard = (function () {
  let onReadyCallback = null;

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

  function showApp() {
    document.getElementById('authScreen').style.display = 'none';
    const appRoot = document.getElementById('appRoot');
    appRoot.style.display = appRoot.dataset.display || 'block';
    if (onReadyCallback) onReadyCallback();
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

        showApp();
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
  // ever fires once we're sure someone's logged in.
  async function init(callback) {
    onReadyCallback = callback;
    wireAuthForm();
    setAuthMode('login');

    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        showApp();
      } else {
        showLogin();
      }
    } catch (err) {
      showLogin();
    }
  }

  return { init };
})();
