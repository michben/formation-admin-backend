import express from "express";
import cors from "cors";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  })
);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const adminSessions = new Map(); // token -> expiry timestamp

function sha256(text) {
  return crypto.createHash("sha256").update(String(text).trim().toUpperCase()).digest("hex");
}
function randomCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}
function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      formation TEXT,
      code_hash TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS student_sessions (
      token TEXT PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS quiz_results (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      quiz_type TEXT NOT NULL,
      score INTEGER NOT NULL,
      total INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      visitor_name TEXT,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      needs_human BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_visitor ON chat_messages(visitor_id, created_at);
  `);

  const legacyHash = sha256("MICHBEN-CLAUDE-2026");
  await pool.query(
    `INSERT INTO students (name, email, formation, code_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code_hash) DO NOTHING`,
    ["Accès général (lien historique)", null, "pack", legacyHash]
  );
}

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const expiry = adminSessions.get(token);
  if (!expiry || expiry < Date.now()) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "formation-admin-backend" });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "invalid password" });
  }
  const token = randomToken();
  adminSessions.set(token, Date.now() + 12 * 3600 * 1000);
  res.json({ token });
});

app.get("/api/admin/students", requireAdmin, async (req, res) => {
  const students = await pool.query(
    `SELECT id, name, email, formation, created_at FROM students ORDER BY created_at DESC`
  );
  const results = await pool.query(`
    SELECT student_id, quiz_type, MAX(score) AS best_score, MAX(total) AS total, COUNT(*) AS attempts
    FROM quiz_results GROUP BY student_id, quiz_type
  `);
  const byStudent = {};
  for (const r of results.rows) {
    (byStudent[r.student_id] ||= []).push(r);
  }
  res.json(students.rows.map((s) => ({ ...s, quizzes: byStudent[s.id] || [] })));
});

app.post("/api/admin/students", requireAdmin, async (req, res) => {
  const { name, email, formation } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name required" });

  const code = randomCode();
  const codeHash = sha256(code);
  try {
    const result = await pool.query(
      `INSERT INTO students (name, email, formation, code_hash) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [name.trim(), email ? email.trim() : null, formation || null, codeHash]
    );
    res.json({ id: result.rows[0].id, code });
  } catch (err) {
    res.status(500).json({ error: "could not create student" });
  }
});

