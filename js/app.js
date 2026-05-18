// ═══════════════════════════════════════════════════════
// STUDYFLOW — app.js
// Logika aplikacji wykorzystująca 6 usług Firebase
// ═══════════════════════════════════════════════════════

import {
  auth, db, rtdb, trackEvent, loadRemoteConfig
} from "./firebase-config.js";
import { GEMINI_API_KEY } from "./config.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup
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
let editingQuizId = null;
let quizQuestions = [];          // tymczasowo przy budowaniu quizu
let playerState = {};          // stan quiz playera
let analyticsEvents = [];
let firestoreUnsub = null;
let allNotes = [];          // cache notatek do wyszukiwania
let activeCategory = null;  // aktywna kategoria filtra
let timerInterval = null;  // interval timera quizu

// ─────────────────────────────────────────────────────
// BOOTSTRAP — inicjalizacja po załadowaniu strony
// ─────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {

  // 4️⃣  Remote Config — ładuj zanim cokolwiek pokażemy
  rcConfig = await loadRemoteConfig();
  renderRemoteConfig();

  // Zamknij sidebar po kliknięciu nav-item na mobile
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeSidebar();
    });
  });

  // 1️⃣  Firebase Auth — obserwuj stan logowania
  onAuthStateChanged(auth, user => {
    if (user) {
      currentUser = user;
      showApp();
    } else {
      currentUser = null;
      // Sprawdź czy URL zawiera publiczny quiz
      const params = new URLSearchParams(window.location.search);
      if (params.get("quiz")) {
        checkPublicQuizUrl();
      } else {
        showAuth();
      }
    }
  });
});


// ─────────────────────────────────────────────────────
// EMAIL VERIFICATION
// ─────────────────────────────────────────────────────
function showVerificationScreen() {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").style.display = "none";
  document.getElementById("verification-screen").style.display = "flex";
  const email = currentUser.email;
  document.getElementById("verification-email").textContent = email;
}

window.resendVerification = async function () {
  try {
    await sendEmailVerification(currentUser);
    showToast("E-mail weryfikacyjny wysłany ponownie!", "success");
  } catch (e) {
    showToast("Poczekaj chwilę przed ponownym wysłaniem.", "error");
  }
};

window.checkVerification = async function () {
  await currentUser.reload();
  if (currentUser.emailVerified) {
    document.getElementById("verification-screen").style.display = "none";
    showApp();
  } else {
    showToast("E-mail jeszcze nie potwierdzony.", "error");
  }
};

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
    await sendEmailVerification(cred.user);

    // Zapisz profil użytkownika w Firestore
    await setDoc(doc(db, "users", cred.user.uid), {
      name, email,
      createdAt: serverTimestamp(),
      notesCount: 0, quizzesCount: 0, attempts: 0, totalScore: 0
    });

    // 5️⃣  Analytics — rejestruj rejestrację
    trackAnalytics("sign_up", { method: "email" });
    showToast("Konto utworzone! Sprawdź e-mail i potwierdź adres.", "success");
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

window.resetPassword = async function () {
  const email = document.getElementById("login-email").value.trim();
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";

  if (!email) return errEl.textContent = "Wpisz adres e-mail powyżej.";

  try {
    await sendPasswordResetEmail(auth, email);
    errEl.style.color = "var(--accent-green)";
    errEl.textContent = "Link do resetowania hasła został wysłany na " + email;
  } catch (e) {
    errEl.style.color = "#ef4444";
    errEl.textContent = translateAuthError(e.code);
  }
};


window.loginWithGoogle = async function () {
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";
  errEl.style.color = "#ef4444";

  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    const user = cred.user;

    // Utwórz profil w Firestore jeśli to pierwsze logowanie
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        name: user.displayName || "Użytkownik",
        email: user.email,
        createdAt: serverTimestamp(),
        notesCount: 0, quizzesCount: 0, attempts: 0, totalScore: 0
      });
    }

    trackAnalytics("login", { method: "google" });
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user") {
      errEl.textContent = translateAuthError(e.code);
    }
  }
};


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
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("auth-screen").style.display = "";
  document.getElementById("app").style.display = "none";
}

function showApp() {
  document.getElementById("loading-screen").style.display = "none";
  // Sprawdź weryfikację e-mail (pomijaj na localhost)
  const isDev = window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost";
  if (!currentUser.emailVerified && !isDev) {
    showVerificationScreen();
    return;
  }

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
  initOfflineDetection();
}

window.showSection = function (name) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById(`section-${name}`).classList.add("active");
  document.querySelectorAll(`.nav-item`).forEach(n => {
    if (n.getAttribute("onclick")?.includes(name)) n.classList.add("active");
  });

  if (name === "notes") { loadNotes(); }
  if (name === "flashcards") { loadDecks(); }
  if (name === "quizzes") { loadQuizzes(); loadResults(); }
  if (name === "analytics") renderAnalyticsSection();

  trackAnalytics("page_view", { page: name });
};

