// chat.js - live customer chat (Socket.IO)
module.exports = function setupChat({ app, io, db, crypto, sessionMiddleware }) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Staff password: set ADMIN_PASSWORD in your environment, or a random one is printed at start.
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("hex");
  if (!process.env.ADMIN_PASSWORD) console.log("Staff chat password for this run: " + ADMIN_PASSWORD);

  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
  const goodPassword = (p) => crypto.timingSafeEqual(digest(p), digest(ADMIN_PASSWORD));

  function history(userId) {
    return db.prepare(`SELECT id, user_id, sender, text, created_at FROM
      (SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100) ORDER BY id ASC`).all(userId);
  }
  function save(userId, sender, text) {
    const info = db.prepare("INSERT INTO chat_messages (user_id, sender, text) VALUES (?, ?, ?)")
      .run(userId, sender, text);
    return { id: Number(info.lastInsertRowid), user_id: userId, sender: sender, text: text };
  }

  // ---- Staff login and inbox (HTTP) ----
  function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) return res.status(401).json({ error: "Staff login required." });
    next();
  }

  app.post("/api/admin-login", (req, res) => {
    const s = req.session;
    s.adminTries = (s.adminTries || 0) + 1;
    if (s.adminTries > 10) return res.status(429).json({ error: "Too many tries. Restart the browser and try again." });
    if (!goodPassword(req.body.password)) return res.status(401).json({ error: "Wrong password." });
    s.adminTries = 0;
    s.isAdmin = true;
    res.json({ ok: true });
  });
  app.get("/api/admin-me", requireAdmin, (req, res) => res.json({ ok: true }));
  app.post("/api/admin-logout", (req, res) => {
    delete req.session.isAdmin;
    res.json({ ok: true });
  });

  app.get("/api/admin/conversations", requireAdmin, (req, res) => {
    const rows = db.prepare(`
      SELECT u.id AS user_id, u.name, u.email,
        (SELECT text FROM chat_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_text,
        (SELECT MAX(id) FROM chat_messages WHERE user_id = u.id) AS last_id
      FROM users u
      WHERE EXISTS (SELECT 1 FROM chat_messages WHERE user_id = u.id)
      ORDER BY last_id DESC
    `).all();
    res.json(rows);
  });

  app.get("/api/admin/messages/:userId", requireAdmin, (req, res) => {
    const id = Number(req.params.userId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id." });
    res.json(history(id));
  });

  // ---- Live messages (Socket.IO) ----
  io.engine.use(sessionMiddleware); // sockets share the same login session as the pages

  io.on("connection", (socket) => {
    const session = socket.request.session;
    const userId = session && session.userId;
    const isAdmin = session && session.isAdmin;
    if (!userId && !isAdmin) {
      socket.disconnect(true);
      return;
    }

    let last = 0;
    const tooFast = () => {
      const now = Date.now();
      if (now - last < 500) return true;
      last = now;
      return false;
    };
    const clean = (t) => String(t || "").trim().slice(0, 500);

    if (userId) {
      socket.join("user:" + userId);
      socket.emit("chat:history", history(userId));
      socket.on("chat:send", (text) => {
        text = clean(text);
        if (!text || tooFast()) return;
        const m = save(userId, "customer", text);
        io.to("user:" + userId).emit("chat:message", m);
        io.to("agents").emit("agent:message", m);
      });
    }

    if (isAdmin) {
      socket.join("agents");
      socket.on("agent:reply", (data) => {
        const target = Number(data && data.userId);
        const text = clean(data && data.text);
        if (!Number.isInteger(target) || !text || tooFast()) return;
        if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(target)) return;
        const m = save(target, "agent", text);
        io.to("user:" + target).emit("chat:message", m);
        io.to("agents").emit("agent:message", m);
      });
    }
  });
};