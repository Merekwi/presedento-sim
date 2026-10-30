(() => {
  "use strict";
  const config = window.PRESIDENTIAL_CONFIG || {};
  const API = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const LOGIN_URL = config.TELEGRAM_LOGIN_URL || "";
  const TOKEN_KEY = "presidential.session.token";
  const STATE_KEY = "presidential.login.state";
  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let currentUser = null;

  const css = document.createElement("style");
  css.textContent = `
    body:not(.presidential-authenticated) .layout{visibility:hidden}
    #presidentialAuthGate{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:22px;background:#f2f4f8;color:#172235;font:15px/1.55 Inter,system-ui,sans-serif}
    #presidentialAuthGate .auth-card{width:min(100%,500px);padding:34px;border:1px solid #dce2eb;border-radius:22px;background:#fff;box-shadow:0 22px 70px #16233a14}
    #presidentialAuthGate .auth-mark{font-size:11px;font-weight:800;letter-spacing:.18em;color:#718097}
    #presidentialAuthGate h2{margin:20px 0 8px;font-size:27px;letter-spacing:-.04em}
    #presidentialAuthGate p{margin:0;color:#68758a}
    #presidentialAuthGate .auth-status{margin:18px 0;color:#68758a;font-size:13px;overflow-wrap:anywhere}
    #presidentialAuthGate button{border:0;border-radius:10px;padding:13px 18px;background:#1c4e86;color:#fff;font-weight:700;cursor:pointer}
    #presidentialAuthGate button:disabled{opacity:.5;cursor:wait}
    #presidentialAuthGate .auth-error{color:#b33a37}
    #presidentialUserBar{display:flex;align-items:center;gap:12px;margin-left:auto;font-size:12px;color:#637083}
    #presidentialUserBar button{border:1px solid #d9e0ea;border-radius:9px;padding:8px 11px;background:#fff;color:#32445c;cursor:pointer}
    @media(max-width:720px){#presidentialUserBar{width:100%;margin:8px 0 0;justify-content:flex-end}}
  `;
  document.head.appendChild(css);

  function ensureGate() {
    let gate = document.getElementById("presidentialAuthGate");
    if (gate) return gate;
    gate = document.createElement("div");
    gate.id = "presidentialAuthGate";
    gate.innerHTML = '<div class="auth-card"><div class="auth-mark">PRESIDENTIAL SIMULATOR · SECURE ACCESS</div><h2>Вход в государственный кабинет</h2><p>Авторизуйтесь через Telegram-бот Nettle Group. Новый бот создавать не нужно.</p><div class="auth-status" id="presidentialAuthStatus">Проверяем сессию…</div><button id="presidentialLoginButton" type="button">Войти через Telegram</button></div>';
    document.body.appendChild(gate);
    gate.querySelector("button").addEventListener("click", startLogin);
    return gate;
  }
  function showGate(message, error = false) {
    document.body.classList.remove("presidential-authenticated");
    ensureGate();
    const label = document.getElementById("presidentialAuthStatus");
    label.textContent = message || "Для продолжения требуется вход через Telegram.";
    label.classList.toggle("auth-error", error);
    document.getElementById("presidentialLoginButton").disabled = false;
  }
  function randomState() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let binary = "";
    bytes.forEach(byte => binary += String.fromCharCode(byte));
    return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  function startLogin() {
    if (!LOGIN_URL) return showGate("Не задан адрес страницы авторизации.", true);
    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    const button = document.getElementById("presidentialLoginButton");
    if (button) button.disabled = true;
    const target = new URL(LOGIN_URL);
    target.searchParams.set("state", state);
    location.assign(target.toString());
  }
  async function request(path, options = {}) {
    if (!API) throw new Error("API_BASE_URL не настроен.");
    const headers = { ...(options.headers || {}) };
    if (options.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (token && !options.noAuth) headers.Authorization = "Bearer " + token;
    const response = await fetch(API + path, { ...options, headers, credentials: "omit", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && options.noAuth !== true) {
        token = "";
        sessionStorage.removeItem(TOKEN_KEY);
      }
      throw new Error(data.error || ("HTTP " + response.status));
    }
    return data;
  }
  async function exchangeFromHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/,""));
    const code = params.get("ps_login_code");
    const returnedState = params.get("ps_state");
    if (!code && !returnedState) return false;
    history.replaceState(null, "", location.pathname + location.search);
    const expectedState = sessionStorage.getItem(STATE_KEY) || "";
    sessionStorage.removeItem(STATE_KEY);
    if (!code || !returnedState || !expectedState || returnedState !== expectedState) {
      throw new Error("Проверка состояния входа не пройдена. Повторите авторизацию.");
    }
    const response = await request("/api/presidential/auth/exchange", {
      method: "POST",
      noAuth: true,
      body: JSON.stringify({ code, state: returnedState })
    });
    if (!response.token) throw new Error("Сервер не выдал игровую сессию.");
    token = response.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    return true;
  }
  function createUserBar() {
    const header = document.querySelector("main > header");
    if (!header || document.getElementById("presidentialUserBar")) return;
    const bar = document.createElement("div");
    bar.id = "presidentialUserBar";
    const label = document.createElement("span");
    label.textContent = currentUser?.firstName || currentUser?.username || "Игрок";
    const logout = document.createElement("button");
    logout.textContent = "Выйти";
    logout.addEventListener("click", logoutUser);
    bar.append(label, logout);
    header.appendChild(bar);
  }
  async function logoutUser() {
    try { if (token) await request("/api/presidential/auth/logout", { method:"POST", body:"{}" }); } catch (_) {}
    token = "";
    currentUser = null;
    sessionStorage.removeItem(TOKEN_KEY);
    document.body.classList.remove("presidential-authenticated");
    document.getElementById("presidentialUserBar")?.remove();
    showGate("Вы вышли из аккаунта.");
  }
  async function init() {
    ensureGate();
    try {
      await exchangeFromHash();
      if (!token) throw new Error("Пожалуйста, войдите через Telegram.");
      const data = await request("/api/presidential/me");
      currentUser = data.user;
      document.body.classList.add("presidential-authenticated");
      document.getElementById("presidentialAuthGate")?.remove();
      createUserBar();
      window.PRESIDENTIAL_AUTH = {
        api: request,
        get user() { return currentUser; },
        logout: logoutUser,
        setUser: value => { currentUser = value; }
      };
      window.dispatchEvent(new CustomEvent("presidential-auth-ready", { detail: { user: currentUser } }));
    } catch (error) {
      token = sessionStorage.getItem(TOKEN_KEY) || "";
      showGate(error.message || "Не удалось проверить вход.", true);
    }
  }
  window.PRESIDENTIAL_AUTH = {
    api: request,
    get user() { return currentUser; },
    logout: logoutUser
  };
  init();
})();
