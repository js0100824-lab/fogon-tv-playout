import { db, isConfigured } from "./firebase.js";
import { doc, onSnapshot, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { locate, expandChannel, cycleLength, itemLabel } from "./engine.js";
import { serverNow, startClock } from "./clock.js";

const $ = (id) => document.getElementById(id);
const sid = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 32);
const params = new URLSearchParams(location.search);
const embed = params.has("embed");
const studio = params.has("studio");   // vista previa del panel: es la señal maestra y no se corta con «Cortar emisión»
if (embed) document.body.classList.add("embed");

// Dos reproductores de archivo: mientras uno emite, el otro deja listo lo siguiente.
const slots = [{ el: $("fileA"), key: "", url: "" }, { el: $("fileB"), key: "", url: "" }];
let channel = null, sig = "", current = null, active = null, timer = null;
let liveCfg = null, liveKey = "";
let ytPlayer = null, ytReady = null, unmuted = false, lastLogged = "", lowerT = null;
const clockReady = startClock();

$("fs").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
function say(t) { if (liveCfg) t = ""; $("msg").textContent = t; $("msg").classList.toggle("hidden", !t); }
let onair = null;
const clockLoc = () => (channel?.items?.length ? locate(channel.items, channel.epoch, serverNow()) : null);
// El público sigue lo que realmente está emitiendo el Studio; si el Studio no está abierto, usa la parrilla con la hora del servidor.
function nowLoc() {
  const c = clockLoc();
  if (studio || !onair || !channel?.items?.length) return c;
  const now = serverNow();
  if (onair.epoch !== channel.epoch || onair.sig !== sig || now - onair.at > 40000) return c;
  const item = channel.items[onair.index];
  if (!item || item.id !== onair.id) return c;
  const filePos = onair.filePos + (now - onair.at) / 1000, offset = filePos - (item.startAt || 0);
  if (offset < -0.5 || offset >= item.duration) return c;
  const off = Math.max(0, offset);
  return { index: onair.index, item, offset: off, remaining: item.duration - off, filePos: (item.startAt || 0) + off };
}
function exposeOnAir(loc) {
  if (!studio || !channel) return;
  const v = active?.el;
  const pos = loc.item.src === "file" && v && v.readyState >= 2 ? v.currentTime : loc.filePos;
  window.__onair = { epoch: channel.epoch, sig, index: loc.index, id: loc.item.id, filePos: Math.round(pos * 100) / 100, at: Math.round(serverNow()) };
}
const keyOf = (loc) => `${channel.epoch}:${loc.index}:${loc.item.id}:${loc.item.startAt || 0}`;
const keyAt = (index) => { const it = channel.items[index]; return `${channel.epoch}:${index}:${it.id}:${it.startAt || 0}`; };

/* ---------- Marca ---------- */
const POS = { "top-left": ["top", "left"], "top-right": ["top", "right"], "bottom-left": ["bottom", "left"], "bottom-right": ["bottom", "right"] };
function applyBrand(b) {
  document.documentElement.style.setProperty("--accent", b.accent || "#0E6B73");
  document.title = b.name || "Transmisión en vivo";
  // El nombre del canal solo se muestra si el operador lo pide; por defecto solo se ve su logo.
  const showName = b.showName === true && !!b.name;
  $("name").textContent = b.name || ""; $("name").classList.toggle("hidden", !showName);
  const logo = $("logo");
  if (b.logo) logo.src = b.logo;
  logo.classList.toggle("hidden", !b.logo);
  Object.assign(logo.style, { top: "", right: "", bottom: "", left: "" });
  const [v, h] = POS[b.logoPos] || POS["top-right"];
  logo.style[v] = "3%"; logo.style[h] = "3%";
  logo.style.width = `${Math.min(40, Math.max(4, Number(b.logoSize) || 14))}%`;
  logo.style.opacity = String(Math.min(1, Math.max(0.1, b.logoOpacity ?? 0.9)));
  $("ticker").textContent = b.ticker || ""; $("ticker").classList.toggle("hidden", !b.ticker);
  $("name").style.top = b.logoPos === "top-left" ? "auto" : "3%"; $("name").style.bottom = b.logoPos === "top-left" ? "12%" : "auto";
}

