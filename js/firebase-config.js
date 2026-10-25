// Configuración PÚBLICA de Firebase (no es un secreto).
// La seguridad real la dan las reglas de Firestore y Storage, no este archivo.
export const firebaseConfig = {
  apiKey: "AIzaSyAJQ9MZv-oJ1MdDNrErmrW8ubq5XVSBfZc",
  authDomain: "fogon-tv-playout.firebaseapp.com",
  projectId: "fogon-tv-playout",
  storageBucket: "fogon-tv-playout.firebasestorage.app",
  messagingSenderId: "277844059869",
  appId: "1:277844059869:web:e0f5f92e04031053aadd34"
};

export const isConfigured = !Object.values(firebaseConfig).some((v) => String(v).includes("REEMPLAZAR"));
