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

app.use("/admin", express.static("public/admin"));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;
initDb()
  .then(() => app.listen(PORT, () => console.log("listening on " + PORT)))
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });
