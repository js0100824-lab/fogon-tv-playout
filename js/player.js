import { db, isConfigured } from "./firebase.js";
import { doc, getDoc, onSnapshot, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { locate, expandChannel, cycleLength, itemLabel } from "./engine.js?v=28";
import { serverNow, startClock } from "./clock.js";

const $ = (id) => document.getElementById(id);
const sid = (crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 32);
const params = new URLSearchParams(location.search);
const embed = params.has("embed");
const studio = params.has("studio");   // vista previa del panel: es la señal maestra y no se corta con «Cortar emisión»
const obs = params.has("obs");   // en OBS el audio se permite solo: sin botón de sonido
if (embed) document.body.classList.add("embed");
if (obs) document.body.classList.add("obs");
if (studio) document.body.classList.add("studio");   // solo el Studio puede tocar el video; el público no

// Dos reproductores de archivo: mientras uno emite, el otro deja listo lo siguiente.
const slots = [{ el: $("fileA"), key: "", url: "" }, { el: $("fileB"), key: "", url: "" }];
let channel = null, sig = "", current = null, active = null, timer = null;
let liveCfg = null, liveKey = "";
let fbPauseCount = 0, fbUnmutedAt = 0, soundBlocked = false;   // soundBlocked: el navegador no dejó activar el sonido de Facebook sin un toque del usuario
let fbPlayer = null, fbPaused = false, fbEnded = false, fbSyncAt = Infinity, ytPlayed = false, restored = false;
let ytPlayer = null, ytReady = null, unmuted = obs, lastLogged = "", lowerT = null;
const clockReady = startClock();

$("fs").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); });
// En pantalla completa (botón o F11) el botón desaparece; se sale con Esc / F11.
function syncFs() {
  const full = !!(document.fullscreenElement || document.webkitFullscreenElement) || (innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2);
  document.body.classList.toggle("isfs", full);
}
document.addEventListener("fullscreenchange", syncFs); document.addEventListener("webkitfullscreenchange", syncFs); addEventListener("resize", syncFs); syncFs();
function say(t) { if (liveCfg) t = ""; $("msg").textContent = t; $("msg").classList.toggle("hidden", !t); }
let onair = null;
// En el Studio (vista previa) manda el VIDEO: `shift` mueve la hora de la barra para que siga al video y nunca se le obliga a saltar.
let shift = 0;
const clockLoc = () => {
  if (!channel?.items?.length) return null;
  const now = serverNow(), loc = locate(channel.items, channel.epoch + shift, now);
  if (loc) loc.loop = Math.floor((now - (channel.epoch + shift)) / 1000 / cycleLength(channel.items));   // nº de vuelta: así un ciclo de un solo video también se reinicia
  return loc;
};
// El público sigue lo que emite el Studio: de public/onair se calcula `shift` y desde ahí corre solo (sin saltos si el Studio se cierra o recarga).
function nowLoc() { return clockLoc(); }
function shiftFromOnair(o, sg) {
  const items = channel?.items; if (!o || !items?.length) return null;
  const item = items[o.index];
  if (!item || o.epoch !== channel.epoch || o.sig !== sg || o.id !== item.id) return null;
  let before = 0; for (let k = 0; k < o.index; k++) before += items[k].duration;
  const pos = studio && o.p ? o.filePos : o.filePos + (serverNow() - o.at) / 1000;
  const total = cycleLength(items) * 1000;
  let sh = (serverNow() - channel.epoch) - (before + pos - (item.startAt || 0)) * 1000;
  sh = ((sh % total) + total) % total; if (sh > total / 2) sh -= total;
  return sh;
}
function applyOnair() {
  const sh = shiftFromOnair(onair, sig); if (sh === null) return;
  const moved = Math.abs(sh - shift) > 300; shift = sh;
  if (moved && current) tick(false);
}
let lastSeekAt = 0;
function exposeOnAir(loc) {
  if (!studio || !channel) return;
  const m = mediaState(loc);
  const pos = m ? m.pos : loc.filePos;
  window.__onair = { epoch: channel.epoch, sig, index: loc.index, id: loc.item.id, filePos: Math.round(pos * 100) / 100, at: Math.round(serverNow()), p: m?.paused ? 1 : 0 };
}
// Posición y pausa REALES del video que se está viendo (null si aún no se puede saber).
function mediaState(loc) {
  const it = loc.item;
  try {
    if (it.src === "file" && active) {
      const v = active.el;
      if (v.readyState >= 2 && !v.seeking && !v.ended) return { pos: v.currentTime, paused: v.paused && !v.ended, played: !!active.played, thr: 0.3 };
    } else if (it.src === "facebook" && fbPlayer && !fbEnded && Date.now() > fbSyncAt) {
      const p = fbPlayer.getCurrentPosition?.();
      if (Number.isFinite(p)) return { pos: p, paused: fbPaused, played: true, thr: 1.2 };
    } else if (it.src === "youtube" && ytPlayer?.getPlayerState) {
      const st = ytPlayer.getPlayerState(), dur = ytPlayer.getDuration?.() || 0;
      const full = it.parts > 1 ? Math.abs(dur - it.duration) > 3 : Math.abs(dur - it.duration) < 3;   // no un anuncio de YouTube
      if (st === 1) ytPlayed = true;
      if (full && (st === 1 || st === 2)) return { pos: ytPlayer.getCurrentTime(), paused: st === 2, played: ytPlayed, thr: 0.5 };
    }
  } catch { /* el reproductor aún no está listo */ }
  return null;
}
// Al abrir o recargar el Studio, retoma donde iba (usa lo último guardado en public/onair).
async function restoreShift(newSig) {
  const snap = await getDoc(doc(db, "public", "onair")); if (!snap.exists()) return;
  const sh = shiftFromOnair(snap.data(), newSig); if (sh !== null) shift = sh;
}
const keyOf = (loc) => `${channel.epoch}:${loc.index}:${loc.item.id}:${loc.item.startAt || 0}:${loc.loop || 0}`;
const keyAt = (index, loop) => { const it = channel.items[index]; return `${channel.epoch}:${index}:${it.id}:${it.startAt || 0}:${loop || 0}`; };

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
  if (!studio) onSnapshot(doc(db, "public", "onair"), (s) => { onair = s.exists() ? s.data() : null; applyOnair(); }, () => {});
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
    if (newSig !== sig) { slots.forEach((x) => { x.key = ""; }); current = null; shift = 0; }
    sig = newSig;
    if (!studio) applyOnair();
    if (studio && !restored) { restored = true; try { await restoreShift(newSig); } catch { /* sin datos guardados */ } }
    if (!wasLive || !current) current = null;
    tick(false);
  }, () => say("No se pudo conectar con la emisión."));
}