function lowerThird(item) {
  if (item.type === "programa" && item.part > 1) return;   // al volver de los anuncios no se repite el rótulo
  const el = $("lower");
  el.querySelector("small").textContent = item.type === "comercial" ? "PUBLICIDAD" : "AHORA";
  el.querySelector("b").textContent = item.title;
  el.classList.add("show"); clearTimeout(lowerT); lowerT = setTimeout(() => el.classList.remove("show"), 7000);
}

/* ---------- Estado de la emisión ---------- */
if (!isConfigured) say("Falta configurar Firebase.");
else {
  onSnapshot(doc(db, "public", "brand"), (s) => applyBrand(s.data() || {}), () => {});
  onSnapshot(doc(db, "public", "live"), (s) => {
    const d = s.exists() ? s.data() : null, was = !!liveCfg;
    liveCfg = d && d.on && d.ref ? d : null;
    if (liveCfg) { const k = `${liveCfg.kind}|${liveCfg.ref}`; if (k !== liveKey || !was) startLive(); liveKey = k; }
    else { liveKey = ""; if (was) endLive(); }
  }, () => {});
  if (!studio) onSnapshot(doc(db, "public", "onair"), (s) => { onair = s.exists() ? s.data() : null; }, () => {});
  onSnapshot(doc(db, "public", "channel"), async (s) => {
    const data = s.exists() ? s.data() : null;
    const items = data ? expandChannel(data) : [];
    if (!items.length) { channel = null; sig = ""; stop(); say("Sin programación publicada por ahora."); return; }
    const newSig = `${data.epoch}|${items.length}|${Math.round(cycleLength(items))}|${items[0].id}|${items.at(-1).id}`;
    const wasLive = channel ? channel.live !== false : false;
    channel = { epoch: data.epoch, items, live: studio ? true : data.live !== false };
    if (!channel.live) { stop(); say("Transmisión en pausa. Volvemos pronto."); return; }
    await clockReady;
    // Si solo cambió "cortar/reanudar" no se reinicia lo que ya está sonando.
    if (newSig !== sig) { slots.forEach((x) => { x.key = ""; }); current = null; }
    sig = newSig;
    if (!wasLive || !current) current = null;
    tick(false);
  }, () => say("No se pudo conectar con la emisión."));
}

function stop() {
  clearTimeout(timer); current = null; active = null;
  for (const x of slots) { x.el.pause(); x.el.removeAttribute("src"); x.el.classList.add("hidden"); x.key = ""; x.url = ""; }
  ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden"); hideFB();
}

// Decide qué toca ahora según la hora del servidor y vuelve a decidir justo al terminar el tramo.
function tick(force) {
  clearTimeout(timer);
  if (liveCfg) return;
  if (!channel?.items?.length || channel.live === false) return;
  const loc = nowLoc(); if (!loc) return;
  const key = keyOf(loc);
  say("");
  if (force || !current || current.key !== key) begin(loc, key);
  timer = setTimeout(() => tick(false), Math.max(80, loc.remaining * 1000 + 25));
}

function begin(loc, key) {
  current = { key, index: loc.index };
  exposeOnAir(loc);
  lowerThird(loc.item);
  log(loc.item, key);
  if (loc.item.src === "file") playFile(loc, key); else if (loc.item.src === "facebook") playFB(loc); else playYT(loc);
}

