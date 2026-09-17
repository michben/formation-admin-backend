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
    CREATE TABLE IF NOT EXISTS visitor_state (
      visitor_id TEXT PRIMARY KEY,
      awaiting TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
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

// --- Agent de conversation (repond automatiquement si possible, sinon transmet a l'admin) ---
// Regles derivees du guide de configuration fourni par le formateur : tarifs, zone Ile-de-France,
// mineurs, securite (jamais de mot de passe/cle API), qualification de lead, transmission a l'admin.

const IDF_DEPTS = ["75", "77", "78", "91", "92", "93", "94", "95"];
const IDF_CITIES = ["paris", "versailles", "boulogne", "nanterre", "creteil", "cergy", "evry", "meaux", "melun", "saint-denis", "montreuil", "asnieres", "argenteuil", "courbevoie", "issy", "clichy", "vincennes", "levallois", "maisons-alfort", "ivry"];
const NON_IDF_CITIES = ["lyon", "marseille", "toulouse", "bordeaux", "lille", "nice", "nantes", "strasbourg", "rennes", "montpellier", "grenoble", "toulon", "reims", "dijon", "angers", "le havre", "saint-etienne", "brest", "limoges", "tours", "amiens", "perpignan", "metz", "besancon", "orleans", "rouen", "mulhouse", "caen", "nancy", "avignon"];

const FAQ_RULES = [
  { keywords: ["prix", "tarif", "cout", "combien"], answer: "Chaque formation coûte 250€ (Claude Code, ou Fly Connectome). Le Pack des deux formations est à 400€ au lieu de 500€ : c'est l'offre du moment, avec 100€ de réduction. Vous pouvez réserver depuis la section Tarifs de la page." },
  { keywords: ["calendly", "rendez-vous", "rendez vous", "creneau", "reserver un appel"], answer: "Vous pouvez réserver un appel découverte gratuit ici : https://calendly.com/michben" },
  { keywords: ["connectome", "mouche"], answer: "La formation Fly Connectome présente le connectome de la mouche, les graphes neuronaux et l'IA bio-inspirée : installation de l'environnement, visualisation et première expérimentation. L'environnement exact est confirmé avant la prestation." },
  { keywords: ["claude code", "terminal"], answer: "La formation Claude Code couvre la découverte de l'IA, l'utilisation du terminal, l'installation, la configuration, la définition d'un projet, les prompts, les tests, la documentation et une initiation à Git." },
  { keywords: ["installation", "materiel", "abonnement", "logiciel necessaire"], answer: "L'accompagnement à l'installation et à la configuration fait partie de la formation. Les éventuels abonnements, logiciels ou comptes nécessaires peuvent être distincts du prix — michben vous le précisera après vérification." },
  { keywords: ["garantie", "resultat", "vraiment autonome"], answer: "La formation vise à vous rendre progressivement autonome et à réaliser un premier projet accompagné. Le résultat dépend aussi de votre pratique personnelle." },
  { keywords: ["code d'acces", "code d acces", "espace formation", "lien prive", "mon acces"], answer: "Après réception de votre paiement, vous recevez par email un lien privé et un code d'accès personnel pour l'espace de formation." },
  { keywords: ["merci", "parfait", "super", "cool"], answer: "Avec plaisir 🙂 N'hésitez pas si vous avez d'autres questions !" },
  { keywords: ["bonjour", "salut", "hello", "bonsoir", "coucou"], answer: "Bonjour ! 👋 Posez votre question sur les formations, je réponds automatiquement si possible, sinon michben vous répondra directement ici." },
];

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function detectZone(text) {
  const norm = normalize(text);
  const postalMatch = norm.match(/\b(\d{5})\b/);
  if (postalMatch) {
    return IDF_DEPTS.includes(postalMatch[1].slice(0, 2)) ? "idf" : "hors";
  }
  if (IDF_CITIES.some((c) => norm.includes(c))) return "idf";
  if (NON_IDF_CITIES.some((c) => norm.includes(c))) return "hors";
  return null;
}

function detectMinor(text) {
  const norm = normalize(text);
  if (/\bmineur|mon fils|ma fille|mon enfant\b/.test(norm)) return true;
  const ageMatch = norm.match(/\b(\d{1,2})\s*an[s]?\b/);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age > 0 && age < 18) return true;
  }
  return false;
}

async function getAwaiting(visitorId) {
  const res = await pool.query(`SELECT awaiting FROM visitor_state WHERE visitor_id = $1`, [visitorId]);
  return res.rows[0]?.awaiting || null;
}

async function setAwaiting(visitorId, awaiting) {
  await pool.query(
    `INSERT INTO visitor_state (visitor_id, awaiting, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (visitor_id) DO UPDATE SET awaiting = $2, updated_at = now()`,
    [visitorId, awaiting]
  );
}

