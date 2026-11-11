// ---- LOGIN PAGE (checked by the server) ----
const loginForm = document.getElementById("login-form");
if (loginForm) {
  const loginModal = document.getElementById("login-modal");
  const loginCodeMsg = document.getElementById("login-code-msg");

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = document.getElementById("login-error");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("email").value,
          password: document.getElementById("password").value
        })
      });
      const data = await res.json();
      if (!res.ok) {
        error.textContent = data.error;
        error.hidden = false;
        return;
      }
      error.hidden = true;
      document.getElementById("login-code-hint").textContent = "Demo code: " + data.demoCode;
      loginModal.hidden = false;
      document.getElementById("login-code").focus();
    } catch (err) {
      error.textContent = "Cannot reach the server. Is it running?";
      error.hidden = false;
    }
  });

  function closeLoginModal() {
    loginModal.hidden = true;
    loginCodeMsg.hidden = true;
    document.getElementById("login-code-form").reset();
  }

  document.getElementById("login-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: document.getElementById("login-code").value })
    });
    const data = await res.json();
    if (!res.ok) {
      loginCodeMsg.textContent = data.error;
      loginCodeMsg.hidden = false;
      return;
    }
    window.location.href = "dashboard.html";
  });

  document.getElementById("login-code-cancel").addEventListener("click", closeLoginModal);
}