function stop() {
  clearTimeout(timer); current = null; active = null;
  for (const x of slots) { x.el.pause(); x.el.removeAttribute("src"); x.el.classList.add("hidden"); x.el.style.opacity = ""; x.key = ""; x.url = ""; }
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
  setTimeout(() => { if ((!unmuted || soundBlocked) && current) needTap(); }, 1200);   // el botón «toca para ver» siempre aparece si aún no hay sonido
}

/* ---------- Archivos de video ---------- */
function prime(slot, item, key) {
  const v = slot.el;
  slot.key = key; slot.played = false; v.onplaying = () => { slot.played = true; };
  if (slot.url !== item.ref) { slot.url = item.ref; v.src = item.ref; v.preload = "auto"; v.load(); }
  const seekStart = () => { try { v.currentTime = Math.min(item.startAt || 0, Math.max(0, (v.duration || item.startAt || 0) - 0.3)); } catch { /* aún no listo */ } };
  if (v.readyState >= 1) seekStart(); else v.addEventListener("loadedmetadata", seekStart, { once: true });
  v.onerror = () => { if (current && slot === active) say(`No se pudo cargar “${item.title}”. Continuará con el siguiente elemento.`); };
}

/* ---------- Transiciones suaves ---------- */
const FADE_MS = 700;
function rampVolume(el, to, ms) {
  clearInterval(el._vr); el._ramping = true;
  const from = Number.isFinite(el.volume) ? el.volume : 1, t0 = Date.now();
  el._vr = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / ms);
    try { el.volume = Math.max(0, Math.min(1, from + (to - from) * k)); } catch { /* sin control de volumen */ }
    if (k >= 1) { clearInterval(el._vr); el._ramping = false; }
  }, 40);
}
function fadeIn(el) { el.style.transition = `opacity ${FADE_MS}ms ease`; el.style.opacity = "1"; try { el.volume = 0; } catch { /* iOS */ } rampVolume(el, 1, FADE_MS); }
function fadeOutHide(x, keepIf) {   // x: ranura; se atenúa y luego se oculta si nadie la volvió a usar
  x.el.style.transition = `opacity ${FADE_MS}ms ease`; x.el.style.opacity = "0"; rampVolume(x.el, 0, FADE_MS);
  setTimeout(() => { if (keepIf && keepIf(x)) return; x.el.pause(); x.el.classList.add("hidden"); x.el.style.zIndex = 1; x.el.style.opacity = ""; try { x.el.volume = 1; } catch { /* iOS */ } }, FADE_MS + 60);
}
// Para YouTube/Facebook (iframes): un fundido a negro breve mientras cargan.
let dipT = null;
function dip() {
  const d = $("dip"); clearTimeout(dipT);
  d.style.transition = "opacity .3s ease"; d.style.opacity = "1";
  dipT = setTimeout(() => { d.style.transition = "opacity .9s ease"; d.style.opacity = "0"; }, 1800);
}

