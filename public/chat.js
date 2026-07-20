// ============================================================
// chat.js — Trackr assistant widget.
//
// Self-contained: injects its own CSS and DOM into whatever page
// loads it. Just add <script src="/chat.js"></script> after
// auth.js on any page and the chat bubble appears.
//
// Uses AuthGuard.fetch() so session expiry is handled cleanly.
// Conversation history is kept in memory for the session —
// navigating away or refreshing starts a new conversation.
// ============================================================

(function () {
  // ---- Inject CSS ----
  const style = document.createElement('style');
  style.textContent = `
    .chat-fab {
      position: fixed; bottom: 24px; right: 24px;
      width: 52px; height: 52px; border-radius: 50%;
      background: #17442F; color: #F3EEDF; border: none;
      box-shadow: 0 4px 16px rgba(23,68,47,0.35);
      cursor: pointer; z-index: 200;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .chat-fab:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(23,68,47,0.45); }
    .chat-fab.open { transform: rotate(45deg); }

    .chat-panel {
      position: fixed; bottom: 88px; right: 24px;
      width: 380px; max-height: 520px;
      background: #FBF7EB; border: 1px solid #C6BEA2;
      border-radius: 8px; box-shadow: 0 12px 40px rgba(35,40,31,0.2);
      z-index: 199; display: none; flex-direction: column;
      overflow: hidden;
    }
    .chat-panel.open { display: flex; }

    .chat-header {
      background: #17442F; color: #F3EEDF;
      padding: 14px 18px; font-size: 14px; font-weight: 700;
      font-family: 'Archivo', system-ui, sans-serif;
      display: flex; align-items: center; gap: 10px;
      letter-spacing: 0.01em;
    }
    .chat-header-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #3DDC97; flex-shrink: 0;
    }

    .chat-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
      min-height: 200px; max-height: 360px;
      font-family: 'Archivo', system-ui, sans-serif;
    }

    .chat-msg {
      max-width: 85%; padding: 10px 14px;
      border-radius: 8px; font-size: 13px; line-height: 1.55;
      word-wrap: break-word;
    }
    .chat-msg.user {
      align-self: flex-end;
      background: #17442F; color: #F3EEDF;
      border-bottom-right-radius: 2px;
    }
    .chat-msg.assistant {
      align-self: flex-start;
      background: #ECE5D0; color: #23281F;
      border-bottom-left-radius: 2px;
      border: 1px solid #DDD5BE;
    }
    .chat-msg.assistant p { margin: 0 0 8px; }
    .chat-msg.assistant p:last-child { margin-bottom: 0; }
    .chat-msg.assistant strong { font-weight: 700; }
    .chat-msg.error {
      align-self: center;
      background: #F1E0D8; color: #8C2F2B;
      font-size: 12px; border: 1px solid #D3AC9F;
    }

    .chat-typing {
      align-self: flex-start;
      display: flex; gap: 5px; padding: 10px 14px;
    }
    .chat-typing span {
      width: 7px; height: 7px; border-radius: 50%;
      background: #9A9C8B; animation: chatBounce 1.2s infinite;
    }
    .chat-typing span:nth-child(2) { animation-delay: 0.15s; }
    .chat-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes chatBounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-6px); }
    }

    .chat-input-row {
      display: flex; gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid #DDD5BE;
      background: #F3EEDF;
    }
    .chat-input {
      flex: 1; background: #FFFDF4;
      border: 1px solid #C6BEA2; border-radius: 4px;
      padding: 9px 12px; font-size: 13px;
      font-family: 'Archivo', system-ui, sans-serif;
      color: #23281F; outline: none; resize: none;
      min-height: 20px; max-height: 80px;
    }
    .chat-input:focus { border-color: #17442F; }
    .chat-input::placeholder { color: #9A9C8B; }
    .chat-send {
      background: #17442F; color: #F3EEDF; border: none;
      border-radius: 4px; padding: 0 14px;
      font-size: 13px; font-weight: 700; cursor: pointer;
      font-family: 'Archivo', system-ui, sans-serif;
    }
    .chat-send:hover { background: #1E5C3D; }
    .chat-send:disabled { opacity: 0.5; cursor: default; }

    .chat-welcome {
      text-align: center; padding: 20px 16px;
      color: #686C5B; font-size: 13px; line-height: 1.5;
    }
    .chat-welcome strong { color: #23281F; display: block; margin-bottom: 6px; font-size: 14px; }

    .chat-suggestions {
      display: flex; flex-wrap: wrap; gap: 6px;
      justify-content: center; padding: 0 16px 12px;
    }
    .chat-suggestion {
      background: none; border: 1px solid #C6BEA2;
      border-radius: 3px; padding: 6px 10px;
      font-size: 11px; color: #686C5B; cursor: pointer;
      font-family: 'Archivo', system-ui, sans-serif;
    }
    .chat-suggestion:hover { border-color: #17442F; color: #23281F; }

    .chat-chart-label {
      font-family: 'Courier Prime', monospace;
      font-size: 10px; font-weight: 700;
      color: #686C5B; margin-bottom: 6px;
      letter-spacing: 0.04em; text-transform: uppercase;
    }
    .chat-chart-svg { width: 100%; height: 80px; display: block; border-radius: 2px; }
    .chat-chart-dates {
      display: flex; justify-content: space-between;
      font-family: 'Courier Prime', monospace;
      font-size: 9px; color: #9A9C8B; margin-top: 4px;
    }

    @media (max-width: 800px) {
      .chat-fab { bottom: 80px; right: 16px; width: 46px; height: 46px; }
      .chat-panel {
        bottom: 0; right: 0; left: 0;
        width: 100%; max-height: 85vh;
        border-radius: 12px 12px 0 0;
        bottom: 0;
      }
      .chat-panel.open + .chat-fab { display: none; }
    }
  `;
  document.head.appendChild(style);

  // ---- Inject DOM ----
  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.id = 'chatPanel';
  panel.innerHTML = `
    <div class="chat-header">
      <div class="chat-header-dot"></div>
      Trackr
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-welcome">
        <strong>Ask me anything about the market.</strong>
        I can see your watchlist and live prices, so ask me about your stocks specifically.
      </div>
      <div class="chat-suggestions" id="chatSuggestions">
        <button class="chat-suggestion" data-q="How's my portfolio doing today?">My portfolio today</button>
        <button class="chat-suggestion" data-q="Which of my stocks has the best momentum?">Best momentum</button>
        <button class="chat-suggestion" data-q="What does market cap mean?">What's market cap?</button>
        <button class="chat-suggestion" data-q="Give me a quick market overview for today.">Market overview</button>
      </div>
    </div>
    <div class="chat-input-row">
      <textarea class="chat-input" id="chatInput" placeholder="Ask about your stocks…" rows="1"></textarea>
      <button class="chat-send" id="chatSend">Send</button>
    </div>
  `;

  const fab = document.createElement('button');
  fab.className = 'chat-fab';
  fab.id = 'chatFab';
  fab.title = 'Trackr';
  fab.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  document.body.appendChild(panel);
  document.body.appendChild(fab);

  // ---- Notification bell: inject into sidebar ----
  var sideNav = document.querySelector('.sidebar .side-nav');
  if (sideNav) {
    var bellWrap = document.createElement('div');
    bellWrap.className = 'notif-bell-wrap';
    bellWrap.innerHTML = '<button class="notif-bell" id="notifBell" onclick="toggleNotifPanel()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="notif-badge" id="notifBadge" style="display:none">0</span></button><div class="notif-dropdown" id="notifDropdown"></div>';
    var acctBlock = document.querySelector('.sidebar .account-block');
    if (acctBlock) acctBlock.parentNode.insertBefore(bellWrap, acctBlock);
  }

  // Notification CSS
  var notifStyle = document.createElement('style');
  notifStyle.textContent = `
    .notif-bell-wrap { position: relative; padding: 0 12px; }
    .notif-bell {
      background: none; border: none; color: #B9C1AC; cursor: pointer;
      padding: 8px 0; display: flex; align-items: center; gap: 6px;
      font-size: 12px; font-weight: 600; font-family: 'Archivo', system-ui, sans-serif;
    }
    .notif-bell:hover { color: #F3EEDF; }
    .notif-badge {
      background: #FF6B6B; color: #fff; font-size: 10px; font-weight: 700;
      min-width: 16px; height: 16px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Courier Prime', monospace; padding: 0 4px;
    }
    .notif-dropdown {
      display: none; position: absolute; bottom: calc(100% + 8px); left: 12px;
      width: 280px; max-height: 320px; overflow-y: auto;
      background: #FBF7EB; border: 1px solid #C6BEA2; border-radius: 3px;
      box-shadow: 0 8px 24px rgba(35,40,31,0.2); z-index: 50;
    }
    .notif-dropdown.open { display: block; }
    html.dark .notif-dropdown { background: #162219; border-color: #354A3A; }
    .notif-item {
      padding: 10px 14px; border-bottom: 1px solid #DDD5BE;
      font-size: 12px; color: #23281F;
    }
    html.dark .notif-item { border-color: #2A3B2E; color: #D4DBCE; }
    .notif-item:last-child { border-bottom: none; }
    .notif-item-title { font-weight: 700; margin-bottom: 2px; }
    .notif-item-body { color: #686C5B; font-size: 11px; }
    html.dark .notif-item-body { color: #8A9483; }
    .notif-item-time { color: #9A9C8B; font-size: 10px; font-family: 'Courier Prime', monospace; margin-top: 3px; }
    .notif-item.unread { border-left: 3px solid #C9A75C; }
    .notif-empty { padding: 20px; text-align: center; color: #9A9C8B; font-size: 12px; }
    @media (max-width: 800px) { .notif-bell-wrap { display: none; } }
  `;
  document.head.appendChild(notifStyle);

  var notifOpen = false;
  window.toggleNotifPanel = function () {
    var dd = document.getElementById('notifDropdown');
    notifOpen = !notifOpen;
    dd.className = 'notif-dropdown' + (notifOpen ? ' open' : '');
    if (notifOpen) {
      loadNotifications();
      AuthGuard.fetch('/api/notifications/read', { method: 'POST' }).catch(function(){});
      var badge = document.getElementById('notifBadge');
      badge.style.display = 'none';
    }
  };

  async function loadNotifications() {
    var dd = document.getElementById('notifDropdown');
    try {
      var res = await AuthGuard.fetch('/api/notifications');
      var data = await res.json();
      var notifs = data.notifications || [];
      if (notifs.length === 0) {
        dd.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
      }
      dd.innerHTML = notifs.map(function(n) {
        var time = new Date(n.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return '<div class="notif-item' + (n.read ? '' : ' unread') + '"><div class="notif-item-title">' + n.title + '</div>' + (n.body ? '<div class="notif-item-body">' + n.body + '</div>' : '') + '<div class="notif-item-time">' + time + '</div></div>';
      }).join('');
    } catch (err) { dd.innerHTML = '<div class="notif-empty">Could not load</div>'; }
  }

  // Check for unread notifications on load
  async function checkUnread() {
    try {
      var res = await AuthGuard.fetch('/api/notifications');
      var data = await res.json();
      var badge = document.getElementById('notifBadge');
      if (badge && data.unread > 0) {
        badge.textContent = data.unread;
        badge.style.display = 'flex';
      }
    } catch (err) {}
  }
  setTimeout(checkUnread, 2000);

  // ---- Global search: inject into sidebar ----
  var sidebar = document.querySelector('.sidebar .side-nav');
  if (sidebar) {
    var searchWrap = document.createElement('div');
    searchWrap.className = 'sidebar-search';
    searchWrap.innerHTML = '<div class="ss-input-wrap"><svg class="ss-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input class="ss-input" id="globalSearch" type="text" placeholder="Search stocks..." autocomplete="off" /></div><div class="ss-results" id="globalResults"></div>';
    sidebar.parentNode.insertBefore(searchWrap, sidebar.nextSibling);
  }

  // Search CSS
  var searchStyle = document.createElement('style');
  searchStyle.textContent = `
    .sidebar-search { margin-top: 12px; position: relative; }
    .ss-input-wrap {
      display: flex; align-items: center; gap: 8px;
      background: rgba(243,238,223,0.1); border: 1px solid rgba(243,238,223,0.2);
      border-radius: 3px; padding: 0 10px;
    }
    .ss-icon { color: #B9C1AC; flex-shrink: 0; }
    .ss-input {
      background: none; border: none; color: #F3EEDF;
      font-size: 12px; font-family: 'Archivo', system-ui, sans-serif;
      padding: 8px 0; width: 100%; outline: none;
    }
    .ss-input::placeholder { color: #7A8B6E; }
    .ss-results {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0;
      background: #FBF7EB; border: 1px solid #C6BEA2;
      border-radius: 3px; box-shadow: 0 8px 24px rgba(35,40,31,0.2);
      z-index: 50; display: none; max-height: 240px; overflow-y: auto;
    }
    .ss-results.open { display: block; }
    .ss-result {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; text-decoration: none; color: #23281F;
      border-bottom: 1px solid #DDD5BE; font-size: 12px;
    }
    .ss-result:last-child { border-bottom: none; }
    .ss-result:hover { background: #FFFDF4; }
    .ss-result-ticker {
      font-family: 'Courier Prime', monospace; font-weight: 700;
      font-size: 12px; min-width: 48px;
    }
    .ss-result-name { color: #686C5B; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 800px) { .sidebar-search { display: none; } }
  `;
  document.head.appendChild(searchStyle);

  // ---- Dark mode ----
  var darkStyle = document.createElement('style');
  darkStyle.textContent = `
    html.dark { background: #0F1A14 !important; }
    html.dark body { background: #0F1A14; color: #D4DBCE; }
    html.dark :root {
      --paper: #0F1A14;
      --paper-raise: #162219;
      --paper-bright: #1B2B20;
      --paper-sunken: #0B140F;
      --ink: #D4DBCE;
      --ink-muted: #8A9483;
      --ink-faint: #5E6B56;
      --rule: #2A3B2E;
      --rule-strong: #354A3A;
      --margin-red: #7A3B35;
      --green: #1B5E3A;
      --green-deep: #0F3D25;
      --green-bright: #24784A;
      --brass: #C9A75C;
      --brass-soft: #A68B42;
      --up: #3DDC97;
      --up-bg: #122B1F;
      --down: #FF6B6B;
      --down-bg: #2B1518;
      --shadow-paper: 0 1px 0 rgba(0,0,0,0.2), 0 8px 22px rgba(0,0,0,0.3);
    }
    html.dark .sidebar { background: #0B140F; border-color: #1B2B20; }
    html.dark .side-nav-link:hover { background: rgba(255,255,255,0.06); }
    html.dark .side-nav-link.active { background: rgba(27,94,58,0.4); }
    html.dark .account-avatar { border-color: rgba(255,255,255,0.2); }
    html.dark .btn-logout-full { border-color: rgba(255,255,255,0.15); color: #8A9483; }
    html.dark .auth-card { background: #162219; border-color: #354A3A; }
    html.dark .auth-card::before { border-color: rgba(201,167,92,0.3); }
    html.dark .auth-tab { color: #8A9483; }
    html.dark .auth-tab.active { background: #1B5E3A; color: #D4DBCE; }
    html.dark .auth-tabs { background: #0B140F; border-color: #2A3B2E; }
    html.dark #authForm input { background: #0F1A14; border-color: #354A3A; color: #D4DBCE; }
    html.dark .btn-auth-submit { background: #1B5E3A; }
    html.dark .skeleton { background: linear-gradient(90deg, #1B2B20 25%, #2A3B2E 37%, #1B2B20 63%); background-size: 400% 100%; }
    html.dark .chat-panel { background: #162219; border-color: #354A3A; }
    html.dark .chat-msg.assistant { background: #1B2B20; border-color: #2A3B2E; color: #D4DBCE; }
    html.dark .chat-input-row { background: #0F1A14; border-color: #2A3B2E; }
    html.dark .chat-input { background: #162219; border-color: #354A3A; color: #D4DBCE; }
    html.dark .chat-suggestion { border-color: #354A3A; color: #8A9483; }
    html.dark .chat-welcome { color: #8A9483; }
    html.dark .chat-welcome strong { color: #D4DBCE; }
    html.dark .ss-input-wrap { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.12); }
    html.dark .ss-results { background: #162219; border-color: #354A3A; }
    html.dark .ss-result { color: #D4DBCE; border-color: #2A3B2E; }
    html.dark .ss-result:hover { background: #1B2B20; }
    html.dark .landing { color: #D4DBCE; }
    html.dark .landing-feature { background: #162219; border-color: #354A3A; }
    html.dark .landing-sub { color: #8A9483; }
    html.dark .bottom-tabs { background: #0B140F; border-color: #1B2B20; }
    html.dark img.stock-logo, html.dark .avatar { filter: none; background: #1B2B20; }
  `;
  document.head.appendChild(darkStyle);

  // Apply saved dark mode preference
  if (localStorage.getItem('tt_dark') === '1') {
    document.documentElement.classList.add('dark');
  }

  // Global toggle function (called from settings page)
  window.toggleDarkMode = function () {
    var isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('tt_dark', isDark ? '1' : '0');
    return isDark;
  };

  // Search logic
  var searchInput = document.getElementById('globalSearch');
  var searchResults = document.getElementById('globalResults');
  var searchTimer = null;

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = searchInput.value.trim();
      if (q.length < 1) { searchResults.className = 'ss-results'; searchResults.innerHTML = ''; return; }
      searchTimer = setTimeout(function () { doGlobalSearch(q); }, 300);
    });

    searchInput.addEventListener('blur', function () {
      setTimeout(function () { searchResults.className = 'ss-results'; }, 200);
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { searchInput.value = ''; searchResults.className = 'ss-results'; }
    });
  }

  async function doGlobalSearch(query) {
    try {
      var res = await AuthGuard.fetch('/api/search?q=' + encodeURIComponent(query));
      var data = await res.json();
      var results = data.results || [];
      if (results.length === 0) {
        searchResults.innerHTML = '<div style="padding:10px 12px;font-size:11px;color:#9A9C8B">No results</div>';
        searchResults.className = 'ss-results open';
        return;
      }
      searchResults.innerHTML = results.slice(0, 6).map(function (r) {
        return '<a href="/stock.html?t=' + encodeURIComponent(r.symbol) + '" class="ss-result"><span class="ss-result-ticker">' + r.symbol + '</span><span class="ss-result-name">' + r.name + '</span></a>';
      }).join('');
      searchResults.className = 'ss-results open';
    } catch (err) {
      searchResults.className = 'ss-results';
    }
  }

  // ---- State ----
  const history = []; // { role: 'user'|'assistant', content: string }
  const messagesEl = document.getElementById('chatMessages');
  const inputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');
  let isOpen = false;
  let isSending = false;

  // ---- Toggle ----
  var historyLoaded = false;

  fab.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    fab.classList.toggle('open', isOpen);
    if (isOpen) {
      inputEl.focus();
      if (!historyLoaded) {
        historyLoaded = true;
        loadChatHistory();
      }
    }
  });

  async function loadChatHistory() {
    try {
      var res = await AuthGuard.fetch('/api/chat/history');
      var data = await res.json();
      var msgs = data.messages || [];
      if (msgs.length > 0) {
        // Remove welcome message and suggestions
        var welcome = messagesEl.querySelector('.chat-welcome');
        var suggestions = messagesEl.querySelector('.chat-suggestions');
        if (welcome) welcome.remove();
        if (suggestions) suggestions.remove();

        msgs.forEach(function(m) {
          addMessage(m.role, m.content);
          history.push({ role: m.role, content: m.content });
        });
      }
    } catch (err) {}
  }

  // ---- Suggestions ----
  document.getElementById('chatSuggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.chat-suggestion');
    if (!btn) return;
    inputEl.value = btn.dataset.q;
    sendMessage();
  });

  // ---- Send ----
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function addMessage(role, content) {
    // Remove welcome and suggestions on first message
    const welcome = messagesEl.querySelector('.chat-welcome');
    const suggestions = messagesEl.querySelector('.chat-suggestions');
    if (welcome) welcome.remove();
    if (suggestions) suggestions.remove();

    const div = document.createElement('div');
    div.className = 'chat-msg ' + role;

    if (role === 'assistant') {
      // Simple markdown-lite rendering: paragraphs, bold, line breaks
      div.innerHTML = content
        .split(/\n\n+/)
        .map(p => '<p>' + esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') + '</p>')
        .join('');
    } else {
      div.textContent = content;
    }

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'chat-typing';
    div.id = 'chatTyping';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function hideTyping() {
    const t = document.getElementById('chatTyping');
    if (t) t.remove();
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isSending) return;

    isSending = true;
    sendBtn.disabled = true;
    inputEl.value = '';
    inputEl.style.height = 'auto';

    addMessage('user', text);
    history.push({ role: 'user', content: text });

    showTyping();

    try {
      const res = await AuthGuard.fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      const data = await res.json();

      hideTyping();

      if (!res.ok) {
        addMessage('error', data.error || 'Something went wrong');
      } else {
        addMessage('assistant', data.reply);
        history.push({ role: 'assistant', content: data.reply });

        // Render any charts the AI requested
        if (data.charts && data.charts.length > 0) {
          data.charts.forEach(function (chart) {
            renderChatChart(chart);
          });
        }

        if (data.watchlistChanged) {
          refreshPageData();
        }
      }
    } catch (err) {
      hideTyping();
      addMessage('error', 'Could not reach the server');
    }

    isSending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
  // Render an inline SVG chart in the chat
  function renderChatChart(chart) {
    const prices = chart.prices || [];
    if (prices.length < 2) return;

    const W = 300, H = 80, pad = 4;
    const min = Math.min.apply(null, prices);
    const max = Math.max.apply(null, prices);
    const range = max - min || 1;

    const coords = prices.map(function (p, i) {
      var x = pad + (i / (prices.length - 1)) * (W - 2 * pad);
      var y = pad + (1 - (p - min) / range) * (H - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');

    var trendUp = prices[prices.length - 1] >= prices[0];
    var stroke = trendUp ? '#1D6A43' : '#8C2F2B';
    var fillId = 'cf' + Date.now();

    var areaCoords = coords + ' ' + (W - pad) + ',' + H + ' ' + pad + ',' + H;

    var startDate = new Date(chart.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    var endDate = new Date(chart.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = '<div class="chat-chart-label">' + esc(chart.ticker) + ' &middot; $' + min.toFixed(2) + ' &ndash; $' + max.toFixed(2) + '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chat-chart-svg" preserveAspectRatio="none">' +
      '<defs><linearGradient id="' + fillId + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + stroke + '" stop-opacity="0.2"/>' +
      '<stop offset="100%" stop-color="' + stroke + '" stop-opacity="0.02"/>' +
      '</linearGradient></defs>' +
      '<polygon points="' + areaCoords + '" fill="url(#' + fillId + ')" />' +
      '<polyline points="' + coords + '" fill="none" stroke="' + stroke + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />' +
      '</svg>' +
      '<div class="chat-chart-dates"><span>' + startDate + '</span><span>' + endDate + '</span></div>';

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // When the AI adds/removes a stock, refresh the current page's
  // data so the user sees the change without manually reloading.
  function refreshPageData() {
    // Small delay so the confirmation message renders first
    setTimeout(() => {
      const path = window.location.pathname;
      if (path.includes('watchlist')) {
        // Watchlist page has these global functions
        if (typeof loadWatchlist === 'function') loadWatchlist();
        if (typeof loadPrices === 'function') loadPrices();
      } else if (path === '/' || path.includes('index')) {
        if (typeof loadPulse === 'function') loadPulse();
        if (typeof loadMover === 'function') loadMover();
      } else if (path.includes('stock')) {
        if (typeof checkWatchlist === 'function') checkWatchlist();
      }
    }, 500);
  }
})();