/* ---------- Archivos de video ---------- */
function prime(slot, item, key) {
  const v = slot.el;
  slot.key = key;
  if (slot.url !== item.ref) { slot.url = item.ref; v.src = item.ref; v.preload = "auto"; v.load(); }
  const seekStart = () => { try { v.currentTime = Math.min(item.startAt || 0, Math.max(0, (v.duration || item.startAt || 0) - 0.3)); } catch { /* aún no listo */ } };
  if (v.readyState >= 1) seekStart(); else v.addEventListener("loadedmetadata", seekStart, { once: true });
  v.onerror = () => { if (current && slot === active) say(`No se pudo cargar “${item.title}”. Continuará con el siguiente elemento.`); };
}

function playFile(loc, key) {
  hideFB(); ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden"); $("ytmask").classList.add("hidden");
  let slot = slots.find((x) => x.key === key);
  if (!slot) { slot = slots.find((x) => x !== active) || slots[0]; prime(slot, loc.item, key); }
  const previous = active;
  active = slot;
  const v = slot.el;
  v.classList.remove("hidden"); v.style.zIndex = 2;
  const go = () => {
    if (!current || current.key !== key) return;
    const l = nowLoc(); if (!l || keyOf(l) !== key) return;           // se pasó de tramo mientras cargaba
    const want = l.filePos;                                           // posición recalculada AHORA, no al pedir el video
    try { if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = Math.min(want, Math.max(0, (v.duration || want) - 0.3)); } catch { /* se corrige en el control */ }
    v.muted = !unmuted; v.playbackRate = 1;
    v.play().catch(needTap);
  };
  if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  // Se oculta el reproductor anterior cuando el nuevo ya está mostrando imagen (sin parpadeo negro).
  const hidePrev = () => { if (previous && previous !== slot) { previous.el.pause(); previous.el.classList.add("hidden"); previous.el.style.zIndex = 1; } };
  v.addEventListener("playing", hidePrev, { once: true }); setTimeout(hidePrev, 1500);
}

// En los últimos segundos del tramo deja listo el siguiente en el reproductor libre.
function maybePreload(loc) {
  if (loc.remaining > 25) return;
  const n = channel.items.length, ni = (loc.index + 1) % n, nx = channel.items[ni];
  if (nx.src !== "file") return;
  const nkey = keyAt(ni);
  if (nkey === current.key || slots.some((x) => x.key === nkey)) return;
  const idle = slots.find((x) => x !== active); if (!idle) return;
  prime(idle, nx, nkey);
}

