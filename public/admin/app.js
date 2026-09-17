const API_BASE = ""; // same origin (this admin page is served by the API itself)
const TOKEN_KEY = "mb_admin_token";

const FORMATION_LABELS = {
  claude_code: "Claude Code",
  fly_connectome: "Fly Connectome",
  pack: "Pack des deux",
};
const QUIZ_LABELS = {
  claude_code: "Quiz Claude Code",
  fly_connectome: "Quiz Fly Connectome",
  mixte: "Quiz Mixte",
};

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function showDashboard() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
  loadStudents();
}

async function login(password) {
  const res = await fetch(`${API_BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error("Mot de passe incorrect");
  const data = await res.json();
  sessionStorage.setItem(TOKEN_KEY, data.token);
}

async function authedFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${getToken()}`,
    },
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
    throw new Error("session expirée");
  }
  return res;
}

async function loadStudents() {
  const res = await authedFetch("/api/admin/students");
  const students = await res.json();
  renderStudents(students);
}

function renderStudents(students) {
  const container = document.getElementById("students-table");
  if (students.length === 0) {
    container.innerHTML = "<p style='color:var(--muted);'>Aucun élève pour le moment.</p>";
    return;
  }

  let html = `<table><thead><tr>
    <th>Nom</th><th>Email</th><th>Formation</th><th>Quiz</th><th>Ajouté le</th><th></th>
  </tr></thead><tbody>`;

  for (const s of students) {
    const quizPills = (s.quizzes || [])
      .map((q) => `<span class="pill">${QUIZ_LABELS[q.quiz_type] || q.quiz_type}: ${q.best_score}/${q.total}</span>`)
      .join("") || "<span style='color:var(--muted); font-size:0.85rem;'>Aucun quiz fait</span>";

    html += `<tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.email || "—")}</td>
      <td>${FORMATION_LABELS[s.formation] || s.formation || "—"}</td>
      <td>${quizPills}</td>
      <td>${new Date(s.created_at).toLocaleDateString("fr-FR")}</td>
      <td><button class="btn-danger" data-delete="${s.id}">Supprimer</button></td>
    </tr>`;
  }
  html += "</tbody></table>";
  container.innerHTML = html;

  container.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Supprimer cet élève ? Son code d'accès ne fonctionnera plus.")) return;
      await authedFetch(`/api/admin/students/${btn.dataset.delete}`, { method: "DELETE" });
      loadStudents();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", () => {
  if (getToken()) showDashboard();

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const error = document.getElementById("login-error");
    error.textContent = "";
    try {
      await login(document.getElementById("password").value);
      showDashboard();
    } catch (err) {
      error.textContent = "Mot de passe incorrect.";
    }
  });

  document.getElementById("logout-btn").addEventListener("click", () => {
    sessionStorage.removeItem(TOKEN_KEY);
    location.reload();
  });

  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("add-error");
    errorEl.textContent = "";
    const name = document.getElementById("s-name").value;
    const email = document.getElementById("s-email").value;
    const formation = document.getElementById("s-formation").value;

    try {
      const res = await authedFetch("/api/admin/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, formation }),
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      document.getElementById("new-code").textContent = data.code;
      document.getElementById("code-modal").classList.add("show");
      document.getElementById("add-form").reset();
      loadStudents();
    } catch (err) {
      errorEl.textContent = "Erreur lors de l'ajout de l'élève.";
    }
  });

  document.getElementById("copy-code-btn").addEventListener("click", () => {
    const code = document.getElementById("new-code").textContent;
    navigator.clipboard?.writeText(code);
  });

  document.getElementById("close-modal-btn").addEventListener("click", () => {
    document.getElementById("code-modal").classList.remove("show");
  });
});