window.switchQuizTab = function (tab) {
  document.getElementById("tab-quizzes").classList.toggle("active", tab === "quizzes");
  document.getElementById("tab-results").classList.toggle("active", tab === "results");
  document.getElementById("quizzes-tab-content").style.display = tab === "quizzes" ? "" : "none";
  document.getElementById("results-tab-content").style.display = tab === "results" ? "" : "none";
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
// WYSZUKIWARKA I SORTOWANIE NOTATEK
// ─────────────────────────────────────────────────────
window.setCategory = function (cat) {
  activeCategory = cat;
  filterNotes();
};

window.filterNotes = function () {
  const query = document.getElementById("notes-search").value.trim().toLowerCase();
  const sort = document.getElementById("notes-sort").value;
  const clearBtn = document.getElementById("search-clear");
  const noResults = document.getElementById("notes-no-results");

  clearBtn.style.display = query ? "" : "none";

  let filtered = [...allNotes];

  // Filtrowanie po kategorii
  if (activeCategory) {
    filtered = filtered.filter(n => n.category === activeCategory);
  }

  // Filtrowanie po wyszukiwarce
  if (query) {
    filtered = filtered.filter(n =>
      n.title.toLowerCase().includes(query) ||
      n.content.toLowerCase().includes(query)
    );
  }

  // Sortowanie
  filtered.sort((a, b) => {
    if (sort === "date-desc") return toMs(b.createdAt) - toMs(a.createdAt);
    if (sort === "date-asc") return toMs(a.createdAt) - toMs(b.createdAt);
    if (sort === "alpha-asc") return a.title.localeCompare(b.title, "pl");
    if (sort === "alpha-desc") return b.title.localeCompare(a.title, "pl");
    return 0;
  });

  // Pokaż "brak wyników"
  if (noResults) {
    noResults.style.display = query && !filtered.length ? "" : "none";
    const label = document.getElementById("search-query-label");
    if (label) label.textContent = query;
  }

  renderNotes(filtered);
};

window.clearSearch = function () {
  document.getElementById("notes-search").value = "";
  document.getElementById("search-clear").style.display = "none";
  filterNotes();
};

function toMs(ts) {
  if (!ts) return 0;
  if (ts.toDate) return ts.toDate().getTime();
  return new Date(ts).getTime();
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
    allNotes = [];
    snapshot.forEach(d => allNotes.push({ id: d.id, ...d.data() }));
    renderNotes(allNotes);
    document.getElementById("stat-notes").textContent = allNotes.length;
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

  // Aktualizuj datalist kategorii
  const cats = [...new Set(notes.map(n => n.category).filter(Boolean))];
  const dl = document.getElementById("categories-list");
  if (dl) dl.innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");

  // Renderuj chipsy kategorii
  const bar = document.getElementById("categories-bar");
  if (bar) {
    bar.innerHTML = cats.length ? [
      `<span class="category-chip ${!activeCategory ? 'active' : ''}" onclick="setCategory(null)">Wszystkie</span>`,
      ...cats.map(c => `<span class="category-chip ${activeCategory === c ? 'active' : ''}" onclick="setCategory('${esc(c)}')">${esc(c)}</span>`)
    ].join("") : "";
  }

  grid.innerHTML = notes.map(n => `
    <div class="note-card">
      ${n.category ? `<span class="note-category-badge">${esc(n.category)}</span>` : ""}
      <p class="note-card-title">${esc(n.title)}</p>
      <p class="note-card-content">${esc(n.content)}</p>
      <div class="note-card-footer">
        <span class="note-card-date">${formatDate(n.createdAt)}</span>
        <div class="note-card-actions">
          <button class="icon-btn edit" title="Edytuj" onclick="editNote('${n.id}','${esc(n.title)}','${esc(n.content).replace(/'/g, "&#39;")}','${esc(n.category || "")}')">✏</button>
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
  document.getElementById("note-category-input").value = "";
  document.getElementById("note-modal").style.display = "flex";
};
window.closeNoteModal = () => { document.getElementById("note-modal").style.display = "none"; };

window.editNote = function (id, title, content, category) {
  editingNoteId = id;
  document.getElementById("note-modal-title").textContent = "Edytuj notatkę";
  document.getElementById("note-title-input").value = title;
  document.getElementById("note-content-input").value = content;
  document.getElementById("note-category-input").value = category || "";
  document.getElementById("note-modal").style.display = "flex";
};

window.saveNote = async function () {
  const title = document.getElementById("note-title-input").value.trim();
  const noteContent = document.getElementById("note-content-input").value.trim();
  const category = document.getElementById("note-category-input").value.trim();
  if (!title) return showToast("Wpisz tytuł notatki.", "error");

  // Remote Config — limit notatek
  const userDoc = await getDoc(doc(db, "users", currentUser.uid));
  const notesCount = userDoc.exists() ? userDoc.data().notesCount || 0 : 0;
  if (!editingNoteId && notesCount >= rcConfig.max_notes_per_user) {
    return showToast(`Limit notatek: ${rcConfig.max_notes_per_user} (Remote Config)`, "error");
  }

  if (editingNoteId) {
    await updateDoc(doc(db, "notes", editingNoteId), { title, content: noteContent, category, updatedAt: serverTimestamp() });
    pushActivity(`Edytowano notatkę: ${title}`);
    trackAnalytics("note_updated", { title });
    showToast("Notatka zaktualizowana!", "success");
  } else {
    await addDoc(collection(db, "notes"), {
      uid: currentUser.uid, title, content: noteContent, category, createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, "users", currentUser.uid), { notesCount: increment(1) });
    pushActivity(`Dodano notatkę: ${title}`);
    trackAnalytics("note_created", { title, category });
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
        <div style="display:flex;gap:6px;align-items:center">
          ${q.public ? '<span class="quiz-public-badge">🔗 Publiczny</span>' : ''}
          <span class="quiz-badge">${q.questions.length} pytań</span>
        </div>
      </div>
      <p class="quiz-card-meta">Utworzono: ${formatDate(q.createdAt)}</p>
      <div class="quiz-card-actions">
        <button class="btn-primary sm" onclick="startQuiz('${q.id}')">Rozwiąż</button>
        <div class="quiz-card-actions-secondary">
          <button class="btn-ghost" onclick="shareQuiz('${q.id}','${esc(q.name)}',${!!q.public})">${q.public ? "🔗 Link" : "Udostępnij"}</button>
          <button class="btn-ghost" onclick="editQuiz('${q.id}')">Edytuj</button>
          <button class="btn-ghost" onclick="deleteQuiz('${q.id}')">Usuń</button>
        </div>
      </div>
    </div>
  `).join("");
}

// ─── QUIZ BUILDER ───
window.openQuizModal = function () {
  if (!rcConfig.quizzes_enabled) return showToast("Quizy wyłączone (Remote Config).", "error");
  editingQuizId = null;
  quizQuestions = [];
  document.getElementById("quiz-name-input").value = "";
  document.getElementById("questions-builder").innerHTML = "";
  document.getElementById("quiz-modal-title").textContent = "Nowy quiz";
  document.getElementById("quiz-timer-input").value = "0";
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


window.editQuiz = async function (id) {
  if (!rcConfig.quizzes_enabled) return showToast("Quizy wyłączone (Remote Config).", "error");
  const snap = await getDoc(doc(db, "quizzes", id));
  if (!snap.exists()) return showToast("Nie znaleziono quizu.", "error");

  const quiz = snap.data();
  editingQuizId = id;
  quizQuestions = [];

  document.getElementById("quiz-name-input").value = quiz.name;
  document.getElementById("quiz-timer-input").value = quiz.timePerQuestion || 0;
  document.getElementById("questions-builder").innerHTML = "";
  document.getElementById("quiz-modal-title").textContent = "Edytuj quiz";

  // Załaduj istniejące pytania do buildera
  quiz.questions.forEach(q => {
    const idx = quizQuestions.length;
    quizQuestions.push({ text: q.text, options: [...q.options], correct: q.correct });

    const builder = document.getElementById("questions-builder");
    const block = document.createElement("div");
    block.className = "question-block";
    block.innerHTML = `
      <div class="question-block-header">
        <span class="question-num">Pytanie ${idx + 1}</span>
        <button class="icon-btn remove-btn">✕</button>
      </div>
      <div class="field">
        <label>Treść pytania</label>
        <input type="text" class="q-text" placeholder="Wpisz pytanie..." value="${esc(q.text)}" />
      </div>
      <div class="options-grid">
        ${["A", "B", "C", "D"].map((l, i) => `
          <div class="option-input">
            <span class="option-label">${l}</span>
            <input type="text" class="q-opt" data-opt="${i}" placeholder="Odpowiedź ${l}" value="${esc(q.options[i])}" />
          </div>
        `).join("")}
      </div>
      <div class="field" style="margin-top:8px">
        <label>Poprawna odpowiedź</label>
        <select class="q-correct">
          <option value="0"${q.correct === 0 ? " selected" : ""}>A</option>
          <option value="1"${q.correct === 1 ? " selected" : ""}>B</option>
          <option value="2"${q.correct === 2 ? " selected" : ""}>C</option>
          <option value="3"${q.correct === 3 ? " selected" : ""}>D</option>
        </select>
      </div>
    `;

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
  });

  document.getElementById("quiz-modal").style.display = "flex";
};
window.saveQuiz = async function () {
  const name = document.getElementById("quiz-name-input").value.trim();
  if (!name) return showToast("Wpisz nazwę quizu.", "error");

  const valid = quizQuestions.filter(q => q.text.trim() && q.options.every(o => o.trim()));
  if (!valid.length) return showToast("Dodaj co najmniej jedno kompletne pytanie.", "error");

  const timePerQuestion = parseInt(document.getElementById("quiz-timer-input").value) || 0;

  if (editingQuizId) {
    await updateDoc(doc(db, "quizzes", editingQuizId), { name, questions: valid, timePerQuestion, updatedAt: serverTimestamp() });
    pushActivity(`Edytowano quiz: ${name}`);
    trackAnalytics("quiz_updated", { name });
    showToast("Quiz zaktualizowany!", "success");
  } else {
    await addDoc(collection(db, "quizzes"), {
      uid: currentUser.uid, name, questions: valid, timePerQuestion, createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, "users", currentUser.uid), { quizzesCount: increment(1) });
    pushActivity(`Utworzono quiz: ${name}`);
    trackAnalytics("quiz_created", { name, question_count: valid.length });
    showToast("Quiz zapisany!", "success");
  }

  closeQuizModal();
  loadQuizzes();
  loadDashboard();
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

  if (timerInterval) clearInterval(timerInterval);
  playerState = { quiz, current: 0, answers: {}, score: 0, done: false, timeLeft: quiz.timePerQuestion || 0 };
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
    const scoreClass = pctScore >= 80 ? "high" : pctScore >= 50 ? "mid" : "low";
    const scoreColor = pctScore >= 80 ? "var(--accent-green)" : pctScore >= 50 ? "var(--accent-amber)" : "var(--accent-coral)";

    const questionsReview = quiz.questions.map((q, i) => {
      const userAnswer = playerState.answers[i];
      const isCorrect = userAnswer === q.correct;
      const userAnswerText = userAnswer >= 0 ? q.options[userAnswer] : "Brak odpowiedzi";
      const correctAnswerText = q.options[q.correct];
      return `
        <div class="review-item ${isCorrect ? 'review-correct' : 'review-wrong'}">
          <div class="review-item-header">
            <span class="review-icon">${isCorrect ? '✅' : '❌'}</span>
            <p class="review-q-text">${esc(q.text)}</p>
          </div>
          ${!isCorrect ? `
            <div class="review-answers">
              <p class="review-user-answer">Twoja odpowiedź: <strong>${esc(userAnswerText)}</strong></p>
              <p class="review-correct-answer">Poprawna odpowiedź: <strong>${esc(correctAnswerText)}</strong></p>
            </div>
          ` : `
            <div class="review-answers">
              <p class="review-correct-answer">Poprawna odpowiedź: <strong>${esc(correctAnswerText)}</strong></p>
            </div>
          `}
        </div>
      `;
    }).join("");

    content.innerHTML = `
      <div class="score-display">
        <span class="score-big" style="color:${scoreColor}">${pctScore}%</span>
        <p class="score-label">${score} z ${total} poprawnych odpowiedzi</p>
      </div>
      <div class="review-list">
        ${questionsReview}
      </div>
      <div class="modal-actions" style="margin-top:1rem">
        <button class="btn-ghost" onclick="closePlayer()">Zamknij</button>
        <button class="btn-primary sm" onclick="startQuiz('${quiz.id}')">Spróbuj ponownie</button>
      </div>
    `;
    return;
  }

  const timeLimit = playerState.quiz.timePerQuestion || 0;
  content.innerHTML = `
    <div class="player-progress">
      <span>${current + 1}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${total}</span>
    </div>
    ${timeLimit ? `<div class="quiz-timer"><div class="timer-circle" id="timer-circle">${timeLimit}</div><span>sekund na odpowiedź</span></div>` : ""}
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

  // Uruchom timer jeśli ustawiony
  if (timerInterval) clearInterval(timerInterval);
  if (timeLimit) {
    playerState.timeLeft = timeLimit;
    timerInterval = setInterval(() => {
      playerState.timeLeft--;
      const circle = document.getElementById("timer-circle");
      if (!circle) { clearInterval(timerInterval); return; }
      circle.textContent = playerState.timeLeft;
      circle.className = "timer-circle" + (playerState.timeLeft <= 5 ? " danger" : playerState.timeLeft <= 10 ? " warning" : "");
      if (playerState.timeLeft <= 0) {
        clearInterval(timerInterval);
        selectAnswer(-1); // brak odpowiedzi = błędna
      }
    }, 1000);
  }
}

window.selectAnswer = function (idx) {
  if (playerState.answers[playerState.current] !== undefined) return;
  if (timerInterval) clearInterval(timerInterval);
  playerState.answers[playerState.current] = idx;
  const q = playerState.quiz.questions[playerState.current];

  // Tylko zaznacz wybraną odpowiedź — bez ujawniania poprawnej
  document.querySelectorAll(".player-option").forEach((el, i) => {
    el.onclick = null;
    if (i === idx) el.classList.add("selected");
  });
  if (idx === q.correct) playerState.score++;
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

window.closePlayer = () => { if (timerInterval) clearInterval(timerInterval); document.getElementById("player-modal").style.display = "none"; };

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
  renderRemoteConfig();
  renderGeminiUsage();
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
// GEMINI USAGE TRACKER
// ─────────────────────────────────────────────────────
const GEMINI_DAILY_LIMIT = 20;

function getGeminiUsage(key = "gemini_usage_quiz") {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "{}");
    if (stored.date !== today) return { date: today, count: 0 };
    return stored;
  } catch (e) { return { date: today, count: 0 }; }
}

function incrementGeminiUsage(key = "gemini_usage_quiz") {
  const usage = getGeminiUsage(key);
  usage.count++;
  localStorage.setItem(key, JSON.stringify(usage));
  renderGeminiUsage();
}

function isGeminiLimitReached(key = "gemini_usage_quiz") {
  return getGeminiUsage(key).count >= GEMINI_DAILY_LIMIT;
}

function isGeminiLimitWarning(key = "gemini_usage_quiz") {
  return getGeminiUsage(key).count >= Math.floor(GEMINI_DAILY_LIMIT * 0.75);
}

function renderUsageWidget(el, used, label) {
  const remaining = Math.max(0, GEMINI_DAILY_LIMIT - used);
  const pct = Math.min(100, Math.round((used / GEMINI_DAILY_LIMIT) * 100));
  const barColor = pct >= 100 ? "var(--accent-coral)" : pct >= 75 ? "var(--accent-amber)" : "var(--accent-green)";
  const warning = pct >= 75 && pct < 100;
  const blocked = pct >= 100;

  el.innerHTML = `
    <div class="gemini-usage-header">
      <span class="gemini-usage-title">${label}</span>
      <span class="gemini-usage-count" style="color:${barColor}">${used}&thinsp;/&thinsp;${GEMINI_DAILY_LIMIT}</span>
    </div>
    ${blocked ? '<div class="gemini-limit-banner blocked">🚫 Dzienny limit wyczerpany — spróbuj jutro</div>' :
      warning ? '<div class="gemini-limit-banner warning">⚠ Limit się kończy — zostało ' + remaining + ' zapytań</div>' : ''}
    <div class="gemini-usage-bar-bg">
      <div class="gemini-usage-bar-fill" style="width:${pct}%;background:${barColor}"></div>
    </div>
    <div class="gemini-usage-meta">
      <span style="color:var(--text-3)">Wykorzystano: <strong style="color:${barColor}">${pct}%</strong></span>
      <span style="color:var(--accent-green)">Pozostało: <strong>${remaining} zapytań</strong></span>
    </div>
    <div class="gemini-usage-dots">
      ${Array.from({ length: 20 }, (_, i) => {
        const filled = i < used;
        const color = filled
          ? (blocked ? "var(--accent-coral)" : warning ? "var(--accent-amber)" : "var(--accent-blue)")
          : "var(--bg-4)";
        return '<div class="gemini-dot" style="background:' + color + '"></div>';
      }).join("")}
    </div>
  `;
}

function renderGeminiUsage() {
  const el = document.getElementById("gemini-usage-widget");
  if (!el) return;
  const quizUsage = getGeminiUsage("gemini_usage_quiz").count;
  const fcUsage = getGeminiUsage("gemini_usage_fc").count;

  el.innerHTML = "";

  const quizEl = document.createElement("div");
  quizEl.style.marginBottom = "1rem";
  renderUsageWidget(quizEl, quizUsage, "Quizy — dzienny limit (20 zapytań)");
  el.appendChild(quizEl);

  const fcEl = document.createElement("div");
  renderUsageWidget(fcEl, fcUsage, "Fiszki — dzienny limit (20 zapytań)");
  el.appendChild(fcEl);
}

// ─────────────────────────────────────────────────────
// ✨ AI — GENEROWANIE QUIZÓW (GEMINI API)
// ─────────────────────────────────────────────────────
let aiGeneratedQuestions = [];

window.openAiModal = function () {
  aiGeneratedQuestions = [];
  document.getElementById("ai-topic").value = "";
  document.getElementById("ai-count").value = "10";
  document.getElementById("ai-level").value = "średni";
  document.getElementById("ai-status").style.display = "none";
  document.getElementById("ai-preview").style.display = "none";
  document.getElementById("ai-generate-btn").textContent = "✨ Generuj";
  document.getElementById("ai-generate-btn").onclick = generateQuizAI;
  document.getElementById("ai-modal").style.display = "flex";
};
window.closeAiModal = () => { document.getElementById("ai-modal").style.display = "none"; };

window.generateQuizAI = async function () {
  const topic = document.getElementById("ai-topic").value.trim();
  const count = document.getElementById("ai-count").value;
  const level = document.getElementById("ai-level").value;

  if (!topic) return showToast("Wpisz temat quizu.", "error");
  if (isGeminiLimitReached("gemini_usage_quiz")) {
    return showToast("Dzienny limit zapytań AI dla quizów wyczerpany. Spróbuj jutro.", "error");
  }

  const statusEl = document.getElementById("ai-status");
  const previewEl = document.getElementById("ai-preview");
  const btn = document.getElementById("ai-generate-btn");

  statusEl.style.display = "flex";
  statusEl.innerHTML = `<div class="ai-spinner"></div> Gemini generuje ${count} pytań na temat "${topic}"...`;
  previewEl.style.display = "none";
  btn.disabled = true;

  const prompt = `Wygeneruj ${count} pytań quizowych na temat "${topic}" na poziomie ${level}.
Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown, bez komentarzy):
{
  "questions": [
    {
      "text": "treść pytania",
      "options": ["odpowiedź A", "odpowiedź B", "odpowiedź C", "odpowiedź D"],
      "correct": 0
    }
  ]
}
Gdzie "correct" to indeks (0-3) poprawnej odpowiedzi. Pytania i odpowiedzi pisz po polsku.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
        })
      }
    );

    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    aiGeneratedQuestions = parsed.questions;
    incrementGeminiUsage("gemini_usage_quiz");

    // Pokaż podgląd
    statusEl.innerHTML = `✓ Wygenerowano ${aiGeneratedQuestions.length} pytań. Sprawdź podgląd:`;
    previewEl.style.display = "";
    previewEl.innerHTML = aiGeneratedQuestions.map((q, i) => `
      <div class="ai-preview-question">
        <p class="ai-preview-q">${i + 1}. ${esc(q.text)}</p>
        <div class="ai-preview-opts">
          ${q.options.map((o, j) => `
            <span class="ai-preview-opt ${j === q.correct ? "correct" : ""}">
              ${["A", "B", "C", "D"][j]}. ${esc(o)}${j === q.correct ? " ✓" : ""}
            </span>
          `).join("")}
        </div>
      </div>
    `).join("");

    btn.disabled = false;
    btn.textContent = "💾 Zapisz quiz";
    btn.onclick = saveAiQuiz;
    trackAnalytics("ai_quiz_generated", { topic, count: aiGeneratedQuestions.length });

  } catch (e) {
    statusEl.innerHTML = `✕ Błąd: ${e.message}`;
    btn.disabled = false;
    console.error("Gemini error:", e);
  }
};

