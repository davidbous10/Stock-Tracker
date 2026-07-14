// ============================================================
// chat.js — Trade Track AI assistant widget.
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
      Trade Track AI
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
  fab.title = 'Trade Track AI';
  fab.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  document.body.appendChild(panel);
  document.body.appendChild(fab);

  // ---- State ----
  const history = []; // { role: 'user'|'assistant', content: string }
  const messagesEl = document.getElementById('chatMessages');
  const inputEl = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSend');
  let isOpen = false;
  let isSending = false;

  // ---- Toggle ----
  fab.addEventListener('click', () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    fab.classList.toggle('open', isOpen);
    if (isOpen) inputEl.focus();
  });

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
      }
    } catch (err) {
      hideTyping();
      addMessage('error', 'Could not reach the server');
    }

    isSending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
})();
