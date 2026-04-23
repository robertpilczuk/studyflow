// ═══════════════════════════════════════════════════════
// STUDYFLOW — app.js
// Logika aplikacji wykorzystująca 6 usług Firebase
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb, trackEvent, loadRemoteConfig
} from "./firebase-config.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  collection, addDoc, getDocs, deleteDoc, doc, updateDoc,
  query, where, orderBy, serverTimestamp, onSnapshot,
  increment, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  ref, push, onValue, serverTimestamp as rtdbTimestamp, set
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ─────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────
let currentUser = null;
let rcConfig = {};
let editingNoteId = null;
let quizQuestions = [];          // tymczasowo przy budowaniu quizu
let playerState = {};          // stan quiz playera
let analyticsEvents = [];
let firestoreUnsub = null;

// ─────────────────────────────────────────────────────
// BOOTSTRAP — inicjalizacja po załadowaniu strony
// ─────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {

  // 4️⃣  Remote Config — ładuj zanim cokolwiek pokażemy
  rcConfig = await loadRemoteConfig();
  renderRemoteConfig();

  // 1️⃣  Firebase Auth — obserwuj stan logowania
  onAuthStateChanged(auth, user => {
    if (user) {
      currentUser = user;
      showApp();
    } else {
      currentUser = null;
      showAuth();
    }
  });
});

// ─────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  document.getElementById("login-form").style.display = tab === "login" ? "" : "none";
  document.getElementById("register-form").style.display = tab === "register" ? "" : "none";
  document.getElementById("auth-error").textContent = "";
}
window.switchAuthTab = switchAuthTab;

async function registerUser() {
  const name = document.getElementById("reg-name").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const pass = document.getElementById("reg-password").value;
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";

  if (!name || !email || !pass) return errEl.textContent = "Uzupełnij wszystkie pola.";

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });

    // Zapisz profil użytkownika w Firestore
    await setDoc(doc(db, "users", cred.user.uid), {
      name, email,
      createdAt: serverTimestamp(),
      notesCount: 0, quizzesCount: 0, attempts: 0, totalScore: 0
    });

    // 5️⃣  Analytics — rejestruj rejestrację
    trackAnalytics("sign_up", { method: "email" });
    showToast("Konto utworzone!", "success");
  } catch (e) {
    errEl.textContent = translateAuthError(e.code);
  }
}
window.registerUser = registerUser;

async function loginUser() {
  const email = document.getElementById("login-email").value.trim();
  const pass = document.getElementById("login-password").value;
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    trackAnalytics("login", { method: "email" });
  } catch (e) {
    errEl.textContent = translateAuthError(e.code);
  }
}
window.loginUser = loginUser;

async function logoutUser() {
  trackAnalytics("logout", {});
  if (firestoreUnsub) firestoreUnsub();
  await signOut(auth);
}
window.logoutUser = logoutUser;

function translateAuthError(code) {
  const map = {
    "auth/email-already-in-use": "Ten e-mail jest już zajęty.",
    "auth/invalid-email": "Nieprawidłowy format e-maila.",
    "auth/weak-password": "Hasło musi mieć min. 6 znaków.",
    "auth/user-not-found": "Nie znaleziono użytkownika.",
    "auth/wrong-password": "Błędne hasło.",
    "auth/invalid-credential": "Nieprawidłowe dane logowania.",
    "auth/network-request-failed": "Brak połączenia z internetem."
  };
  return map[code] || `Błąd: ${code}`;
}

// ─────────────────────────────────────────────────────
// UI TRANSITIONS
// ─────────────────────────────────────────────────────
function showAuth() {
  document.getElementById("auth-screen").style.display = "";
  document.getElementById("app").style.display = "none";
}

function showApp() {
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").style.display = "flex";

  // Uzupełnij dane usera w sidebarze
  const name = currentUser.displayName || currentUser.email;
  document.getElementById("user-display-name").textContent = name;
  document.getElementById("user-display-email").textContent = currentUser.email;
  document.getElementById("user-avatar").textContent = name.charAt(0).toUpperCase();

  // Remote Config — wyłącz sekcję quizów jeśli skonfigurowane
  if (!rcConfig.quizzes_enabled) {
    document.querySelector('[onclick="showSection(\'quizzes\')"]').style.opacity = "0.4";
    document.querySelector('[onclick="showSection(\'quizzes\')"]').style.pointerEvents = "none";
  }

  initRealtimeDB();
  loadDashboard();
  showSection("dashboard");
}