/* ---------- Facebook y directos ---------- */
function hideFB() { const f = $("fb"); f.classList.add("hidden"); f.classList.remove("live"); if (f.getAttribute("src")) f.removeAttribute("src"); }
function showFB(href, startSec, isLive) {
  const f = $("fb");
  let h = href;
  if (!isLive && startSec >= 3) h += `${h.includes("?") ? "&" : "?"}t=${Math.floor(startSec)}`;
  f.src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(h)}&show_text=false&autoplay=true&mute=${unmuted ? 0 : 1}&width=1920&height=1080`;
  f.classList.toggle("live", !!isLive); f.classList.remove("hidden");
}
function playFB(loc) {
  $("ytmask").classList.add("hidden");
  for (const x of slots) { x.el.pause(); x.el.classList.add("hidden"); }
  active = null; ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden");
  showFB(loc.item.ref, (nowLoc() || loc).filePos, false);
}
function startLive() {
  clearTimeout(timer); clearTimeout(ytMaskT); current = null;
  stop(); say(""); $("ytmask").classList.add("hidden"); $("prog").style.width = "0"; $("lower").classList.remove("show");
  if (liveCfg.kind === "facebook") showFB(liveCfg.ref, 0, true);
  else {
    $("yt").classList.remove("hidden");
    loadYT().then(() => { if (!liveCfg || liveCfg.kind !== "youtube") return; ytPlayer.loadVideoById({ videoId: liveCfg.ref }); unmuted ? ytPlayer.unMute() : ytPlayer.mute(); });
  }
}
function endLive() {
  stop(); current = null; slots.forEach((x) => { x.key = ""; });
  clockReady.then(() => tick(false));
}

/* ---------- YouTube ---------- */
let ytMaskT = null;
function playYT(loc) {
  hideFB();
  // YouTube muestra su título y canal al empezar: se oculta con una banda negra los primeros segundos.
  $("ytmask").classList.remove("hidden"); clearTimeout(ytMaskT); ytMaskT = setTimeout(() => $("ytmask").classList.add("hidden"), 8000);
  for (const x of slots) { x.el.pause(); x.el.classList.add("hidden"); }
  active = null;
  $("yt").classList.remove("hidden");
  loadYT().then(() => {
    if (!current) return;
    const l = nowLoc() || loc;
    ytPlayer.loadVideoById({ videoId: l.item.ref, startSeconds: Math.floor(l.filePos) });
    unmuted ? ytPlayer.unMute() : ytPlayer.mute();
  });
}
function loadYT() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      ytPlayer = new YT.Player("yt", {
        width: "100%", height: "100%",
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, mute: 1, iv_load_policy: 3, fs: 0, cc_load_policy: 0 },
        events: { onReady: () => resolve(), onError: () => say("No se pudo reproducir un video de YouTube.") }
      });
    };
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(s);
  });
  return ytReady;
}

/* ---------- Sonido ---------- */
function needTap() { if (!unmuted && !embed) $("sound").classList.remove("hidden"); }
$("sound").addEventListener("click", () => {
  unmuted = true; $("sound").classList.add("hidden");
  for (const x of slots) x.el.muted = false;
  active?.el.play().catch(() => {});
  ytPlayer?.unMute?.(); ytPlayer?.playVideo?.();
});
setTimeout(() => { if (!unmuted && channel && !embed) $("sound").classList.remove("hidden"); }, 1500);

/* ---------- Control de sincronía (cada segundo) ---------- */
function watch() {
  if (liveCfg) return;
  if (!channel?.items?.length || channel.live === false || !current) return;
  const loc = nowLoc(); if (!loc) return;
  if (keyOf(loc) !== current.key) { tick(false); return; }
  exposeOnAir(loc);
  $("prog").style.width = `${(loc.offset / loc.item.duration) * 100}%`;
  maybePreload(loc);
  if (loc.item.src === "file" && active) {
    const v = active.el;
    if (v.readyState < 3 && !v.ended) return;                          // cargando: se espera
    const drift = v.currentTime - loc.filePos;                         // + adelantado, − atrasado
    if (Math.abs(drift) > 2 || v.ended) {
      try { v.currentTime = Math.min(loc.filePos, Math.max(0, (v.duration || loc.filePos) - 0.3)); } catch { /* reintenta */ }
      v.playbackRate = 1;
    } else if (Math.abs(drift) > 0.3) v.playbackRate = drift > 0 ? 0.94 : 1.06;   // se acerca sin saltos
    else if (v.playbackRate !== 1) v.playbackRate = 1;
    if (v.paused) v.play().catch(() => {});
  } else if (loc.item.src === "youtube" && ytPlayer?.getPlayerState) {
    const st = ytPlayer.getPlayerState(), dur = ytPlayer.getDuration?.() || 0;
    // Solo corrige con el video real (no con un anuncio de YouTube): su duración coincide con la del archivo.
    const full = loc.item.parts > 1 ? Math.abs(dur - loc.item.duration) > 3 : Math.abs(dur - loc.item.duration) < 3;
    if (st === 1 && (loc.item.parts > 1 || full) && Math.abs(ytPlayer.getCurrentTime() - loc.filePos) > 2) ytPlayer.seekTo(loc.filePos, true);
    else if (st === 5 || st === -1 || st === 2) ytPlayer.playVideo?.();
  }
}
setInterval(watch, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { tick(false); watch(); } });

async function log(item, key) {
  if (embed || key === lastLogged || (item.type === "programa" && item.part > 1)) return; lastLogged = key;
  try { await addDoc(collection(db, "stats"), { at: serverTimestamp(), sid, title: String(item.title).slice(0, 200), type: item.type }); } catch { /* sin registro */ }
}
