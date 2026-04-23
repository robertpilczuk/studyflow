// INSTRUKCJA:
// Skopiuj ten plik jako firebase-config.js i uzupełnij swoimi danymi
// z Firebase Console → Project Settings → Your apps

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getRemoteConfig, fetchAndActivate, getValue }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-remote-config.js";
import { getAnalytics, logEvent }
    from "https://www.gstatic.com/firebasejs/10.12.0/firebase-analytics.js";

const firebaseConfig = {
    apiKey: "TWOJ_API_KEY",
    authDomain: "TWOJ_PROJEKT.firebaseapp.com",
    databaseURL: "https://TWOJ_PROJEKT-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "TWOJ_PROJEKT",
    storageBucket: "TWOJ_PROJEKT.appspot.com",
    messagingSenderId: "TWOJ_SENDER_ID",
    appId: "TWOJA_APP_ID",
    measurementId: "G-TWOJ_MEASUREMENT_ID"
};