window.showSection = function (name) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById(`section-${name}`).classList.add("active");
  document.querySelectorAll(`.nav-item`).forEach(n => {
    if (n.getAttribute("onclick")?.includes(name)) n.classList.add("active");
  });

  if (name === "notes") loadNotes();
  if (name === "quizzes") loadQuizzes();
  if (name === "analytics") renderAnalyticsSection();

  trackAnalytics("page_view", { page: name });
};

// ─────────────────────────────────────────────────────
// 3️⃣  REALTIME DATABASE — feed aktywności
// ─────────────────────────────────────────────────────
function initRealtimeDB() {
  const feedRef = ref(rtdb, `activity/${currentUser.uid}`);

  onValue(feedRef, snapshot => {
    const data = snapshot.val() || {};
    const entries = Object.values(data)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 10);

    const feed = document.getElementById("activity-feed");
    if (!entries.length) {
      feed.innerHTML = `<span style="font-size:12px;color:var(--text-3)">Brak aktywności</span>`;
      return;
    }
    feed.innerHTML = entries.map(e => `
      <div class="activity-item">
        <span class="activity-dot"></span>
        <span>${e.msg}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--text-3)">${formatTime(e.ts)}</span>
      </div>
    `).join("");
  });
}

function pushActivity(msg) {
  const feedRef = ref(rtdb, `activity/${currentUser.uid}`);
  push(feedRef, { msg, ts: Date.now() });
}