window.saveAiQuiz = async function () {
  const topic = document.getElementById("ai-topic").value.trim();
  if (!aiGeneratedQuestions.length) return;

  await addDoc(collection(db, "quizzes"), {
    uid: currentUser.uid,
    name: `AI: ${topic}`,
    questions: aiGeneratedQuestions,
    timePerQuestion: 0,
    createdAt: serverTimestamp(),
    generatedByAI: true
  });
  await updateDoc(doc(db, "users", currentUser.uid), { quizzesCount: increment(1) });
  pushActivity(`Wygenerowano quiz AI: ${topic}`);
  trackAnalytics("ai_quiz_saved", { topic });
  closeAiModal();
  loadQuizzes();
  loadDashboard();
  showToast(`Quiz "AI: ${topic}" zapisany!`, "success");
};

// ─────────────────────────────────────────────────────
// ⬇ EKSPORT NOTATEK DO PDF (jsPDF — CDN)
// ─────────────────────────────────────────────────────
window.exportAllNotesPDF = function () {
  if (!allNotes.length) return showToast("Brak notatek do eksportu.", "error");

  const { jsPDF } = window.jspdf;
  if (!jsPDF) return showToast("Błąd ładowania biblioteki PDF.", "error");

  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const margin = 15;
  const pageW = 210;
  const maxW = pageW - margin * 2;
  let y = margin;

  // Tytuł dokumentu
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.setTextColor(30, 30, 30);
  pdf.text("StudyFlow — Moje notatki", margin, y);
  y += 8;

  pdf.setFontSize(9);
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(120, 120, 120);
  pdf.text(`Wygenerowano: ${new Date().toLocaleDateString("pl-PL")} · ${allNotes.length} notatek`, margin, y);
  y += 10;

  // Linia
  pdf.setDrawColor(200, 200, 200);
  pdf.line(margin, y, pageW - margin, y);
  y += 8;

  allNotes.forEach((note, idx) => {
    // Sprawdź czy trzeba nową stronę
    if (y > 260) { pdf.addPage(); y = margin; }

    // Kategoria
    if (note.category) {
      pdf.setFontSize(8);
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(100, 80, 200);
      pdf.text(`[${note.category}]`, margin, y);
      y += 5;
    }

    // Tytuł notatki
    pdf.setFontSize(13);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(30, 30, 30);
    pdf.text(note.title, margin, y);
    y += 6;

    // Treść
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(60, 60, 60);
    const lines = pdf.splitTextToSize(note.content || "", maxW);
    lines.forEach(line => {
      if (y > 270) { pdf.addPage(); y = margin; }
      pdf.text(line, margin, y);
      y += 5;
    });

    // Data i separator
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.text(formatDate(note.createdAt), margin, y);
    y += 5;

    if (idx < allNotes.length - 1) {
      pdf.setDrawColor(230, 230, 230);
      pdf.line(margin, y, pageW - margin, y);
      y += 6;
    }
  });

  pdf.save(`StudyFlow_Notatki_${new Date().toISOString().slice(0, 10)}.pdf`);
  trackAnalytics("notes_exported_pdf", { count: allNotes.length });
  showToast(`Wyeksportowano ${allNotes.length} notatek do PDF!`, "success");
};