function playFile(loc, key) {
  hideFB(); ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden"); $("ytmask").classList.add("hidden");
  let slot = slots.find((x) => x.key === key);
  if (!slot) { slot = slots.find((x) => x !== active) || slots[0]; prime(slot, loc.item, key); }
  const previous = active;
  active = slot;
  const v = slot.el;
  v.classList.remove("hidden"); v.style.zIndex = 2;
  v.muted = !unmuted || soundBlocked;   // el video precargado nace silenciado (atributo muted): se corrige YA, no solo cuando carga
  const fresh = previous !== slot;
  if (fresh) { v.style.transition = "none"; v.style.opacity = "0"; void v.offsetWidth; }   // entra desde transparente y se funde sobre el anterior
  const go = () => {
    if (!current || current.key !== key) return;
    const l = nowLoc(); if (!l || keyOf(l) !== key) return;           // se pasó de tramo mientras cargaba
    const want = l.filePos;                                           // posición recalculada AHORA, no al pedir el video
    try { if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = Math.min(want, Math.max(0, (v.duration || want) - 0.3)); } catch { /* se corrige en el control */ }
    v.muted = !unmuted || soundBlocked; v.playbackRate = 1;
    v.play().catch(needTap);
  };
  if (v.readyState >= 1) go(); else v.addEventListener("loadedmetadata", go, { once: true });
  // Se oculta el reproductor anterior cuando el nuevo ya está mostrando imagen (sin parpadeo negro).
  let shown = false;
  const showNew = () => {
    if (shown || active !== slot) return; shown = true;
    if (fresh) fadeIn(v);
    if (previous && previous !== slot) fadeOutHide(previous, (x) => x === active);
  };
  v.addEventListener("playing", showNew, { once: true }); setTimeout(showNew, 1500);
}

// En los últimos segundos del tramo deja listo el siguiente en el reproductor libre.
function maybePreload(loc) {
  if (loc.remaining > 25) return;
  const n = channel.items.length, ni = (loc.index + 1) % n, nx = channel.items[ni];
  if (nx.src !== "file") return;
  const nkey = keyAt(ni, (loc.loop || 0) + (ni === 0 ? 1 : 0));
  if (nkey === current.key || slots.some((x) => x.key === nkey)) return;
  const idle = slots.find((x) => x !== active); if (!idle) return;
  prime(idle, nx, nkey);
}