// ─────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────
async function loadDashboard() {
  const uid = currentUser.uid;

  // Statystyki z Firestore
  const userDoc = await getDoc(doc(db, "users", uid));
  if (userDoc.exists()) {
    const d = userDoc.data();
    document.getElementById("stat-notes").textContent = d.notesCount || 0;
    document.getElementById("stat-quizzes").textContent = d.quizzesCount || 0;
    document.getElementById("stat-attempts").textContent = d.attempts || 0;
    const avg = d.attempts ? Math.round((d.totalScore / d.attempts) * 100) + "%" : "—";
    document.getElementById("stat-avg").textContent = avg;
  }

  // Ostatnie notatki
  const notesQ = query(
    collection(db, "notes"),
    where("uid", "==", uid),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(notesQ);
  const recentEl = document.getElementById("recent-notes-list");
  const notes = [];
  snap.forEach(d => notes.push({ id: d.id, ...d.data() }));

  if (!notes.length) {
    recentEl.innerHTML = `<span style="font-size:12px;color:var(--text-3)">Brak notatek</span>`;
  } else {
    recentEl.innerHTML = notes.slice(0, 4).map(n => `
      <div class="item-row">
        <div class="item-row-icon">📝</div>
        <span class="item-row-title">${esc(n.title)}</span>
        <span class="item-row-meta">${formatDate(n.createdAt)}</span>
      </div>
    `).join("");
  }
}

// ─────────────────────────────────────────────────────
// 2️⃣  NOTATKI — Cloud Firestore
// ─────────────────────────────────────────────────────
async function loadNotes() {
  const uid = currentUser.uid;
  const q = query(
    collection(db, "notes"),
    where("uid", "==", uid),
    orderBy("createdAt", "desc")
  );

  // Realtime listener
  if (firestoreUnsub) firestoreUnsub();
  firestoreUnsub = onSnapshot(q, snapshot => {
    const notes = [];
    snapshot.forEach(d => notes.push({ id: d.id, ...d.data() }));
    renderNotes(notes);
    document.getElementById("stat-notes").textContent = notes.length;
  });
}

function renderNotes(notes) {
  const grid = document.getElementById("notes-grid");
  const empty = document.getElementById("notes-empty");

  if (!notes.length) {
    grid.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  grid.innerHTML = notes.map(n => `
    <div class="note-card">
      <p class="note-card-title">${esc(n.title)}</p>
      <p class="note-card-content">${esc(n.content)}</p>
      <div class="note-card-footer">
        <span class="note-card-date">${formatDate(n.createdAt)}</span>
        <div class="note-card-actions">
          <button class="icon-btn edit" title="Edytuj" onclick="editNote('${n.id}','${esc(n.title)}','${esc(n.content).replace(/'/g, "&#39;")}')">✏</button>
          <button class="icon-btn" title="Usuń" onclick="deleteNote('${n.id}')">✕</button>
        </div>
      </div>
    </div>
  `).join("");
}

window.openNoteModal = function () {
  editingNoteId = null;
  document.getElementById("note-modal-title").textContent = "Nowa notatka";
  document.getElementById("note-title-input").value = "";
  document.getElementById("note-content-input").value = "";
  document.getElementById("note-modal").style.display = "flex";
};
window.closeNoteModal = () => { document.getElementById("note-modal").style.display = "none"; };

window.editNote = function (id, title, content) {
  editingNoteId = id;
  document.getElementById("note-modal-title").textContent = "Edytuj notatkę";
  document.getElementById("note-title-input").value = title;
  document.getElementById("note-content-input").value = content;
  document.getElementById("note-modal").style.display = "flex";
};

window.saveNote = async function () {
  const title = document.getElementById("note-title-input").value.trim();
  const content = document.getElementById("note-content-input").value.trim();
  if (!title) return showToast("Wpisz tytuł notatki.", "error");

  // Remote Config — limit notatek
  const userDoc = await getDoc(doc(db, "users", currentUser.uid));
  const notesCount = userDoc.exists() ? userDoc.data().notesCount || 0 : 0;
  if (!editingNoteId && notesCount >= rcConfig.max_notes_per_user) {
    return showToast(`Limit notatek: ${rcConfig.max_notes_per_user} (Remote Config)`, "error");
  }

  if (editingNoteId) {
    await updateDoc(doc(db, "notes", editingNoteId), { title, content, updatedAt: serverTimestamp() });
    pushActivity(`Edytowano notatkę: ${title}`);
    trackAnalytics("note_updated", { title });
    showToast("Notatka zaktualizowana!", "success");
  } else {
    await addDoc(collection(db, "notes"), {
      uid: currentUser.uid, title, content, createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, "users", currentUser.uid), { notesCount: increment(1) });
    pushActivity(`Dodano notatkę: ${title}`);
    trackAnalytics("note_created", { title });
    showToast("Notatka zapisana!", "success");
  }

  closeNoteModal();
  loadDashboard();
};

window.deleteNote = async function (id) {
  if (!confirm("Usunąć notatkę?")) return;
  await deleteDoc(doc(db, "notes", id));
  await updateDoc(doc(db, "users", currentUser.uid), { notesCount: increment(-1) });
  pushActivity("Usunięto notatkę");
  trackAnalytics("note_deleted", {});
  loadDashboard();
  showToast("Notatka usunięta.");
};

// ─────────────────────────────────────────────────────
// QUIZY — Cloud Firestore
// ─────────────────────────────────────────────────────
async function loadQuizzes() {
  const q = query(
    collection(db, "quizzes"),
    where("uid", "==", currentUser.uid),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  const quizzes = [];
  snap.forEach(d => quizzes.push({ id: d.id, ...d.data() }));
  renderQuizzes(quizzes);
}

function renderQuizzes(quizzes) {
  const grid = document.getElementById("quizzes-grid");
  const empty = document.getElementById("quizzes-empty");
  if (!quizzes.length) {
    grid.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";
  grid.innerHTML = quizzes.map(q => `
    <div class="quiz-card">
      <div class="quiz-card-header">
        <p class="quiz-card-title">${esc(q.name)}</p>
        <span class="quiz-badge">${q.questions.length} pytań</span>
      </div>
      <p class="quiz-card-meta">Utworzono: ${formatDate(q.createdAt)}</p>
      <div class="quiz-card-actions">
        <button class="btn-primary sm" onclick="startQuiz('${q.id}')">Rozwiąż</button>
        <button class="btn-ghost" onclick="deleteQuiz('${q.id}')">Usuń</button>
      </div>
    </div>
  `).join("");
}

// ─── QUIZ BUILDER ───
window.openQuizModal = function () {
  if (!rcConfig.quizzes_enabled) return showToast("Quizy wyłączone (Remote Config).", "error");
  quizQuestions = [];
  document.getElementById("quiz-name-input").value = "";
  document.getElementById("questions-builder").innerHTML = "";
  addQuestion();
  document.getElementById("quiz-modal").style.display = "flex";
};
window.closeQuizModal = () => { document.getElementById("quiz-modal").style.display = "none"; };

window.addQuestion = function () {
  const max = rcConfig.max_questions_per_quiz || 20;
  if (quizQuestions.length >= max) return showToast(`Max ${max} pytań (Remote Config).`, "error");

  const idx = quizQuestions.length;
  quizQuestions.push({ text: "", options: ["", "", "", ""], correct: 0 });

  const builder = document.getElementById("questions-builder");
  const block = document.createElement("div");
  block.className = "question-block";
  block.id = `qblock-${idx}`;
  block.innerHTML = `
    <div class="question-block-header">
      <span class="question-num">Pytanie ${idx + 1}</span>
      <button class="icon-btn remove-btn">✕</button>
    </div>
    <div class="field">
      <label>Treść pytania</label>
      <input type="text" class="q-text" placeholder="Wpisz pytanie..." />
    </div>
    <div class="options-grid">
      ${["A", "B", "C", "D"].map((l, i) => `
        <div class="option-input">
          <span class="option-label">${l}</span>
          <input type="text" class="q-opt" data-opt="${i}" placeholder="Odpowiedź ${l}" />
        </div>
      `).join("")}
    </div>
    <div class="field" style="margin-top:8px">
      <label>Poprawna odpowiedź</label>
      <select class="q-correct">
        <option value="0">A</option><option value="1">B</option>
        <option value="2">C</option><option value="3">D</option>
      </select>
    </div>
  `;

  // Event listeners zamiast inline handlers
  block.querySelector(".remove-btn").addEventListener("click", () => {
    block.remove();
    quizQuestions.splice(idx, 1);
  });
  block.querySelector(".q-text").addEventListener("input", e => {
    quizQuestions[idx].text = e.target.value;
  });
  block.querySelectorAll(".q-opt").forEach(input => {
    input.addEventListener("input", e => {
      quizQuestions[idx].options[+e.target.dataset.opt] = e.target.value;
    });
  });
  block.querySelector(".q-correct").addEventListener("change", e => {
    quizQuestions[idx].correct = +e.target.value;
  });

  builder.appendChild(block);
};

window.removeQuestion = function (idx) {
  const block = document.getElementById(`qblock-${idx}`);
  if (block) block.remove();
  quizQuestions.splice(idx, 1);
};

window.saveQuiz = async function () {
  const name = document.getElementById("quiz-name-input").value.trim();
  if (!name) return showToast("Wpisz nazwę quizu.", "error");

  // Walidacja pytań
  const valid = quizQuestions.filter(q => q.text.trim() && q.options.every(o => o.trim()));
  if (!valid.length) return showToast("Dodaj co najmniej jedno kompletne pytanie.", "error");

  await addDoc(collection(db, "quizzes"), {
    uid: currentUser.uid, name, questions: valid, createdAt: serverTimestamp()
  });
  await updateDoc(doc(db, "users", currentUser.uid), { quizzesCount: increment(1) });
  pushActivity(`Utworzono quiz: ${name}`);
  trackAnalytics("quiz_created", { name, question_count: valid.length });
  closeQuizModal();
  loadQuizzes();
  loadDashboard();
  showToast("Quiz zapisany!", "success");
};

window.deleteQuiz = async function (id) {
  if (!confirm("Usunąć quiz?")) return;
  await deleteDoc(doc(db, "quizzes", id));
  await updateDoc(doc(db, "users", currentUser.uid), { quizzesCount: increment(-1) });
  pushActivity("Usunięto quiz");
  trackAnalytics("quiz_deleted", {});
  loadQuizzes();
  loadDashboard();
};

// ─── QUIZ PLAYER ───
window.startQuiz = async function (quizId) {
  const snap = await getDoc(doc(db, "quizzes", quizId));
  if (!snap.exists()) return;
  const quiz = { id: snap.id, ...snap.data() };

  playerState = { quiz, current: 0, answers: {}, score: 0, done: false };
  document.getElementById("player-quiz-name").textContent = quiz.name;
  document.getElementById("player-modal").style.display = "flex";
  trackAnalytics("quiz_started", { quiz_name: quiz.name });
  renderPlayerQuestion();
};

function renderPlayerQuestion() {
  const { quiz, current, answers, done } = playerState;
  const q = quiz.questions[current];
  const total = quiz.questions.length;
  const pct = Math.round((current / total) * 100);
  const content = document.getElementById("player-content");

  if (done) {
    const score = playerState.score;
    const pctScore = Math.round((score / total) * 100);
    content.innerHTML = `
      <div class="score-display">
        <span class="score-big">${pctScore}%</span>
        <p class="score-label">${score} z ${total} poprawnych odpowiedzi</p>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="closePlayer()">Zamknij</button>
        <button class="btn-primary sm" onclick="startQuiz('${quiz.id}')">Spróbuj ponownie</button>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div class="player-progress">
      <span>${current + 1}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${total}</span>
    </div>
    <div class="player-question">
      <p class="player-q-text">${esc(q.text)}</p>
      <div class="player-options" id="player-options">
        ${q.options.map((opt, i) => `
          <div class="player-option" id="popt-${i}" onclick="selectAnswer(${i})">
            <span class="option-key-badge">${["A", "B", "C", "D"][i]}</span>
            ${esc(opt)}
          </div>
        `).join("")}
      </div>
    </div>
    <div class="modal-actions" id="player-actions" style="display:none">
      <button class="btn-primary sm" onclick="nextQuestion()">
        ${current + 1 < total ? "Następne →" : "Zakończ"}
      </button>
    </div>
  `;
}

window.selectAnswer = function (idx) {
  if (playerState.answers[playerState.current] !== undefined) return;
  playerState.answers[playerState.current] = idx;
  const q = playerState.quiz.questions[playerState.current];
  const correct = q.correct;

  document.querySelectorAll(".player-option").forEach((el, i) => {
    el.onclick = null;
    if (i === correct) el.classList.add("correct");
    if (i === idx && idx !== correct) el.classList.add("wrong");
  });
  if (idx === correct) playerState.score++;
  document.getElementById("player-actions").style.display = "flex";
};

window.nextQuestion = function () {
  const { quiz, current } = playerState;
  if (current + 1 >= quiz.questions.length) {
    playerState.done = true;
    finishQuiz();
  } else {
    playerState.current++;
    renderPlayerQuestion();
  }
};

async function finishQuiz() {
  const { score, quiz } = playerState;
  const pct = Math.round((score / quiz.questions.length) * 100);

  // Zapisz wynik do Firestore
  await addDoc(collection(db, "results"), {
    uid: currentUser.uid,
    quizId: quiz.id,
    quizName: quiz.name,
    score, total: quiz.questions.length,
    pct,
    createdAt: serverTimestamp()
  });
  await updateDoc(doc(db, "users", currentUser.uid), {
    attempts: increment(1),
    totalScore: increment(pct / 100)
  });

  pushActivity(`Ukończono "${quiz.name}" z wynikiem ${pct}%`);
  trackAnalytics("quiz_completed", { quiz_name: quiz.name, score: pct });
  renderPlayerQuestion();
  loadDashboard();
}

window.closePlayer = () => { document.getElementById("player-modal").style.display = "none"; };

// ─────────────────────────────────────────────────────
// 5️⃣  ANALYTICS LOG (UI)
// ─────────────────────────────────────────────────────
function trackAnalytics(name, params) {
  analyticsEvents.unshift({ name, params, time: new Date() });
  if (analyticsEvents.length > 30) analyticsEvents.pop();
  trackEvent(name, params);
  renderEventsLog();
}

function renderEventsLog() {
  const el = document.getElementById("events-log");
  if (!el) return;
  el.innerHTML = analyticsEvents.map(e => `
    <div class="event-item">
      <span class="event-name">${e.name}</span>
      <span class="event-time">${e.time.toLocaleTimeString("pl")}</span>
    </div>
  `).join("");
}

function renderAnalyticsSection() {
  renderEventsLog();
}

// ─────────────────────────────────────────────────────
// 4️⃣  REMOTE CONFIG — wizualizacja
// ─────────────────────────────────────────────────────
function renderRemoteConfig() {
  const el = document.getElementById("rc-display");
  if (!el) return;
  const entries = Object.entries(rcConfig);
  el.innerHTML = entries.map(([k, v]) => `
    <div class="rc-item">
      <span class="rc-key">${k}</span>
      <span class="rc-val">${v === true ? "true" : v === false ? "false" : v}</span>
    </div>
  `).join("");

  const badge = document.getElementById("rc-badge");
  if (badge) badge.title = `Remote Config załadowany: ${entries.length} kluczy`;
}

// ─────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });
}

let toastTimer;
function showToast(msg, type = "") {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = "toast", 3000);
}
window.showToast = showToast;