// ─────────────────────────────────────────────────────
// 🔗 WSPÓŁDZIELENIE QUIZÓW
// ─────────────────────────────────────────────────────
window.shareQuiz = async function (id, name, isPublic) {
  if (!isPublic) {
    // Ustaw quiz jako publiczny
    await updateDoc(doc(db, "quizzes", id), { public: true });
    pushActivity(`Udostępniono quiz: ${name}`);
    trackAnalytics("quiz_shared", { name });
    showToast("Quiz jest teraz publiczny!", "success");
  }

  const url = `${window.location.origin}${window.location.pathname}?quiz=${id}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link skopiowany do schowka! 🔗", "success");
  } catch (e) {
    prompt("Skopiuj link:", url);
  }
  loadQuizzes();
};

// Sprawdź czy URL zawiera ?quiz=ID (widok publiczny)
function checkPublicQuizUrl() {
  const params = new URLSearchParams(window.location.search);
  const quizId = params.get("quiz");
  if (!quizId) return;

  // Pokaż publiczny player nawet bez logowania
  document.getElementById("auth-screen").style.display = "none";
  document.getElementById("app").style.display = "none";
  document.getElementById("public-quiz-screen").style.display = "flex";
  loadPublicQuiz(quizId);
}

async function loadPublicQuiz(quizId) {
  document.getElementById("loading-screen").style.display = "none";
  const el = document.getElementById("public-quiz-content");
  el.innerHTML = `<p style="color:var(--text-2);text-align:center;padding:2rem">Ładowanie quizu...</p>`;

  try {
    const snap = await getDoc(doc(db, "quizzes", quizId));
    if (!snap.exists() || !snap.data().public) {
      el.innerHTML = `<p style="color:#ef4444;text-align:center;padding:2rem">Quiz nie istnieje lub nie jest publiczny.</p>`;
      return;
    }
    const quiz = { id: snap.id, ...snap.data() };
    document.getElementById("public-quiz-title").textContent = quiz.name;

    // Uruchom player w trybie publicznym
    playerState = { quiz, current: 0, answers: {}, score: 0, done: false, timeLeft: quiz.timePerQuestion || 0, isPublic: true };
    renderPublicQuestion();
  } catch (e) {
    el.innerHTML = `<p style="color:#ef4444;text-align:center;padding:2rem">Błąd: ${e.message}</p>`;
  }
}

function renderPublicQuestion() {
  const { quiz, current, done } = playerState;
  const el = document.getElementById("public-quiz-content");
  const total = quiz.questions.length;

  if (done) {
    const pct = Math.round((playerState.score / total) * 100);
    el.innerHTML = `
      <div class="score-display">
        <span class="score-big">${pct}%</span>
        <p class="score-label">${playerState.score} z ${total} poprawnych</p>
        <p style="margin-top:1rem;font-size:13px;color:var(--text-2)">Stwórz swoje quizy na <strong>StudyFlow</strong></p>
        <a href="${window.location.origin}${window.location.pathname}" class="btn-primary sm" style="display:inline-block;margin-top:1rem;text-decoration:none;text-align:center">Zaloguj się →</a>
      </div>
    `;
    return;
  }

  const q = quiz.questions[current];
  const pct = Math.round((current / total) * 100);

  el.innerHTML = `
    <div class="player-progress">
      <span>${current + 1}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span>${total}</span>
    </div>
    <div class="player-question">
      <p class="player-q-text">${esc(q.text)}</p>
      <div class="player-options">
        ${q.options.map((opt, i) => `
          <div class="player-option" id="pub-opt-${i}" onclick="selectPublicAnswer(${i})">
            <span class="option-key-badge">${["A", "B", "C", "D"][i]}</span>
            ${esc(opt)}
          </div>
        `).join("")}
      </div>
    </div>
    <div class="modal-actions" id="pub-actions" style="display:none">
      <button class="btn-primary sm" onclick="nextPublicQuestion()">
        ${current + 1 < total ? "Następne →" : "Zakończ"}
      </button>
    </div>
  `;
}

window.selectPublicAnswer = function (idx) {
  if (playerState.answers[playerState.current] !== undefined) return;
  playerState.answers[playerState.current] = idx;
  const correct = playerState.quiz.questions[playerState.current].correct;
  document.querySelectorAll(".player-option").forEach((el, i) => {
    el.onclick = null;
    if (i === idx) el.classList.add("selected");
  });
  if (idx === correct) playerState.score++;
  document.getElementById("pub-actions").style.display = "flex";
};

window.nextPublicQuestion = function () {
  const { quiz, current } = playerState;
  if (current + 1 >= quiz.questions.length) {
    playerState.done = true;
  } else {
    playerState.current++;
  }
  renderPublicQuestion();
};


// ═══════════════════════════════════════════════════════
// 🃏 FISZKI — FLASHCARDS
// ═══════════════════════════════════════════════════════
let allDecks = [];
let studyState = {};

// ─── ŁADOWANIE TALII ───
async function loadDecks() {
  const q = query(
    collection(db, "decks"),
    where("uid", "==", currentUser.uid),
    orderBy("createdAt", "desc")
  );
  try {
    const snap = await getDocs(q);
    allDecks = [];
    snap.forEach(d => allDecks.push({ id: d.id, ...d.data() }));
    renderDecks();
  } catch (e) {
    console.warn("Decks index not ready:", e.message);
  }
}

function renderDecks() {
  const grid = document.getElementById("decks-grid");
  const empty = document.getElementById("decks-empty");
  if (!allDecks.length) {
    grid.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";

  grid.innerHTML = allDecks.map(d => {
    const total = d.cards?.length || 0;
    const newCount = d.cards?.filter(c => !c.nextReview || toMs(c.nextReview) <= Date.now()).length || 0;
    const doneCount = total - newCount;
    return `
      <div class="deck-card">
        <p class="deck-card-title">${esc(d.name)}</p>
        <p class="deck-card-desc">${esc(d.description || "")}</p>
        <div class="deck-card-meta">
          <span class="deck-meta-chip">${total} fiszek</span>
          <span class="deck-meta-chip review">Do powtórki: ${newCount}</span>
          <span class="deck-meta-chip done">Opanowane: ${doneCount}</span>
        </div>
        <div class="deck-card-actions">
          <button class="btn-primary sm" onclick="startStudy('${d.id}')">Ucz się</button>
          <button class="btn-ghost" onclick="openDeckModal('${d.id}')">Edytuj</button>
          <button class="btn-ghost" onclick="deleteDeck('${d.id}')">Usuń</button>
        </div>
      </div>
    `;
  }).join("");
}

// ─── TALIA MODAL ───
window.openDeckModal = function (id) {
  const deck = id ? allDecks.find(d => d.id === id) : null;
  document.getElementById("deck-modal-title").textContent = deck ? "Edytuj talię" : "Nowa talia";
  document.getElementById("deck-name-input").value = deck?.name || "";
  document.getElementById("deck-desc-input").value = deck?.description || "";
  document.getElementById("deck-modal").dataset.editId = id || "";
  document.getElementById("deck-modal").style.display = "flex";
};
window.closeDeckModal = () => { document.getElementById("deck-modal").style.display = "none"; };

window.saveDeck = async function () {
  const name = document.getElementById("deck-name-input").value.trim();
  const description = document.getElementById("deck-desc-input").value.trim();
  if (!name) return showToast("Wpisz nazwę talii.", "error");

  const editId = document.getElementById("deck-modal").dataset.editId;

  if (editId) {
    await updateDoc(doc(db, "decks", editId), { name, description, updatedAt: serverTimestamp() });
    showToast("Talia zaktualizowana!", "success");
    trackAnalytics("deck_updated", { name });
  } else {
    await addDoc(collection(db, "decks"), {
      uid: currentUser.uid, name, description, cards: [], createdAt: serverTimestamp()
    });
    showToast("Talia utworzona!", "success");
    trackAnalytics("deck_created", { name });
    pushActivity(`Utworzono talię: ${name}`);
  }
  closeDeckModal();
  loadDecks();
};

window.deleteDeck = async function (id) {
  if (!confirm("Usunąć talię ze wszystkimi fiszkami?")) return;
  await deleteDoc(doc(db, "decks", id));
  trackAnalytics("deck_deleted", {});
  pushActivity("Usunięto talię fiszek");
  loadDecks();
};

// ─── TRYB NAUKI ───
window.startStudy = async function (deckId) {
  const snap = await getDoc(doc(db, "decks", deckId));
  if (!snap.exists()) return;
  const deck = { id: snap.id, ...snap.data() };

  if (!deck.cards?.length) return showToast("Talia jest pusta.", "error");

  // Filtruj fiszki do powtórki (nowe lub zalegające)
  const due = deck.cards.filter(c => !c.nextReview || toMs(c.nextReview) <= Date.now());
  const cards = due.length ? due : deck.cards; // jeśli wszystko opanowane — powtórz wszystko

  studyState = {
    deckId, deck,
    cards: [...cards].sort(() => Math.random() - 0.5),
    current: 0, flipped: false,
    knew: 0, didntKnow: 0,
    done: false
  };

  document.getElementById("study-deck-name").textContent = deck.name;
  document.getElementById("study-modal").style.display = "flex";
  trackAnalytics("study_started", { deck_name: deck.name, cards: cards.length });
  renderStudyCard();
};
window.closeStudyModal = () => { document.getElementById("study-modal").style.display = "none"; };

function renderStudyCard() {
  const { cards, current, flipped, done, knew, didntKnow } = studyState;
  const content = document.getElementById("study-content");
  const total = cards.length;

  if (done) {
    const pct = Math.round((knew / total) * 100);
    content.innerHTML = `
      <div class="study-summary">
        <p style="font-size:13px;color:var(--text-2);margin-bottom:0.5rem">Sesja zakończona!</p>
        <div class="study-summary-stats">
          <div class="study-stat-box">
            <p class="study-stat-val" style="color:var(--accent-green)">${knew}</p>
            <p class="study-stat-label">Umiałem ✅</p>
          </div>
          <div class="study-stat-box">
            <p class="study-stat-val" style="color:#ef4444">${didntKnow}</p>
            <p class="study-stat-label">Nie umiałem ❌</p>
          </div>
        </div>
        <p style="font-size:13px;color:var(--text-2);margin-bottom:1rem">Wynik: <strong style="color:var(--accent-blue)">${pct}%</strong></p>
        <div class="modal-actions" style="justify-content:center">
          <button class="btn-ghost" onclick="closeStudyModal()">Zamknij</button>
          <button class="btn-primary sm" onclick="startStudy('${studyState.deckId}')">Ucz się ponownie</button>
        </div>
      </div>
    `;
    return;
  }

  const card = cards[current];
  const pct = Math.round((current / total) * 100);

  content.innerHTML = `
    <div class="study-progress">
      <span>${current + 1} / ${total}</span>
      <div class="progress-bar" style="flex:1;margin:0 12px"><div class="progress-fill" style="width:${pct}%"></div></div>
      <span style="color:var(--accent-green)">${studyState.knew} ✅</span>
    </div>

    <div class="flashcard-container" onclick="flipCard()">
      <div class="flashcard ${flipped ? 'flipped' : ''}" id="study-flashcard">
        <div class="flashcard-face front">
          <p class="flashcard-label">Przód</p>
          <p class="flashcard-text">${esc(card.front)}</p>
          <p class="flashcard-hint">Kliknij aby zobaczyć odpowiedź</p>
        </div>
        <div class="flashcard-face back">
          <p class="flashcard-label">Tył</p>
          <p class="flashcard-text">${esc(card.back)}</p>
        </div>
      </div>
    </div>

    <div class="study-actions" id="study-actions" style="display:${flipped ? 'grid' : 'none'}">
      <button class="btn-didnt-know" onclick="rateCard(false)">❌ Nie umiałem</button>
      <button class="btn-knew" onclick="rateCard(true)">✅ Umiałem</button>
    </div>
  `;
}

window.flipCard = function () {
  if (studyState.done) return;
  studyState.flipped = !studyState.flipped;
  const card = document.getElementById("study-flashcard");
  if (card) card.classList.toggle("flipped");
  const actions = document.getElementById("study-actions");
  if (actions) actions.style.display = studyState.flipped ? "grid" : "none";
};

window.rateCard = async function (knew) {
  const card = studyState.cards[studyState.current];
  if (knew) {
    studyState.knew++;
    // Algorytm: jeśli umiałem, następna powtórka za 3 dni
    card.interval = (card.interval || 1) * 2;
    card.nextReview = new Date(Date.now() + card.interval * 24 * 60 * 60 * 1000).toISOString();
  } else {
    studyState.didntKnow++;
    // Nie umiałem — wróć za 10 minut
    card.interval = 0.007;
    card.nextReview = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  }

  // Zapisz postęp do Firestore
  const deckSnap = await getDoc(doc(db, "decks", studyState.deckId));
  if (deckSnap.exists()) {
    const updatedCards = deckSnap.data().cards.map(c =>
      c.front === card.front && c.back === card.back
        ? { ...c, interval: card.interval, nextReview: card.nextReview }
        : c
    );
    await updateDoc(doc(db, "decks", studyState.deckId), { cards: updatedCards });
  }

  if (studyState.current + 1 >= studyState.cards.length) {
    studyState.done = true;
    trackAnalytics("study_completed", { knew: studyState.knew, didntKnow: studyState.didntKnow });
    pushActivity(`Ukończono sesję: ${studyState.deck.name} (${studyState.knew}/${studyState.cards.length})`);
  } else {
    studyState.current++;
    studyState.flipped = false;
  }
  renderStudyCard();
};

// ─── AI GENEROWANIE FISZEK ───
window.openAiFlashcardsModal = function () {
  document.getElementById("ai-fc-topic").value = "";
  document.getElementById("ai-fc-count").value = "20";
  document.getElementById("ai-fc-lang").value = "polski";
  document.getElementById("ai-fc-status").style.display = "none";
  document.getElementById("ai-fc-btn").textContent = "✨ Generuj";
  document.getElementById("ai-fc-btn").onclick = generateFlashcardsAI;
  document.getElementById("ai-flashcards-modal").style.display = "flex";
};
window.closeAiFlashcardsModal = () => { document.getElementById("ai-flashcards-modal").style.display = "none"; };

window.generateFlashcardsAI = async function () {
  const topic = document.getElementById("ai-fc-topic").value.trim();
  const count = document.getElementById("ai-fc-count").value;
  const lang = document.getElementById("ai-fc-lang").value;
  if (!topic) return showToast("Wpisz temat fiszek.", "error");
  if (isGeminiLimitReached("gemini_usage_fc")) {
    return showToast("Dzienny limit zapytań AI dla fiszek wyczerpany. Spróbuj jutro.", "error");
  }

  const statusEl = document.getElementById("ai-fc-status");
  const btn = document.getElementById("ai-fc-btn");
  statusEl.style.display = "flex";
  statusEl.innerHTML = `<div class="ai-spinner"></div> Generuję ${count} fiszek na temat "${topic}"...`;
  btn.disabled = true;

  const langPrompt = lang === "angielski"
    ? "Przód fiszki po angielsku, tył po polsku (tłumaczenie)."
    : lang === "mieszany"
      ? "Obie strony po angielsku."
      : "Obie strony po polsku.";

  const prompt = `Wygeneruj ${count} fiszek edukacyjnych na temat: "${topic}".
${langPrompt}
Odpowiedz WYŁĄCZNIE w formacie JSON (bez markdown):
{
  "deckName": "nazwa talii",
  "cards": [
    { "front": "przód fiszki", "back": "tył fiszki" }
  ]
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
        })
      }
    );
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Zapisz talię do Firestore
    const cards = parsed.cards.map(c => ({
      front: c.front, back: c.back,
      interval: 0, nextReview: null
    }));

    await addDoc(collection(db, "decks"), {
      uid: currentUser.uid,
      name: parsed.deckName || `AI: ${topic}`,
      description: `Wygenerowano przez AI — ${count} fiszek`,
      cards,
      createdAt: serverTimestamp(),
      generatedByAI: true
    });

    incrementGeminiUsage("gemini_usage_fc");
    trackAnalytics("ai_flashcards_generated", { topic, count: cards.length });
    pushActivity(`Wygenerowano talię AI: ${topic}`);
    closeAiFlashcardsModal();
    loadDecks();
    showToast(`Talia "${parsed.deckName || topic}" gotowa! 🎉`, "success");
  } catch (e) {
    statusEl.innerHTML = `✕ Błąd: ${e.message}`;
    console.error("Gemini flashcards error:", e);
  }
  btn.disabled = false;
};

