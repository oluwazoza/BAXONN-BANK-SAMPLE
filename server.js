const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const http = require("http");
const { Server } = require("socket.io");
const setupChat = require("./chat");

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("Set the SESSION_SECRET environment variable.");
}

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const ROUTING_NUMBER = "123456789";

// Stock prices live on the server so the browser can't change them.
// Keep these the same as the prices in your dashboard dropdown.
const STOCKS = {
  "Demo Tech (DMT)": 1200,
  "Demo Foods (DFD)": 450,
  "Demo Energy (DEN)": 3100
};

// ---- Database (money is stored in cents, as whole numbers) ----
const db = new DatabaseSync(path.join(__dirname, "bank.db"));
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  account_number TEXT NOT NULL UNIQUE,
  balance_cents INTEGER NOT NULL DEFAULT 500000
)`);
db.exec(`CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

// ---- Helpers ----
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function sameHash(a, b) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newAccountNumber() {
  while (true) {
    const n = String(crypto.randomInt(0, 10000000000)).padStart(10, "0");
    if (!db.prepare("SELECT 1 FROM users WHERE account_number = ?").get(n)) return n;
  }
}
// Demo only: a real bank would text or email this code.
function issueCode(req) {
  const code = String(crypto.randomInt(100000, 1000000));
  req.session.action = { code: code, tries: 0, expires: Date.now() + 5 * 60 * 1000 };
  return code;
}
// Returns an error message, or null if the code is right (the code is then used up).
function checkCode(req, submitted) {
  const a = req.session.action;
  if (!a || Date.now() > a.expires) return "Code expired. Close this and try again.";
  a.tries += 1;
  if (a.tries > 5) {
    delete req.session.action;
    return "Too many tries. Close this and try again.";
  }
  if (String(submitted || "") !== a.code) return "Wrong code. Try again.";
  delete req.session.action;
  return null;
}
// Take money out and record it, all or nothing.
function spend(userId, cents, label) {
  db.exec("BEGIN");
  try {
    const r = db.prepare(
      "UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?"
    ).run(cents, userId, cents);
    if (r.changes === 0) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("INSERT INTO transactions (user_id, label, amount_cents) VALUES (?, ?, ?)")
      .run(userId, label, -cents);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
// Move money between two BAXONN accounts, all or nothing.
function transferInternal(fromId, toId, cents, fromLabel, toLabel) {
  db.exec("BEGIN");
  try {
    const r = db.prepare(
      "UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?"
    ).run(cents, fromId, cents);
    if (r.changes === 0) {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?").run(cents, toId);
    db.prepare("INSERT INTO transactions (user_id, label, amount_cents) VALUES (?, ?, ?)")
      .run(fromId, fromLabel, -cents);
    db.prepare("INSERT INTO transactions (user_id, label, amount_cents) VALUES (?, ?, ?)")
      .run(toId, toLabel, cents);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function balanceOf(userId) {
  return db.prepare("SELECT balance_cents FROM users WHERE id = ?").get(userId).balance_cents;
}
// ---- Middleware ----
app.use(express.json());
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
   cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" }
});
app.use(sessionMiddleware);
function requireLoginApi(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}
function requireLoginPage(req, res, next) {
  if (!req.session.userId) return res.redirect("/index.html");
  next();
}

// ---- Pages ----
app.get("/dashboard.html", requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "dashboard.html"));
});
app.use(express.static(path.join(__dirname, "public")));

// ---- Register / login ----
app.post("/api/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8) {
    return res.status(400).json({ error: "Enter your name, an email, and a password of at least 8 characters." });
  }
  const salt = crypto.randomBytes(16).toString("hex");
  try {
    const info = db.prepare(
      "INSERT INTO users (name, email, salt, password_hash, account_number) VALUES (?, ?, ?, ?, ?)"
    ).run(String(name).trim(), String(email).trim().toLowerCase(), salt, hashPassword(String(password), salt), newAccountNumber());
    db.prepare("INSERT INTO transactions (user_id, label, amount_cents) VALUES (?, ?, ?)")
      .run(Number(info.lastInsertRowid), "Opening deposit", 500000);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "That email is already registered." });
  }
});

app.post("/api/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !sameHash(hashPassword(password, user.salt), user.password_hash)) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  const code = String(crypto.randomInt(100000, 1000000));
  req.session.pending = { userId: user.id, code: code, tries: 0 };
  res.json({ ok: true, demoCode: code });
});