// ---- DASHBOARD PAGE (balance and transfers come from the server) ----
const transferForm = document.getElementById("transfer-form");
if (transferForm) {
  const balanceEl = document.getElementById("balance");
  const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let currentBalance = 0;

  // Talk to the server. A 401 means "not logged in", so go to the login page.
  async function api(url, body) {
    const options = body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const res = await fetch(url, options);
    if (res.status === 401) {
      window.location.href = "index.html";
      return { ok: false, status: 401, data: {} };
    }
    let data = {};
    try { data = await res.json(); } catch (err) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  async function loadAccount() {
    const r = await api("/api/me");
    if (!r.ok) return;
    const d = r.data;
    currentBalance = d.balance;
    balanceEl.textContent = money(d.balance);
    document.getElementById("welcome").textContent = "Hello, " + d.name;
    document.querySelectorAll(".user-name").forEach((el) => { el.textContent = d.name; });
    document.querySelectorAll(".user-name-caps").forEach((el) => { el.textContent = d.name.toUpperCase(); });
    document.querySelectorAll(".acct-number").forEach((el) => { el.textContent = d.account_number; });
    document.querySelectorAll(".routing-number").forEach((el) => { el.textContent = d.routing_number; });
  }

  async function loadTransactions() {
    const r = await api("/api/transactions");
    if (!r.ok) return;
    const list = document.getElementById("transactions");
    list.replaceChildren();
    if (r.data.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No transactions yet.";
      list.append(li);
      return;
    }
    r.data.forEach((t) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = t.label;
      const amt = document.createElement("span");
      amt.className = t.amount > 0 ? "in" : "out";
      amt.textContent = (t.amount > 0 ? "+" : "-") + money(Math.abs(t.amount));
      li.append(name, amt);
      list.append(li);
    });
  }

  async function refreshAll() {
    await loadAccount();
    await loadTransactions();
  }
  refreshAll();

  // Switch between Send money / Receive money / Buy stock / Card
  const actionButtons = document.querySelectorAll(".action");
  const panels = ["send-panel", "receive-panel", "stock-panel", "card-panel"];
  actionButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      actionButtons.forEach((b) => b.classList.toggle("active", b === btn));
      panels.forEach((id) => {
        document.getElementById(id).hidden = id !== btn.dataset.panel;
      });
    });
  });

  // ---- Activation code popup (the server makes and checks the code) ----
  const codeModal = document.getElementById("code-modal");
  const codeMsg = document.getElementById("code-msg");
  const codeInput = document.getElementById("code-input");
  let pendingAction = null; // a function that gets the typed code and returns an error message or null

  async function askForCode(action) {
    const r = await api("/api/action-code", {});
    if (!r.ok) return;
    const hint = document.getElementById("code-hint");
    if (hint) hint.textContent = "Demo code: " + r.data.demoCode;
    pendingAction = action;
    codeModal.hidden = false;
    codeInput.focus();
  }

  function closeModal() {
    codeModal.hidden = true;
    codeMsg.hidden = true;
    document.getElementById("code-form").reset();
    pendingAction = null;
  }

  document.getElementById("code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pendingAction) return;
    const error = await pendingAction(codeInput.value.trim());
    if (error) {
      codeMsg.textContent = error;
      codeMsg.hidden = false;
      return;
    }
    closeModal();
  });
  document.getElementById("code-cancel").addEventListener("click", closeModal);

  // ---- Send money ----
  transferForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const acct = document.getElementById("acct").value.trim();
    const bank = document.getElementById("bank").value;
    const amount = parseFloat(document.getElementById("amt").value);
    const msg = document.getElementById("transfer-msg");

    if (!/^\d{10}$/.test(acct)) {
      msg.textContent = "Account number must be exactly 10 digits.";
      msg.hidden = false;
      return;
    }
    if (amount > currentBalance) {
      msg.textContent = "Not enough funds. Enter a smaller amount.";
      msg.hidden = false;
      return;
    }
    msg.hidden = true;

    askForCode(async (code) => {
      const r = await api("/api/send", { acct: acct, bank: bank, amount: amount, code: code });
      if (r.status === 403) return r.data.error;   // a code problem: stay in the popup
      if (!r.ok) {                                  // another problem: close the popup and show it
        msg.textContent = r.data.error || "Transfer failed.";
        msg.hidden = false;
        return null;
      }
      transferForm.reset();
      await refreshAll();
      return null;
    });
  });

  // ---- Buy stock ----
  const stockForm = document.getElementById("stock-form");
  const stockSelect = document.getElementById("stock");
  const qtyInput = document.getElementById("qty");
  const totalEl = document.getElementById("stock-total");

  function updateTotal() {
    const parts = stockSelect.value.split("|");
    const price = parts[1] ? parseFloat(parts[1]) : 0;
    totalEl.textContent = "Total: " + money(price * (parseInt(qtyInput.value) || 0));
  }
  stockSelect.addEventListener("change", updateTotal);
  qtyInput.addEventListener("input", updateTotal);

  stockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = stockSelect.value.split("|")[0];
    const msg = document.getElementById("stock-msg");
    const r = await api("/api/buy-stock", { stock: name, qty: parseInt(qtyInput.value) });
    if (!r.ok) {
      msg.textContent = r.data.error || "Could not buy.";
      msg.hidden = false;
      return;
    }
    msg.hidden = true;
    stockForm.reset();
    updateTotal();
    await refreshAll();
  });

  // ---- Card: flip, freeze, unfreeze ----
  const cardVisual = document.getElementById("card-visual");
  const cardStatus = document.getElementById("card-status");
  const cardToggle = document.getElementById("card-toggle");
  let frozen = false;

  cardVisual.addEventListener("click", () => cardVisual.classList.toggle("flipped"));
  cardVisual.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      cardVisual.classList.toggle("flipped");
    }
  });

  function setFrozen(value) {
    frozen = value;
    cardVisual.classList.toggle("frozen", frozen);
    cardStatus.textContent = frozen
      ? "Card is frozen. Demo card, not usable anywhere."
      : "Card is active. Demo card, not usable anywhere.";
    cardToggle.textContent = frozen ? "Unfreeze card" : "Freeze card";
  }

  cardToggle.addEventListener("click", () => {
    if (!frozen) {
      setFrozen(true);
      return;
    }
    askForCode(async (code) => {
      const r = await api("/api/check-code", { code: code });
      if (!r.ok) return r.data.error;
      setFrozen(false);
      return null;
    });
  });

  // ---- Logout ----
  document.getElementById("logout").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "index.html";
  });

    // ---- Live chat (Socket.IO) ----
  const chatBox = document.getElementById("chat-box");
  const chatOpen = document.getElementById("chat-open");
  const chatList = document.getElementById("chat-messages");
  const socket = io();

  function addChatMessage(m) {
    const p = document.createElement("p");
    p.className = "msg " + (m.sender === "customer" ? "me" : "agent");
    p.textContent = m.text;
    chatList.append(p);
    chatList.scrollTop = chatList.scrollHeight;
  }

  socket.on("chat:history", (rows) => {
    chatList.replaceChildren();
    addChatMessage({ sender: "agent", text: "Hello! How can we help you today?" });
    rows.forEach(addChatMessage);
  });
  socket.on("chat:message", (m) => {
    addChatMessage(m);
    if (m.sender === "agent" && chatBox.hidden) chatOpen.textContent = "Customer care (new)";
  });

  chatOpen.addEventListener("click", () => {
    chatBox.hidden = false;
    chatOpen.hidden = true;
    chatOpen.textContent = "Customer care";
  });
  document.getElementById("chat-close").addEventListener("click", () => {
    chatBox.hidden = true;
    chatOpen.hidden = false;
  });

  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chat:send", text);
    input.value = "";
  });
}