// ─── ZAKŁADKI FISZEK ───
window.switchFlashcardsTab = function (tab) {
  document.getElementById("tab-decks").classList.toggle("active", tab === "decks");
  document.getElementById("tab-fc-stats").classList.toggle("active", tab === "stats");
  document.getElementById("decks-tab-content").style.display = tab === "decks" ? "" : "none";
  document.getElementById("fc-stats-tab-content").style.display = tab === "stats" ? "" : "none";
  if (tab === "stats") renderFcStats();
};

function renderFcStats() {
  const el = document.getElementById("fc-stats-content");
  if (!allDecks.length) {
    el.innerHTML = `<div class="empty-state"><p>Brak talii do wyświetlenia statystyk.</p></div>`;
    return;
  }
  el.innerHTML = allDecks.map(d => {
    const total = d.cards?.length || 0;
    const due = d.cards?.filter(c => !c.nextReview || toMs(c.nextReview) <= Date.now()).length || 0;
    const mastered = d.cards?.filter(c => c.interval >= 4).length || 0;
    const pct = total ? Math.round((mastered / total) * 100) : 0;
    return `
      <div class="fc-stat-card">
        <h3>${esc(d.name)}</h3>
        <div class="gemini-usage-bar-bg" style="margin-bottom:8px">
          <div class="gemini-usage-bar-fill" style="width:${pct}%;background:var(--accent-green)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;font-family:var(--font-mono)">
          <span style="color:var(--text-2)">Opanowane: <strong style="color:var(--accent-green)">${pct}%</strong></span>
          <span style="color:var(--accent-amber)">Do powtórki: ${due}</span>
        </div>
      </div>
    `;
  }).join("");
}