app.delete("/api/admin/students/:id", requireAdmin, async (req, res) => {
  await pool.query(`DELETE FROM students WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/verify-code", async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.json({ valid: false });

  const hash = sha256(code);
  const result = await pool.query(`SELECT id, name FROM students WHERE code_hash = $1`, [hash]);
  if (result.rows.length === 0) return res.json({ valid: false });

  const student = result.rows[0];
  const token = randomToken();
  await pool.query(`INSERT INTO student_sessions (token, student_id) VALUES ($1, $2)`, [token, student.id]);
  res.json({ valid: true, token, name: student.name });
});

app.post("/api/quiz-result", async (req, res) => {
  const { token, quiz_type, score, total } = req.body || {};
  if (!token || !quiz_type || typeof score !== "number" || typeof total !== "number") {
    return res.status(400).json({ error: "invalid payload" });
  }
  const session = await pool.query(`SELECT student_id FROM student_sessions WHERE token = $1`, [token]);
  if (session.rows.length === 0) return res.status(401).json({ error: "invalid token" });

  await pool.query(
    `INSERT INTO quiz_results (student_id, quiz_type, score, total) VALUES ($1,$2,$3,$4)`,
    [session.rows[0].student_id, quiz_type, score, total]
  );
  res.json({ ok: true });
});

// --- Agent de conversation (repond automatiquement si possible, sinon transmet a l'admin) ---
const FAQ_RULES = [
  { keywords: ["prix", "tarif", "cout", "combien"], answer: "Nos tarifs : Claude Code dans le terminal (250€), Fly Connectome (250€), ou le Pack des deux formations (400€ au lieu de 500€, offre de lancement). Vous pouvez réserver depuis la section Tarifs de la page." },
  { keywords: ["presentiel", "distanciel", "visio", "domicile"], answer: "La formation est possible en visioconférence à distance, ou en présentiel selon votre zone géographique." },
  { keywords: ["paiement", "payer", "stripe", "carte bancaire"], answer: "Le paiement se fait de façon sécurisée via Stripe, directement depuis les boutons \"Réserver\" de la page." },
  { keywords: ["code d'acces", "code d acces", "espace formation", "lien prive", "mon acces"], answer: "Après réception de votre paiement, vous recevez par email un lien privé et un code d'accès personnel pour l'espace de formation." },
  { keywords: ["calendly", "rendez-vous", "rendez vous", "creneau", "reserver un appel"], answer: "Vous pouvez réserver un appel découverte gratuit ici : https://calendly.com/michben" },
  { keywords: ["connectome", "mouche", "fly"], answer: "La formation Fly Connectome aborde le connectome de la mouche et l'IA bio-inspirée : représentation en graphe, simulation et apprentissage." },
  { keywords: ["claude code", "terminal", "installation"], answer: "La formation Claude Code dans le terminal couvre l'installation, la prise en main, la création d'un projet accompagné et le suivi avec Git." },
  { keywords: ["merci", "parfait", "super"], answer: "Avec plaisir 🙂 N'hésitez pas si vous avez d'autres questions !" },
  { keywords: ["bonjour", "salut", "hello", "bonsoir", "coucou"], answer: "Bonjour ! 👋 Posez votre question sur les formations, je réponds automatiquement si possible, sinon michben vous répondra directement ici." },
];

function normalize(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function autoAnswer(body) {
  const text = normalize(body);
  for (const rule of FAQ_RULES) {
    if (rule.keywords.some((k) => text.includes(normalize(k)))) {
      return { body: rule.answer, needsHuman: false };
    }
  }
  return {
    body: "Merci pour votre message ! Je transmets votre question à michben qui vous répondra ici dès que possible.",
    needsHuman: true,
  };
}

app.post("/api/chat/message", async (req, res) => {
  let { visitor_id, visitor_name, body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: "empty message" });
  if (!visitor_id) visitor_id = crypto.randomUUID();

  await pool.query(
    `INSERT INTO chat_messages (visitor_id, visitor_name, sender, body) VALUES ($1,$2,'visitor',$3)`,
    [visitor_id, visitor_name ? String(visitor_name).trim() : null, String(body).trim()]
  );

  const auto = autoAnswer(body);
  await pool.query(
    `INSERT INTO chat_messages (visitor_id, sender, body, needs_human) VALUES ($1,'agent',$2,$3)`,
    [visitor_id, auto.body, auto.needsHuman]
  );

  res.json({ visitor_id, reply: auto.body, needs_human: auto.needsHuman });
});

app.get("/api/chat/messages", async (req, res) => {
  const { visitor_id } = req.query;
  if (!visitor_id) return res.status(400).json({ error: "visitor_id required" });
  const result = await pool.query(
    `SELECT sender, body, created_at FROM chat_messages WHERE visitor_id = $1 ORDER BY created_at ASC`,
    [visitor_id]
  );
  res.json(result.rows);
});

app.get("/api/admin/conversations", requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT c.visitor_id, c.last_sender, c.last_message, c.needs_human, c.last_at, n.visitor_name
    FROM (
      SELECT DISTINCT ON (visitor_id) visitor_id, sender AS last_sender, body AS last_message,
             needs_human, created_at AS last_at
      FROM chat_messages ORDER BY visitor_id, created_at DESC
    ) c
    LEFT JOIN (
      SELECT visitor_id, MAX(visitor_name) AS visitor_name
      FROM chat_messages WHERE visitor_name IS NOT NULL GROUP BY visitor_id
    ) n ON n.visitor_id = c.visitor_id
    ORDER BY c.last_at DESC
  `);
  res.json(
    result.rows.map((r) => ({
      ...r,
      needs_human: r.last_sender === "agent" && r.needs_human === true,
    }))
  );
});

app.get("/api/admin/conversations/:visitorId", requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT sender, body, created_at FROM chat_messages WHERE visitor_id = $1 ORDER BY created_at ASC`,
    [req.params.visitorId]
  );
  res.json(result.rows);
});

app.post("/api/admin/conversations/:visitorId/reply", requireAdmin, async (req, res) => {
  const { body } = req.body || {};
  if (!body || !String(body).trim()) return res.status(400).json({ error: "empty" });
  await pool.query(`INSERT INTO chat_messages (visitor_id, sender, body) VALUES ($1,'admin',$2)`, [
    req.params.visitorId,
    String(body).trim(),
  ]);
  res.json({ ok: true });
});

app.use("/admin", express.static("public/admin"));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
initDb()
  .then(() => app.listen(PORT, () => console.log("listening on " + PORT)))
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });
