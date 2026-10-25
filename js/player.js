import { db, isConfigured } from "./firebase.js";
import { doc, onSnapshot, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { locate } from "./engine.js";

const $ = (id) => document.getElementById(id);
const sid = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 32);
let channel = null, current = null, timer = null, ytPlayer = null, ytReady = null, unmuted = false;
let lastLogged = "";
const embed = new URLSearchParams(location.search).has("embed");
if (embed) document.body.classList.add("embed");
let lowerT = null;
$("fs").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
setInterval(() => {
  if (!channel?.items?.length) return;
  const l = locate(channel.items, channel.epoch, Date.now());
  if (l) $("prog").style.width = `${(l.offset / l.item.duration) * 100}%`;
}, 1000);
function lowerThird(item) {
  const el = $("lower");
  el.querySelector("small").textContent = item.type === "comercial" ? "PUBLICIDAD" : "AHORA";
  el.querySelector("b").textContent = item.title;
  el.classList.add("show"); clearTimeout(lowerT); lowerT = setTimeout(() => el.classList.remove("show"), 7000);
}

function say(t) { $("msg").textContent = t; $("msg").classList.toggle("hidden", !t); }

if (!isConfigured) say("Falta configurar Firebase.");
else {
  onSnapshot(doc(db, "public", "brand"), (s) => applyBrand(s.data() || {}), () => {});
  onSnapshot(doc(db, "public", "channel"), (s) => {
    channel = s.exists() ? s.data() : null;
    if (!channel?.items?.length) { stop(); say("Sin programación publicada por ahora."); return; }
    tick(true);
  }, () => say("No se pudo conectar con la emisión."));
}

function applyBrand(b) {
  document.documentElement.style.setProperty("--accent", b.accent || "#0E6B73");
  document.title = b.name || "Fogón TV";
  $("name").textContent = b.name || ""; $("name").classList.toggle("hidden", !b.name);
  if (b.logo) { $("logo").src = b.logo; } $("logo").classList.toggle("hidden", !b.logo);
  $("ticker").textContent = b.ticker || ""; $("ticker").classList.toggle("hidden", !b.ticker);
}

function stop() {
  clearTimeout(timer); current = null;
  const v = $("file"); v.pause(); v.removeAttribute("src"); v.classList.add("hidden");
  ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden");
}

// Decide qué toca ahora según el reloj; vuelve a decidir exactamente al terminar el elemento.
function tick(force) {
  clearTimeout(timer);
  const loc = locate(channel.items, channel.epoch, Date.now());
  if (!loc) return;
  const key = `${loc.index}:${loc.item.id}:${channel.epoch}`;
  say("");
  if (force || !current || current.key !== key) {
    current = { key };
    play(loc.item, loc.offset);
    lowerThird(loc.item);
    log(loc.item, key);
  } else {
    sync(loc);
  }
  timer = setTimeout(() => tick(false), Math.max(250, loc.remaining * 1000 + 50));
}

// Corrige desvío si el reproductor se atrasó más de 3 segundos.
function sync(loc) {
  if (loc.item.src === "file") { const v = $("file"); if (Math.abs(v.currentTime - loc.offset) > 3) v.currentTime = loc.offset; }
  else if (ytPlayer?.getCurrentTime && Math.abs(ytPlayer.getCurrentTime() - loc.offset) > 3) ytPlayer.seekTo(loc.offset, true);
}

function play(item, offset) {
  if (item.src === "file") {
    ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden");
    const v = $("file"); v.classList.remove("hidden"); v.muted = !unmuted;
    v.src = item.ref;
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(offset, Math.max(0, (v.duration || offset) - 0.5)); } catch {} v.play().catch(needTap); };
    v.onerror = () => say(`No se pudo cargar “${item.title}”. Continuará con el siguiente elemento.`);
  } else {
    const v = $("file"); v.pause(); v.removeAttribute("src"); v.classList.add("hidden");
    $("yt").classList.remove("hidden");
    loadYT().then(() => {
      if (!current) return;
      ytPlayer.loadVideoById({ videoId: item.ref, startSeconds: Math.floor(offset) });
      unmuted ? ytPlayer.unMute() : ytPlayer.mute();
    });
  }
}

function needTap() { if (!unmuted && !embed) $("sound").classList.remove("hidden"); }
$("sound").addEventListener("click", () => {
  unmuted = true; $("sound").classList.add("hidden");
  const v = $("file"); v.muted = false; v.play().catch(() => {});
  ytPlayer?.unMute?.(); ytPlayer?.playVideo?.();
});
// Los navegadores bloquean autoplay con sonido: arranca en silencio y ofrece activar el sonido.
setTimeout(() => { if (!unmuted && channel && !embed) $("sound").classList.remove("hidden"); }, 1500);

function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player("yt", {
        width: "100%", height: "100%",
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, mute: 1 },
        events: { onReady: () => resolve(), onError: () => say("No se pudo reproducir un video de YouTube.") }
      });
    };
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s);
  });
  return ytReady;
}

async function log(item, key) {
  if (embed || key === lastLogged) return; lastLogged = key;
  try { await addDoc(collection(db, "stats"), { at: serverTimestamp(), sid, title: String(item.title).slice(0, 200), type: item.type }); } catch {}
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && channel?.items?.length) tick(true); });
