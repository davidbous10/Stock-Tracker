// ============================================================
// auth.js — shared login/session logic.
//
// Every page includes the same auth-screen markup (ids:
// authScreen, authForm, authEmail, authPassword, authName,
// authHint, authMsg, authSubmit, tabLogin, tabSignup) and
// sidebar elements (logoutBtn, accountEmail, accountAvatar).
//
// The callback passed to init() now receives TWO arguments:
//   callback(email, name)
// so pages like Home can greet by first name.
// ============================================================

const AuthGuard = (function () {
  let onReadyCallback = null;

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
    authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authSubmit.dataset.mode = mode;

    // Name field only appears during signup.
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
    if (onReadyCallback) onReadyCallback(email, name);
  }

  function showLogin(message) {
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('appRoot').style.display = 'none';
    if (message) {
      const authMsg = document.getElementById('authMsg');
      authMsg.textContent = message;
      authMsg.className = 'auth-msg';
    }
  }

  async function authFetch(url, options) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      showLogin('Your session expired — please log in again');
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
    setAuthMode('login');

    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      if (res.ok) {
        showApp(data.email, data.name || null);
      } else {
        showLogin();
      }
    } catch (err) {
      showLogin();
    }
  }

  return { init, fetch: authFetch };
})();
