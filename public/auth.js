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

    // Show Face ID button on login mode if supported
    var faceIdBtn = document.getElementById('faceIdLogin');
    if (faceIdBtn) {
      faceIdBtn.style.display = (mode === 'login' && window.PublicKeyCredential) ? 'block' : 'none';
    }
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

  async function authFetch(url, options, retries) {
    retries = retries || 0;
    try {
      const res = await fetch(url, options);
      if (res.status === 401) {
        showLogin('Your session expired. Please log in again.');
      }
      // Retry on server errors (502/503/504 = Railway cold start or deploy)
      if ((res.status === 502 || res.status === 503 || res.status === 504) && retries < 4) {
        showReconnecting();
        await new Promise(r => setTimeout(r, (retries + 1) * 2000));
        return authFetch(url, options, retries + 1);
      }
      hideReconnecting();
      return res;
    } catch (err) {
      // Network error - retry up to 4 times with exponential backoff
      if (retries < 4) {
        showReconnecting();
        await new Promise(r => setTimeout(r, Math.min((retries + 1) * 2000, 8000)));
        return authFetch(url, options, retries + 1);
      }
      hideReconnecting();
      throw err;
    }
  }

  var reconnectEl = null;
  function showReconnecting() {
    if (reconnectEl) return;
    reconnectEl = document.createElement('div');
    reconnectEl.id = 'reconnectBanner';
    reconnectEl.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#C9A75C;color:#23281F;text-align:center;padding:8px;font-size:12px;font-weight:600;font-family:Archivo,system-ui,sans-serif;z-index:300;backdrop-filter:blur(8px)';
    reconnectEl.textContent = 'Reconnecting to server...';
    document.body.appendChild(reconnectEl);
  }
  function hideReconnecting() {
    if (reconnectEl) { reconnectEl.remove(); reconnectEl = null; }
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

    var pending2FA = null; // stores email/password while waiting for 2FA code

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

      // If we're in 2FA mode, add the TOTP code
      if (pending2FA) {
        payload.email = pending2FA.email;
        payload.password = pending2FA.password;
        payload.totpCode = authPassword.value; // password field reused for 2FA code
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
          if (pending2FA) authPassword.value = '';
          return;
        }

        // Check if 2FA is required
        if (data.requires2FA) {
          pending2FA = { email: authEmail.value, password: authPassword.value };
          authEmail.style.display = 'none';
          authPassword.value = '';
          authPassword.type = 'text';
          authPassword.placeholder = '6-digit code from your authenticator';
          authPassword.setAttribute('inputmode', 'numeric');
          authPassword.setAttribute('autocomplete', 'one-time-code');
          authPassword.maxLength = 6;
          authHint.innerHTML = 'Enter the code from your authenticator app';
          authSubmit.textContent = 'Verify';
          authSubmit.disabled = false;
          authPassword.focus();
          return;
        }

        // Reset 2FA state
        pending2FA = null;
        showApp(data.email, data.name || null);
      } catch (err) {
        authMsg.textContent = 'Could not reach the server';
        authSubmit.disabled = false;
      }
    });

    // Inject Face ID login button
    if (window.PublicKeyCredential && authForm) {
      var faceBtn = document.createElement('button');
      faceBtn.type = 'button';
      faceBtn.id = 'faceIdLogin';
      faceBtn.style.cssText = 'width:100%;padding:11px;background:transparent;border:1px solid var(--rule-strong,#C6BEA2);border-radius:2px;font-size:12px;font-weight:600;cursor:pointer;margin-top:8px;color:var(--ink-muted,#686C5B);font-family:Archivo,system-ui,sans-serif;display:none';
      faceBtn.textContent = 'Sign in with Face ID';
      faceBtn.addEventListener('click', async function() {
        var email = authEmail.value.trim().toLowerCase();
        if (!email) { authMsg.textContent = 'Enter your email first'; return; }
        faceBtn.disabled = true;
        faceBtn.textContent = 'Verifying...';
        try {
          var optRes = await fetch('/api/auth/webauthn/login-options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
          });
          var options = await optRes.json();
          if (!optRes.ok) { authMsg.textContent = options.error || 'Not available'; faceBtn.disabled = false; faceBtn.textContent = 'Sign in with Face ID'; return; }

          options.challenge = b64urlToBuf(options.challenge);
          options.allowCredentials = options.allowCredentials.map(function(c) {
            c.id = b64urlToBuf(c.id);
            return c;
          });

          var assertion = await navigator.credentials.get({ publicKey: options });

          var loginRes = await fetch('/api/auth/webauthn/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credentialId: bufToB64url(assertion.rawId) }),
          });
          var loginData = await loginRes.json();
          if (loginRes.ok) {
            showApp(loginData.email, loginData.name || null);
          } else {
            authMsg.textContent = loginData.error || 'Authentication failed';
          }
        } catch (err) {
          if (err.name !== 'NotAllowedError') authMsg.textContent = 'Biometric login not available';
        }
        faceBtn.disabled = false;
        faceBtn.textContent = 'Sign in with Face ID';
      });
      authForm.parentNode.insertBefore(faceBtn, authForm.nextSibling);
    }

    function b64urlToBuf(s) {
      s = s.replace(/-/g,'+').replace(/_/g,'/');
      while(s.length%4) s+='=';
      var b=atob(s),a=new Uint8Array(b.length);
      for(var i=0;i<b.length;i++) a[i]=b.charCodeAt(i);
      return a.buffer;
    }
    function bufToB64url(buf) {
      var b=new Uint8Array(buf),s='';
      for(var i=0;i<b.byteLength;i++) s+=String.fromCharCode(b[i]);
      return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    }

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
    // Retry up to 3 times to handle Railway cold starts
    var verified = false;
    for (var attempt = 0; attempt < 3 && !verified; attempt++) {
      try {
        if (attempt > 0) {
          showReconnecting();
          await new Promise(r => setTimeout(r, attempt * 2000));
        }
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        hideReconnecting();
        if (res.ok) {
          verified = true;
          if (!usedCache) {
            showApp(data.email, data.name || null);
          } else {
            populateAccountInfo(data.email);
          }
        } else {
          verified = true;
          showLogin();
        }
      } catch (err) {
        if (attempt === 2) {
          hideReconnecting();
          if (!usedCache) showLogin();
        }
      }
    }
  }

  return { init, fetch: authFetch };
})();