app.post("/api/verify-code", (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.status(400).json({ error: "Please log in first." });
  pending.tries += 1;
  if (pending.tries > 5) {
    delete req.session.pending;
    return res.status(429).json({ error: "Too many tries. Log in again." });
  }
  if (String(req.body.code || "") !== pending.code) {
    return res.status(401).json({ error: "Wrong code. Try again." });
  }
  const userId = pending.userId;
  req.session.regenerate(() => {
    req.session.userId = userId;
    res.json({ ok: true });
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---- Account ----
app.get("/api/me", requireLoginApi, (req, res) => {
  const u = db.prepare("SELECT name, email, account_number, balance_cents FROM users WHERE id = ?").get(req.session.userId);
  res.json({
    name: u.name,
    email: u.email,
    account_number: u.account_number,
    routing_number: ROUTING_NUMBER,
    balance: u.balance_cents / 100
  });
});

app.get("/api/transactions", requireLoginApi, (req, res) => {
  const rows = db.prepare(
    "SELECT label, amount_cents FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20"
  ).all(req.session.userId);
  res.json(rows.map((r) => ({ label: r.label, amount: r.amount_cents / 100 })));
});

// ---- Codes for sensitive actions (wrong code = 403) ----
app.post("/api/action-code", requireLoginApi, (req, res) => {
  res.json({ demoCode: issueCode(req) });
});

app.post("/api/check-code", requireLoginApi, (req, res) => {
  const err = checkCode(req, req.body.code);
  if (err) return res.status(403).json({ error: err });
  res.json({ ok: true });
});

// ---- Send money ----
app.post("/api/send", requireLoginApi, (req, res) => {
  const acct = String(req.body.acct || "").trim();
  const bank = String(req.body.bank || "").trim();
  const cents = Math.round(Number(req.body.amount) * 100);
  const userId = req.session.userId;

  if (!/^\d{10}$/.test(acct)) return res.status(400).json({ error: "Account number must be exactly 10 digits." });
  if (!bank || bank.length > 60) return res.status(400).json({ error: "Choose a bank." });
  if (!Number.isFinite(cents) || cents < 1 || cents > 100000000000) {
    return res.status(400).json({ error: "Enter a valid amount." });
  }
  if (cents > balanceOf(userId)) {
    return res.status(400).json({ error: "Not enough funds. Enter a smaller amount." });
  }

  // Sending to another BAXONN account? Find it first.
  let recipient = null;
  if (bank === "BAXONN BANK") {
    recipient = db.prepare("SELECT id, name FROM users WHERE account_number = ?").get(acct);
    if (!recipient) return res.status(400).json({ error: "BAXONN BANK account not found." });
    if (recipient.id === userId) return res.status(400).json({ error: "You can't send money to your own account." });
  }

  const err = checkCode(req, req.body.code);
  if (err) return res.status(403).json({ error: err });

  let ok;
  if (recipient) {
    const sender = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
    ok = transferInternal(
      userId, recipient.id, cents,
      "Transfer to " + recipient.name + " (BAXONN BANK " + acct + ")",
      "Received from " + sender.name
    );
    if (ok) io.to("user:" + recipient.id).emit("account:update");
  } else {
    ok = spend(userId, cents, "Transfer to " + bank + " " + acct);
  }
  if (!ok) return res.status(400).json({ error: "Not enough funds. Enter a smaller amount." });
  res.json({ ok: true });
});

// ---- Buy stock (the server decides the price) ----
app.post("/api/buy-stock", requireLoginApi, (req, res) => {
  const name = String(req.body.stock || "");
  const qty = Number(req.body.qty);
  if (!Object.prototype.hasOwnProperty.call(STOCKS, name)) {
    return res.status(400).json({ error: "Choose a stock." });
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) {
    return res.status(400).json({ error: "Enter a whole number of shares." });
  }
  const cents = STOCKS[name] * 100 * qty;
  if (!spend(req.session.userId, cents, "Bought " + qty + " x " + name)) {
    return res.status(400).json({ error: "Not enough funds. Enter a smaller amount." });
  }
  res.json({ ok: true });
});

setupChat({ app, io, db, crypto, sessionMiddleware });

server.listen(PORT, () => {
  console.log("Server running at http://localhost:" + PORT);
});