/* ---------- Facebook y directos ---------- */
let fbToken = 0, fbSdk = null, fbWant = 0;
function hideFB() { disarmFbTap(); fbToken++; fbPlayer = null; fbSyncAt = Infinity; const f = $("fb"); f.classList.add("hidden"); f.classList.remove("live", "manual"); f.innerHTML = ""; }
// SDK oficial de Facebook: permite silenciar, dar play y saltar a un minuto por código.
function loadFB() {
  if (fbSdk) return fbSdk;
  fbSdk = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    window.fbAsyncInit = () => {
      try {
        FB.init({ xfbml: false, version: "v19.0" });
        FB.Event.subscribe("xfbml.ready", (m) => {
          if (m.type !== "video" || !m.instance) return;
          fbPlayer = m.instance;
          try {
            fbPlayer.mute();   // siempre arranca en silencio: el navegador lo permite y nunca se congela
            fbPlayer.play();
            let tried = false;
            fbPlayer.subscribe("startedPlaying", () => {   // ya está corriendo en silencio: si el espectador ya pidió sonido, se activa sin recargar
              if (tried) return; tried = true;
              wantSoundFB();
            });
            fbPlayer.subscribe("finishedPlaying", () => { fbEnded = true; });
            fbPlayer.subscribe("startedPlaying", () => { fbPaused = false; fbEnded = false; if (obs) $("fb").classList.remove("manual"); if (fbWant >= 3) { try { fbPlayer.seek(fbWant); } catch { /* sin salto */ } fbWant = 0; } fbSyncAt = Date.now() + 3000; });
            fbPlayer.subscribe("continuedPlaying", () => { fbPaused = false; });
            fbPlayer.subscribe("paused", () => { fbPaused = true; if (!studio) onFbPaused(); });
          } catch { /* el reproductor aún no está listo */ }
        });
        clearTimeout(t); resolve(true);
      } catch { clearTimeout(t); resolve(false); }
    };
    const sc = document.createElement("script"); sc.async = true; sc.src = "https://connect.facebook.net/es_LA/sdk.js";
    sc.onerror = () => { clearTimeout(t); resolve(false); };
    document.head.appendChild(sc);
  });
  return fbSdk;
}
// En la página pública nadie puede pausar: si Facebook se pausa (p. ej. al activar el sonido), se le da play otra vez.
// Si el navegador no deja reproducir con sonido, se vuelve a silenciar para que el video no se quede parado.
function onFbPaused() {
  if (Date.now() - fbTapAt < 2500) { /* pausa causada por el toque en el video: solo se reanuda */ }
  else if (Date.now() - fbUnmutedAt < 8000) blockSound();   // el navegador pausó el video al activar el sonido: se silencia y sigue
  [250, 1000].forEach((ms) => setTimeout(() => { try { fbPlayer?.play(); } catch { /* sin reproductor */ } }, ms));
}
// Facebook crea su propio iframe: se le da permiso de autoplay/sonido ANTES de que cargue, para que no se pause al activar el sonido.
{
  const ce = document.createElement.bind(document), ALLOW = "autoplay *; encrypted-media *; fullscreen *; picture-in-picture *";
  document.createElement = function (tag, ...rest) {
    const el = ce(tag, ...rest);
    try { if (String(tag).toLowerCase() === "iframe") el.setAttribute("allow", ALLOW); } catch { /* sin permiso */ }
    return el;
  };
}
new MutationObserver((ms) => {
  for (const m of ms) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    const list = n.tagName === "IFRAME" ? [n] : [...n.querySelectorAll("iframe")];
    list.forEach((i) => { try { i.setAttribute("allow", "autoplay *; encrypted-media *; fullscreen *; picture-in-picture *"); } catch { /* sin permiso */ } });
  }
}).observe($("fb"), { childList: true, subtree: true });
function showFB(href, startSec, isLive) {
  const f = $("fb"), token = ++fbToken;
  f.innerHTML = ""; fbPlayer = null; fbSyncAt = Infinity; fbPaused = false; fbEnded = false; fbPauseCount = 0; fbWant = isLive ? 0 : startSec;
  f.classList.toggle("live", !!isLive); f.classList.add("manual"); f.classList.remove("hidden");   // clicable hasta que arranque, por si Facebook no inicia solo
  loadFB().then((ok) => {
    if (token !== fbToken) return;
    if (ok && window.FB) {
      const d = document.createElement("div");
      d.className = "fb-video"; d.dataset.href = href; d.dataset.autoplay = "true"; d.dataset.showText = "false"; d.dataset.allowfullscreen = "false"; d.dataset.width = "1920";
      f.appendChild(d); FB.XFBML.parse(f);
    } else {
      // Sin el SDK: reproductor incrustado básico (puede pedir pulsar play).
      let h = href; if (!isLive && startSec >= 3) h += `${h.includes("?") ? "&" : "?"}t=${Math.floor(startSec)}`;
      f.classList.add("manual");   // en este modo el público puede pulsar el video (un toque dentro de Facebook siempre activa el sonido)
      const i = document.createElement("iframe");
      i.setAttribute("allow", "autoplay *; encrypted-media *; fullscreen *; picture-in-picture *"); i.setAttribute("allowfullscreen", "");   // el permiso va ANTES del src
      i.src = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(h)}&show_text=false&autoplay=true&width=1920&height=1080`;
      f.appendChild(i);
    }
  });
}
function leaveFiles() { for (const x of slots) if (!x.el.classList.contains("hidden")) fadeOutHide(x, (y) => y === active); }
function playFB(loc) {
  $("ytmask").classList.add("hidden");
  leaveFiles(); dip();
  active = null; ytPlayer?.stopVideo?.(); $("yt").classList.add("hidden");
  showFB(loc.item.ref, (nowLoc() || loc).filePos, false);
}
function startLive() {
  clearTimeout(timer); clearTimeout(ytMaskT); current = null;
  stop(); say(""); $("ytmask").classList.add("hidden"); $("lower").classList.remove("show");
  setTimeout(() => { if (!unmuted && liveCfg) needTap(); }, 1200);
  if (liveCfg.kind === "facebook") showFB(liveCfg.ref, 0, true);
  else {
    $("yt").classList.remove("hidden");
    loadYT().then(() => { if (!liveCfg || liveCfg.kind !== "youtube") return; ytPlayer.loadVideoById({ videoId: liveCfg.ref }); unmuted && !soundBlocked ? ytPlayer.unMute() : ytPlayer.mute(); });
  }
}
function endLive() {
  stop(); current = null; slots.forEach((x) => { x.key = ""; });
  clockReady.then(() => tick(false));
}

/* ---------- YouTube ---------- */
let ytMaskT = null;
function playYT(loc) {
  ytPlayed = false;
  hideFB();
  // YouTube muestra su título y canal al empezar: se oculta con una banda negra los primeros segundos.
  $("ytmask").classList.remove("hidden"); clearTimeout(ytMaskT); ytMaskT = setTimeout(() => $("ytmask").classList.add("hidden"), 8000);
  leaveFiles(); dip();
  active = null;
  $("yt").classList.remove("hidden");
  loadYT().then(() => {
    if (!current) return;
    const l = nowLoc() || loc;
    ytPlayer.loadVideoById({ videoId: l.item.ref, startSeconds: Math.floor(l.filePos) });
    unmuted && !soundBlocked ? ytPlayer.unMute() : ytPlayer.mute();
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
// Si el reproductor está incrustado en otra página cuyo <iframe> no tiene allow="autoplay", el navegador pausa a Facebook cuando se le
// activa el sonido por código. La única forma de permitirlo sin recargar es que el TOQUE del espectador llegue DENTRO del video de Facebook.
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();
const noAutoplay = (() => { try { const fp = document.featurePolicy || document.permissionsPolicy; return inFrame && !!fp?.allowsFeature && !fp.allowsFeature("autoplay"); } catch { return false; } })();
let fbTapWanted = false, fbTapAt = 0;
const tapHint = document.createElement("div");   // cartel que no captura toques: el toque pasa al video de Facebook
tapHint.textContent = "👆 Toca el video para activar el sonido";
tapHint.style.cssText = "position:absolute;left:50%;bottom:24%;transform:translateX(-50%);padding:18px 36px;border-radius:999px;background:rgba(0,0,0,.75);color:#fff;font-size:40px;z-index:9;pointer-events:none;display:none;white-space:nowrap";
function armFbTap() {
  if (obs || studio || embed) return;
  fbTapWanted = true; $("fb").classList.add("manual"); tapHint.style.display = "block"; $("sound").classList.add("hidden");
}
function disarmFbTap() { fbTapWanted = false; tapHint.style.display = "none"; }
function wantSoundFB() {
  if (!unmuted || studio) return;   // en OBS (obs=1) el audio está permitido: el video de Facebook se desmutea solo al empezar
  { fbUnmutedAt = Date.now(); fbPauseCount = 0; setTimeout(() => { try { fbPlayer?.unmute(); fbPlayer?.setVolume?.(1); fbPlayer?.play(); } catch { /* sin reproductor */ } }, 400); setTimeout(() => { try { fbPlayer?.setVolume?.(1); } catch { /* sin reproductor */ } }, 1500); }   // activa el sonido y sube el volumen (Facebook puede arrancar con volumen 0)
}
// Cuando el espectador toca dentro del video de Facebook, el foco pasa a ese iframe: ahí el navegador ya permite el sonido.
window.addEventListener("blur", () => setTimeout(() => {
  if (obs || studio || !document.hasFocus()) return;   // solo si el foco pasó a Facebook (no al cambiar de pestaña)
  const fr = $("fb").querySelector("iframe");
  if (fr && document.activeElement === fr) onFbTapped();
}, 0));
function onFbTapped() {
  unmuted = true; $("sound").classList.add("hidden");   // el espectador tocó el video de Facebook: ya hay permiso del navegador, se activa el sonido
  disarmFbTap(); soundBlocked = false; fbTapAt = fbUnmutedAt = Date.now(); fbPauseCount = 0;
  // Tras tu toque, el navegador ya permite el sonido: se reintenta hasta que Facebook confirme que suena (o 8 segundos).
  let n = 0;
  const t = setInterval(() => {
    n++;
    try {
      const m = fbPlayer?.isMuted?.(), v = fbPlayer?.getVolume?.();
      if (!fbPlayer || (m === false && !(v <= 0))) { clearInterval(t); return; }
      fbTapAt = Date.now(); fbPlayer.unmute(); fbPlayer.setVolume?.(1); fbPlayer.play();
    } catch { /* sin reproductor */ }
    if (n >= 12) clearInterval(t);
  }, 700);
}
// Si el navegador bloquea el sonido y pausa el video, se silencia ESE video, se pone a correr y el botón vuelve a aparecer.
// Los videos siguientes arrancan en silencio (corren siempre) hasta que el espectador toque «Activar sonido».
function blockSound() {
  soundBlocked = true;
  try {
    const it = channel?.items?.[current?.index];
    if (liveCfg ? liveCfg.kind === "youtube" : it?.src === "youtube") { ytPlayer?.mute?.(); ytPlayer?.playVideo?.(); }
    else if (liveCfg ? liveCfg.kind === "facebook" : it?.src === "facebook") { fbPlayer?.mute?.(); fbPlayer?.play?.(); }
    else if (active) { active.el.muted = true; active.el.play().catch(() => {}); }
  } catch { /* sin reproductor */ }
  needTap();
}
let pausedSince = 0;
function guardPaused(loc) {
  if (!unmuted || obs || soundBlocked) { pausedSince = 0; return; }
  const it = loc.item; let paused = false;
  try {
    if (it.src === "file" && active) {
      paused = active.el.paused && !active.el.ended && active.el.readyState >= 1;
      if (paused && pausedSince && Date.now() - pausedSince >= 2000) {   // primero se intenta reanudar CON sonido; solo si el navegador lo rechaza se silencia
        pausedSince = Date.now();
        active.el.play().then(() => { pausedSince = 0; }).catch((e) => { if (e?.name === "NotAllowedError") blockSound(); });
        return;
      }
    }
    else if (it.src === "facebook") paused = !!fbPlayer && fbPaused;
    else if (it.src === "youtube" && ytPlayer?.getPlayerState) paused = ytPlayer.getPlayerState() === 2;
  } catch { /* aún no listo */ }
  if (!paused) { pausedSince = 0; return; }
  if (!pausedSince) { pausedSince = Date.now(); return; }
  if (Date.now() - pausedSince >= 2000) { pausedSince = 0; blockSound(); }
}
function needTap() { if ((!unmuted || soundBlocked) && !fbTapWanted && !embed && !obs) $("sound").classList.remove("hidden"); }
$("sound").addEventListener("click", () => {
  unmuted = true; $("sound").classList.add("hidden");
  for (const x of slots) x.el.muted = false;
  active?.el.play().catch(() => {});
  ytPlayer?.unMute?.(); ytPlayer?.playVideo?.();
  soundBlocked = false;
  const fbNow = liveCfg ? liveCfg.kind === "facebook" : channel?.items?.[current?.index]?.src === "facebook";
  if (fbNow && !obs && !studio) wantSoundFB();   // Facebook: sin recargar el video
});
setTimeout(() => { if (!unmuted && !fbTapWanted && channel && !embed) $("sound").classList.remove("hidden"); }, 1500);

/* ---------- Control de sincronía (cada segundo) ---------- */
// El Studio manda con su VIDEO. Si la pestaña queda en segundo plano el navegador frena/pausa el video y la barra
// se atrasaba junto con él (retraso grande). Ahora, mientras está oculta no se toca el reloj, y al volver se
// reposiciona el video en la hora real del canal.
let studioGraceUntil = 0;
function resumeStudio() {
  studioGraceUntil = Date.now() + 4000;
  const loc = nowLoc(); if (!loc || !current) return;
  if (keyOf(loc) !== current.key) return;   // cambió de tramo: tick() lo resuelve
  try {
    if (loc.item.src === "file" && active) { active.el.currentTime = Math.min(loc.filePos, Math.max(0, (active.el.duration || loc.filePos) - 0.3)); active.el.play().catch(() => {}); }
    else if (loc.item.src === "youtube" && ytPlayer?.seekTo) { ytPlayer.seekTo(loc.filePos, true); ytPlayer.playVideo?.(); }
    else if (loc.item.src === "facebook" && fbPlayer) { fbPlayer.seek(loc.filePos); fbPlayer.play(); }
  } catch { /* el reproductor aún no está listo */ }
}
function watch() {
  if (liveCfg) return;
  if (!channel?.items?.length || channel.live === false || !current) return;
  const loc = nowLoc(); if (!loc) return;
  if (keyOf(loc) !== current.key) { tick(false); return; }
  exposeOnAir(loc);
  maybePreload(loc);
  if (studio && (document.hidden || Date.now() < studioGraceUntil)) {   // pestaña en segundo plano o recién vuelta: el video no manda, solo se mantiene en marcha
    try { if (loc.item.src === "file" && active?.el.paused) active.el.play().catch(() => {}); else if (loc.item.src === "youtube" && ytPlayer?.getPlayerState?.() === 2) ytPlayer.playVideo?.(); } catch { /* sin reproductor */ }
    return;
  }
  if (studio) {   // en el Studio manda el VIDEO: la barra lo sigue (si lo retrocedes, lo pausas o se atrasa) y a él nunca se le obliga a saltar
    const m = mediaState(loc);
    if (m) {
      if (m.paused && !m.played) {
        if (loc.item.src === "file") active.el.play().catch(() => {});
        else if (loc.item.src === "youtube") ytPlayer.playVideo?.();
        else try { fbPlayer.play(); } catch { /* sin reproductor */ }
      }
      const d = m.pos - loc.filePos;
      if (Math.abs(d) > m.thr) { shift -= d * 1000; tick(false); }
    } else if (loc.item.src === "youtube" && ytPlayer?.getPlayerState) {
      const st = ytPlayer.getPlayerState(); if (st === 5 || st === -1) ytPlayer.playVideo?.();
    } else if (loc.item.src === "file" && active?.el.paused && !active.played) active.el.play().catch(() => {});
    return;
  }
  guardPaused(loc);
  if (loc.item.src === "file" && active) {
    const v = active.el;
    if (unmuted && !soundBlocked) {   // red de seguridad: tras una transición el sonido siempre vuelve
      if (v.muted) v.muted = false;
      if (!v._ramping && v.volume < 1) { try { v.volume = 1; } catch { /* iOS */ } }
    }
    if (v.readyState < 3 && !v.ended) return;                          // cargando: se espera
    const drift = v.currentTime - loc.filePos;                         // + adelantado, − atrasado
    if (Math.abs(drift) > 2 || v.ended) {
      try { v.currentTime = Math.min(loc.filePos, Math.max(0, (v.duration || loc.filePos) - 0.3)); } catch { /* reintenta */ }
      v.playbackRate = 1;
    } else if (Math.abs(drift) > 0.3) v.playbackRate = drift > 0 ? 0.94 : 1.06;   // se acerca sin saltos
    else if (v.playbackRate !== 1) v.playbackRate = 1;
    if (v.paused) v.play().catch(() => {});
  } else if (loc.item.src === "facebook" && fbPlayer) {
    try {
      const pos = fbPlayer.getCurrentPosition?.();
      if (fbPaused && Date.now() - lastSeekAt > 4000) { lastSeekAt = Date.now(); fbPlayer.play(); }
      else if (Number.isFinite(pos) && pos > 0 && Math.abs(pos - loc.filePos) > 6 && Date.now() - lastSeekAt > 12000) { lastSeekAt = Date.now(); fbPlayer.seek(loc.filePos); }
    } catch { /* sin reproductor */ }
  } else if (loc.item.src === "youtube" && ytPlayer?.getPlayerState) {
    const st = ytPlayer.getPlayerState(), dur = ytPlayer.getDuration?.() || 0;
    // Solo corrige con el video real (no con un anuncio de YouTube): su duración coincide con la del archivo.
    const full = loc.item.parts > 1 ? Math.abs(dur - loc.item.duration) > 3 : Math.abs(dur - loc.item.duration) < 3;
    if (st === 1 && (loc.item.parts > 1 || full) && Math.abs(ytPlayer.getCurrentTime() - loc.filePos) > 3 && Date.now() - lastSeekAt > 8000) { lastSeekAt = Date.now(); ytPlayer.seekTo(loc.filePos, true); }
    else if (st === 5 || st === -1 || st === 2) ytPlayer.playVideo?.();
  }
}
setInterval(watch, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { if (studio) resumeStudio(); tick(false); watch(); } });

async function log(item, key) {
  if (embed || key === lastLogged || (item.type === "programa" && item.part > 1)) return; lastLogged = key;
  try { await addDoc(collection(db, "stats"), { at: serverTimestamp(), sid, title: String(item.title).slice(0, 200), type: item.type }); } catch { /* sin registro */ }
}

/* ---------- Diagnóstico: abre el reproductor con ?debug=1 y verás un cuadro con el estado del sonido ---------- */
if (params.has("debug")) {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;left:12px;top:100px;z-index:20;padding:8px 14px;background:rgba(0,0,0,.85);color:#0f0;pointer-events:none;white-space:pre;font-family:monospace;font-size:calc(15px / var(--s, 1))";
  $("stage").appendChild(d);
  setInterval(() => {
    let m = "-", v = "-";
    try { m = fbPlayer?.isMuted?.(); v = fbPlayer?.getVolume?.(); } catch { /* sin reproductor */ }
    const it = channel?.items?.[current?.index];
    d.textContent = `fuente:${it?.src || "-"}  FB silenciado:${m}  volumen:${v}\nFB pausado:${fbPaused}  sonido pedido:${unmuted}  bloqueado:${soundBlocked}\nsin permiso autoplay:${noAutoplay}  dentro de iframe:${inFrame}`;
  }, 500);
}
