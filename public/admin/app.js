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
  loadConversations();
  setInterval(loadConversations, 20000);
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

// --- Messages / conversations ------------------------------------------
let messagesPollTimer = null;

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function loadConversations() {
  const res = await authedFetch("/api/admin/conversations");
  const conversations = await res.json();
  renderConversations(conversations);

  const needsHumanCount = conversations.filter((c) => c.needs_human).length;
  const badge = document.getElementById("messages-badge");
  if (needsHumanCount > 0) {
    badge.textContent = needsHumanCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function renderConversations(conversations) {
  const list = document.getElementById("conv-list");
  if (conversations.length === 0) {
    list.innerHTML = "<p style='color:var(--muted);'>Aucun message pour le moment.</p>";
    return;
  }
  list.innerHTML = conversations
    .map(
      (c) => `<div class="conv-item ${c.needs_human ? "needs-human" : ""}" data-visitor="${c.visitor_id}">
        <div>
          <div class="conv-name">${escapeHtml(c.visitor_name || "Visiteur anonyme")} ${c.needs_human ? "🔴" : ""}</div>
          <div class="conv-preview">${escapeHtml(c.last_message)}</div>
        </div>
        <div style="color:var(--muted); font-size:0.78rem; white-space:nowrap;">${formatDateTime(c.last_at)}</div>
      </div>`
    )
    .join("");

  list.querySelectorAll("[data-visitor]").forEach((el) => {
    el.addEventListener("click", () => openConversation(el.dataset.visitor));
  });
}

async function openConversation(visitorId) {
  document.getElementById("conv-list-card").classList.add("hidden");
  const threadCard = document.getElementById("conv-thread-card");
  threadCard.classList.remove("hidden");
  threadCard.dataset.visitor = visitorId;

  await refreshThread(visitorId);
  clearInterval(messagesPollTimer);
  messagesPollTimer = setInterval(() => refreshThread(visitorId), 8000);
}

async function refreshThread(visitorId) {
  const res = await authedFetch(`/api/admin/conversations/${encodeURIComponent(visitorId)}`);
  const messages = await res.json();
  const box = document.getElementById("conv-thread-box");
  box.innerHTML = messages
    .map(
      (m) => `<div class="thread-msg ${m.sender}">
        ${m.sender !== "visitor" ? `<span class="m-sender">${m.sender === "admin" ? "Vous" : "Assistant"}</span>` : ""}
        ${escapeHtml(m.body)}
      </div>`
    )
    .join("");
  box.scrollTop = box.scrollHeight;
}

function closeConversation() {
  clearInterval(messagesPollTimer);
  document.getElementById("conv-thread-card").classList.add("hidden");
  document.getElementById("conv-list-card").classList.remove("hidden");
  loadConversations();
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

  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".nav-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.section).classList.add("active");
      if (tab.dataset.section === "section-messages") loadConversations();
    });
  });

  document.getElementById("conv-back").addEventListener("click", closeConversation);

  document.getElementById("conv-reply-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("conv-reply-input");
    const text = input.value.trim();
    if (!text) return;
    const visitorId = document.getElementById("conv-thread-card").dataset.visitor;
    input.value = "";
    await authedFetch(`/api/admin/conversations/${encodeURIComponent(visitorId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text }),
    });
    refreshThread(visitorId);
  });
});