async function processMessage(visitorId, body) {
  const norm = normalize(body);

  // Securite : ne jamais demander/accepter mot de passe, cle API, coordonnees bancaires.
  if (/\b(mot de passe|cle api|cl e api|api key|coordonnees bancaires|numero de carte|cvv)\b/.test(norm)) {
    return { answer: "Je ne dois jamais demander ni recevoir de mot de passe, clé API ou coordonnées bancaires : ces informations restent strictement confidentielles.", needsHuman: false };
  }

  const awaiting = await getAwaiting(visitorId);

  // Etat : on attendait une commune/code postal pour le presentiel ou les frais de deplacement.
  if (awaiting === "commune") {
    const zone = detectZone(body);
    if (zone === "idf") {
      await setAwaiting(visitorId, null);
      return { answer: "Très bien, c'est en Île-de-France : le présentiel est possible. Les éventuels frais de déplacement seront étudiés selon l'adresse exacte et validés par michben avant toute confirmation. Je transmets votre demande.", needsHuman: true };
    }
    if (zone === "hors") {
      await setAwaiting(visitorId, null);
      return { answer: "Le présentiel est actuellement limité à l'Île-de-France, donc ce ne sera pas possible pour cette commune. Je vous propose plutôt une formation à distance !", needsHuman: false };
    }
    return { answer: "Je n'ai pas reconnu la commune. Pouvez-vous indiquer votre code postal ?", needsHuman: false };
  }

  // Etat : on attendait les informations de qualification (fiche de transmission).
  if (awaiting === "lead") {
    await setAwaiting(visitorId, null);
    return { answer: "Merci ! J'ai bien transmis toutes ces informations à michben, qui va revenir vers vous directement ici.", needsHuman: true };
  }

  if (detectMinor(body)) {
    return { answer: "La formation est principalement destinée aux adultes. Pour un mineur, l'accord d'un responsable légal est nécessaire, ainsi qu'une validation de michben. Je transmets votre demande pour étude.", needsHuman: true };
  }

  if (/\bpresentiel|a domicile|chez moi\b/.test(norm) && !/\bdistanciel|visio\b/.test(norm)) {
    await setAwaiting(visitorId, "commune");
    return { answer: "Oui, une formation en présentiel est actuellement possible en Île-de-France uniquement. Quelle est votre commune ou votre code postal, pour vérifier la faisabilité ?", needsHuman: false };
  }

  if (/\bfrais de deplacement|frais de deplacements\b/.test(norm)) {
    await setAwaiting(visitorId, "commune");
    return { answer: "Les frais de déplacement dépendent de la zone, de la distance et du transport — je ne peux pas inventer un montant. Quelle est votre commune ou code postal, pour que michben étudie ça avec vous ?", needsHuman: false };
  }

  if (/\bdistanciel|visio\b/.test(norm)) {
    return { answer: "Oui, la formation est possible à distance en visioconférence, quelle que soit votre localisation.", needsHuman: false };
  }

  if (/\bpayer maintenant|payer ici|payer dans le chat|puis-je payer\b/.test(norm)) {
    return { answer: "Le paiement se fait uniquement via les boutons \"Réserver\" du site (paiement sécurisé Stripe) — je ne traite pas de paiement ici dans le chat.", needsHuman: false };
  }

  if (/\bclaude peut-il tout faire|l'ia peut-elle tout faire|tout faire seul\b/.test(norm)) {
    return { answer: "L'IA vous aide beaucoup, mais vous restez toujours celui qui vérifie et valide le travail réalisé — c'est justement ce qu'on apprend pendant la formation.", needsHuman: false };
  }

  if (/\bprogrammer|coder|competence|debutant|y connais rien\b/.test(norm)) {
    return { answer: "Non, aucune compétence en programmation n'est requise. Les formations sont conçues pour les débutants, avec une installation guidée et des explications progressives.", needsHuman: false };
  }

  if (/\bage faut-il|quel age\b/.test(norm)) {
    return { answer: "La formation est principalement destinée aux adultes. Pour un mineur, une participation peut être étudiée avec l'accord d'un responsable légal et une validation de michben.", needsHuman: false };
  }

  if (/\binscri|je suis interess|comment participer|comment reserver\b/.test(norm)) {
    await setAwaiting(visitorId, "lead");
    return {
      answer: "Super ! Pour transmettre votre demande à michben, pouvez-vous indiquer : votre prénom, votre email, la formation souhaitée (Claude Code / Fly Connectome / Pack), votre objectif, le format souhaité (distance ou présentiel), votre commune si présentiel, et vos disponibilités ?",
      needsHuman: false,
    };
  }

  for (const rule of FAQ_RULES) {
    if (rule.keywords.some((k) => norm.includes(normalize(k)))) {
      return { answer: rule.answer, needsHuman: false };
    }
  }

  return {
    answer: "Merci pour votre message ! Je transmets votre question à michben qui vous répondra ici dès que possible.",
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

  const auto = await processMessage(visitor_id, body);
  await pool.query(
    `INSERT INTO chat_messages (visitor_id, sender, body, needs_human) VALUES ($1,'agent',$2,$3)`,
    [visitor_id, auto.answer, auto.needsHuman]
  );

  res.json({ visitor_id, reply: auto.answer, needs_human: auto.needsHuman });
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
