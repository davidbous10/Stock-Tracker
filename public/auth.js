// ============================================================
// auth.js — shared login/session logic.
//
// Flash prevention: pages start with BOTH authScreen and appRoot
// hidden. If sessionStorage says we've logged in before, we show
// the app immediately (no network wait). The async /api/auth/me
// call runs in the background as a safety net — if the session
// actually expired, we bounce to login.
// ============================================================

const AuthGuard = (function () {
  let onReadyCallback = null;
  const STORAGE_KEY = 'tt_auth';

  const BADGE_COLORS = ['#17442F', '#A97F2F', '#8C2F2B', '#2E4056', '#5F6B3C', '#7A4E2D'];
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
    const authName = document.getElementById('authName');

    authMsg.textContent = '';
    tabLogin.classList.toggle('active', mode === 'login');
    tabSignup.classList.toggle('active', mode === 'signup');
    authSubmit.textContent = mode === 'login' ? 'Log in' : 'Sign up';
    authHint.textContent = mode === 'signup' ? 'Password must be at least 8 characters' : '';
    authHint.innerHTML = mode === 'login' ? '<a href="/reset.html" style="color:var(--ink-faint,#9A9C8B);font-size:11px;text-decoration:none">Forgot password?</a>' : authHint.textContent;
    authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authSubmit.dataset.mode = mode;

    if (authName) {
      authName.style.display = mode === 'signup' ? '' : 'none';
      authName.required = mode === 'signup';
    }
  }

  function showApp(email, name) {
    document.getElementById('authScreen').style.display = 'none';
    const appRoot = document.getElementById('appRoot');
    appRoot.style.display = appRoot.dataset.display || 'block';
    populateAccountInfo(email);

    // Cache auth state so the next page load is instant
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ email, name }));
    } catch (e) {}

    if (onReadyCallback) onReadyCallback(email, name);
  }

  function showLogin(message) {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';

    // Clear cached auth
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}

    if (message) {
      const authMsg = document.getElementById('authMsg');
      authMsg.textContent = message;
      authMsg.className = 'auth-msg';
    }
  }

  async function authFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      showLogin('Your session expired. Please log in again.');
    }
    return res;
  }

  function wireAuthForm() {
    const authForm = document.getElementById('authForm');
    const authEmail = document.getElementById('authEmail');
    const authPassword = document.getElementById('authPassword');
    const authName = document.getElementById('authName');
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

      const payload = { email: authEmail.value, password: authPassword.value };
      if (mode === 'signup' && authName) {
        payload.name = authName.value.trim();
      }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok) {
          authMsg.textContent = data.error;
          authSubmit.disabled = false;
          return;
        }

        showApp(data.email, data.name || null);
      } catch (err) {
        authMsg.textContent = 'Could not reach the server';
        authSubmit.disabled = false;
      }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
        authForm.reset();
        document.getElementById('authSubmit').disabled = false;
        setAuthMode('login');
        showLogin();
      });
    }
  }

  async function init(callback) {
    onReadyCallback = callback;
    wireAuthForm();

    // The landing page defaults to signup (for new visitors), while
    // other pages default to login. Respect whatever mode the HTML
    // set on the submit button; only default to login if not set.
    const currentMode = document.getElementById('authSubmit').dataset.mode;
    if (!currentMode) setAuthMode('login');

    // INSTANT PATH: if we've logged in before on this tab, show the
    // app immediately using cached email/name. No network wait.
    let usedCache = false;
    try {
      const cached = sessionStorage.getItem(STORAGE_KEY);
      if (cached) {
        const { email, name } = JSON.parse(cached);
        if (email) {
          showApp(email, name);
          usedCache = true;
        }
      }
    } catch (e) {}

    // VERIFY in background — if the session actually expired on the
    // server, this catches it and bounces to login.
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (res.ok) {
        if (!usedCache) {
          // First visit or sessionStorage was cleared — normal path
          showApp(data.email, data.name || null);
        } else {
          // Update sidebar in case name/email changed
          populateAccountInfo(data.email);
        }
      } else {
        showLogin();
      }
    } catch (err) {
      if (!usedCache) showLogin();
    }
  }

  return { init, fetch: authFetch };
})();
