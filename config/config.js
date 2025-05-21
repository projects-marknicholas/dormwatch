import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCcd6yab2CEHCWj_rjAaPClpgeCtCStw8g",
  authDomain: "dorm-watch-c02da.firebaseapp.com",
  projectId: "dorm-watch-c02da",
  storageBucket: "dorm-watch-c02da.firebasestorage.app",
  messagingSenderId: "153081630089",
  appId: "1:153081630089:web:7bf865a347b4af679be558",
  measurementId: "G-1JBBKK55WP"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };