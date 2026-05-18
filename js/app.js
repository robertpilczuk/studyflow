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
      showAuth();
    }
  });
});


// ─────────────────────────────────────────────────────
// EMAIL VERIFICATION
// ─────────────────────────────────────────────────────
function showVerificationScreen() {
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
  document.getElementById("auth-screen").style.display = "";
  document.getElementById("app").style.display = "none";
}

function showApp() {
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
        <span class="quiz-badge">${q.questions.length} pytań</span>
      </div>
      <p class="quiz-card-meta">Utworzono: ${formatDate(q.createdAt)}</p>
      <div class="quiz-card-actions">
        <button class="btn-primary sm" onclick="startQuiz('${q.id}')">Rozwiąż</button>
        <button class="btn-ghost" onclick="editQuiz('${q.id}')">Edytuj</button>
        <button class="btn-ghost" onclick="deleteQuiz('${q.id}')">Usuń</button>
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