// ─────────────────────────────────────────────────────
// HISTORIA WYNIKÓW
// ─────────────────────────────────────────────────────
async function loadResults() {
  const q = query(
    collection(db, "results"),
    where("uid", "==", currentUser.uid),
    orderBy("createdAt", "desc")
  );
  try {
    const snap = await getDocs(q);
    const results = [];
    snap.forEach(d => results.push({ id: d.id, ...d.data() }));
    renderResults(results);
  } catch (e) {
    console.warn("Results index not ready:", e.message);
  }
}

function scoreClass(pct) {
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

function renderResults(results) {
  const chartEl = document.getElementById("results-chart");
  const listEl = document.getElementById("results-list");
  const emptyEl = document.getElementById("results-empty");
  if (!chartEl) return;

  if (!results.length) {
    chartEl.style.display = "none";
    listEl.innerHTML = "";
    emptyEl.style.display = "";
    return;
  }
  emptyEl.style.display = "none";
  chartEl.style.display = "";

  // Wykres — ostatnie 10 wyników (od najstarszego)
  const chartData = [...results].reverse().slice(-10);
  chartEl.innerHTML = `
    <h3>Ostatnie wyniki</h3>
    <div class="chart-bars">
      ${chartData.map(r => `
        <div class="chart-bar-wrap">
          <div class="chart-bar-value">${r.pct}%</div>
          <div class="chart-bar ${scoreClass(r.pct)}" style="height:${Math.max(r.pct, 4)}%" title="${esc(r.quizName)}: ${r.pct}%"></div>
          <div class="chart-bar-label">${esc(r.quizName)}</div>
        </div>
      `).join("")}
    </div>
  `;

  // Lista wyników
  listEl.innerHTML = results.map(r => `
    <div class="result-row">
      <div class="result-score ${scoreClass(r.pct)}">${r.pct}%</div>
      <div class="result-info">
        <p class="result-name">${esc(r.quizName)}</p>
        <p class="result-meta">${r.score} z ${r.total} poprawnych · ${formatDate(r.createdAt)}</p>
      </div>
    </div>
  `).join("");
}

// ─────────────────────────────────────────────────────
// TRYB OFFLINE
// ─────────────────────────────────────────────────────
function initOfflineDetection() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;

  function updateStatus() {
    if (navigator.onLine) {
      banner.classList.remove("show");
    } else {
      banner.classList.add("show");
    }
  }

  window.addEventListener("online", updateStatus);
  window.addEventListener("offline", updateStatus);
  updateStatus();
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

// ─────────────────────────────────────────────────────
// MOBILE — sidebar + bottom nav
// ─────────────────────────────────────────────────────
window.openSidebar = function () {
  document.querySelector('.sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('active');
};

window.closeSidebar = function () {
  document.querySelector('.sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
};

window.setActiveBottomNav = function (el) {
  document.querySelectorAll('.bottom-nav-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
};