# StudyFlow 📚
Aplikacja do zarządzania notatkami i quizami oparta na platformie Firebase.

## Wykorzystane usługi Firebase

| # | Usługa | Zastosowanie |
|---|--------|--------------|
| 1 | **Firebase Authentication** | Logowanie i rejestracja użytkowników (e-mail + hasło) |
| 2 | **Cloud Firestore** | Przechowywanie notatek, quizów i wyników |
| 3 | **Realtime Database** | Feed aktywności użytkownika w czasie rzeczywistym |
| 4 | **Remote Config** | Zdalna konfiguracja: limity notatek, włączanie quizów |
| 5 | **Firebase Analytics** | Śledzenie zdarzeń: logowanie, tworzenie notatek, wyniki quizów |
| 6 | **Firebase Hosting** | Publikacja aplikacji (patrz sekcja wdrożenia) |

---

## Konfiguracja projektu Firebase

### 1. Utwórz projekt w Firebase Console
1. Wejdź na [console.firebase.google.com](https://console.firebase.google.com)
2. Kliknij **Add project** → podaj nazwę (np. `studyflow-app`)
3. Włącz Google Analytics (wymagane dla Firebase Analytics)

### 2. Dodaj aplikację webową
1. W projekcie kliknij ikonę `</>` (Web)
2. Wpisz nazwę aplikacji, zaznacz **Firebase Hosting**
3. Skopiuj obiekt `firebaseConfig`

### 3. Uzupełnij konfigurację
Otwórz plik `js/firebase-config.js` i zastąp wartości w `firebaseConfig`:

```javascript
const firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "twoj-projekt.firebaseapp.com",
  databaseURL:       "https://twoj-projekt-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "twoj-projekt",
  storageBucket:     "twoj-projekt.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123",
  measurementId:     "G-XXXXXXXXXX"
};
```

### 4. Włącz usługi Firebase

#### Authentication
Console → Authentication → **Get started** → Sign-in method → Email/Password → **Enable**

#### Cloud Firestore
Console → Firestore Database → **Create database** → Start in test mode → wybierz region (europe-west)

Reguły bezpieczeństwa (`Firestore → Rules`):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth.uid == userId;
    }
    match /notes/{noteId} {
      allow read, write, delete: if request.auth.uid == resource.data.uid;
      allow create: if request.auth != null;
    }
    match /quizzes/{quizId} {
      allow read, write, delete: if request.auth.uid == resource.data.uid;
      allow create: if request.auth != null;
    }
    match /results/{resultId} {
      allow read, write: if request.auth.uid == resource.data.uid;
      allow create: if request.auth != null;
    }
  }
}
```

#### Realtime Database
Console → Realtime Database → **Create database** → Start in test mode → region europe-west1

Reguły (`Realtime Database → Rules`):
```json
{
  "rules": {
    "activity": {
      "$uid": {
        ".read":  "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    }
  }
}
```

#### Remote Config
Console → Remote Config → **Add parameter**

Dodaj następujące parametry:
| Klucz | Typ | Wartość domyślna |
|-------|-----|-----------------|
| `max_notes_per_user` | Number | `50` |
| `max_questions_per_quiz` | Number | `20` |
| `quizzes_enabled` | Boolean | `true` |
| `app_banner_message` | String | *(puste)* |
| `app_theme` | String | `dark` |

Po dodaniu kliknij **Publish changes**.

#### Firebase Analytics
Włączone automatycznie przy tworzeniu projektu z Google Analytics.
Zdarzenia rejestrowane w aplikacji:
- `sign_up` — rejestracja
- `login` — logowanie
- `logout` — wylogowanie
- `page_view` — zmiana sekcji (dashboard / notes / quizzes / analytics)
- `note_created` / `note_updated` / `note_deleted`
- `quiz_created` / `quiz_deleted`
- `quiz_started` / `quiz_completed`

---

## Lokalne uruchomienie

Aplikacja używa ES Modules z importami Firebase SDK przez CDN (`gstatic.com`), więc **musi być serwowana przez HTTP** (nie otwieraj `index.html` bezpośrednio).

### Opcja A — Firebase CLI (zalecane)
```bash
npm install -g firebase-tools
firebase login
firebase init           # wybierz Hosting, wskaż folder: .
firebase serve          # lokalny serwer na http://localhost:5000
```

### Opcja B — dowolny lokalny serwer
```bash
# Python
python -m http.server 8080

# Node.js (npx)
npx serve .

# VS Code — rozszerzenie Live Server
```

---

## Wdrożenie na Firebase Hosting

```bash
# 1. Zainstaluj Firebase CLI
npm install -g firebase-tools

# 2. Zaloguj się
firebase login

# 3. Zainicjuj Hosting w katalogu projektu
firebase init hosting
# → Use an existing project → wybierz swój projekt
# → Public directory: . (kropka — bieżący katalog)
# → Single-page app: No
# → Overwrite index.html: No

# 4. Wdróż
firebase deploy --only hosting
```

Po wdrożeniu aplikacja dostępna pod adresem:
`https://TWOJ_PROJEKT.web.app`

---

## Struktura projektu

```
studyflow/
├── index.html              # Główny plik HTML (auth + app + modale)
├── css/
│   └── style.css           # Design system (ciemny motyw, Syne + DM Sans)
├── js/
│   ├── firebase-config.js  # Inicjalizacja 6 usług Firebase
│   └── app.js              # Logika aplikacji
├── firebase.json           # Konfiguracja Firebase Hosting (po firebase init)
└── README.md               # Dokumentacja
```

---

## Architektura danych (Firestore)

```
users/{uid}
  name: string
  email: string
  createdAt: timestamp
  notesCount: number
  quizzesCount: number
  attempts: number
  totalScore: number

notes/{noteId}
  uid: string
  title: string
  content: string
  createdAt: timestamp
  updatedAt?: timestamp

quizzes/{quizId}
  uid: string
  name: string
  questions: [
    { text, options: [A,B,C,D], correct: 0-3 }
  ]
  createdAt: timestamp

results/{resultId}
  uid: string
  quizId: string
  quizName: string
  score: number
  total: number
  pct: number
  createdAt: timestamp
```

Realtime Database:
```
activity/{uid}/{pushId}
  msg: string
  ts: number (Unix ms)
```
