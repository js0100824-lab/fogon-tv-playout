import { auth, db, storage, isConfigured } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, deleteField, getDocs, collection, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { parseDuration, fmtDuration, youtubeId, facebookUrl, parseLiveLink, buildCycle, cycleLength, locate, planWithDefaults, compactChannel, expandChannel, describeCuts, itemLabel, intervalSeconds, seamlessPublish, jumpPublish, settleChannel, buildSchedule, normalizeSlots, sortPrograms, placeNewProgram, buildPinnedCycle, pinLines, pinWindow, pinDayIndex, pinEpoch, DAY_MS, PIN_ANCHOR_MS } from "./engine.js?v=38";
import { serverNow, startClock } from "./clock.js";

const $ = (id) => document.getElementById(id);
const views = ["config-warning", "login-view", "denied-view", "panel-view"];
function show(id) { views.forEach((v) => $(v).classList.toggle("hidden", v !== id)); }

const AUTH_ERRORS = {
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/invalid-email": "El correo no es válido.",
  "auth/user-disabled": "Esta cuenta está deshabilitada.",
  "auth/too-many-requests": "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
  "auth/network-request-failed": "No hay conexión con Firebase. Revisa tu internet."
};

if (!isConfigured) {
  show("config-warning");
} else {
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").classList.add("hidden");
    $("login-btn").disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    } catch (err) {
      $("login-error").textContent = AUTH_ERRORS[err.code] || `No se pudo iniciar sesión (${err.code}).`;
      $("login-error").classList.remove("hidden");
    } finally {
      $("login-btn").disabled = false;
    }
  });

  const logout = () => signOut(auth);
  $("logout-btn").addEventListener("click", logout);
  $("denied-logout").addEventListener("click", logout);

  onAuthStateChanged(auth, async (user) => {
    if (!user) { show("login-view"); return; }
    let isAdmin = false;
    try {
      isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists();
    } catch (err) {
      console.error("No se pudo comprobar el permiso:", err);
    }
    if (!isAdmin) {
      $("denied-uid").textContent = user.uid;
      show("denied-view");
      return;
    }
    $("user-email").textContent = user.email;
    $("st-project").textContent = firebaseConfig.projectId;
    $("st-auth").textContent = "Activa";
    $("st-admin").textContent = "Concedido";
    show("panel-view");
    initPanel();
  });

  $("test-btn").addEventListener("click", async () => {
    $("test-btn").disabled = true;
    try {
      await setDoc(doc(db, "public", "ping"), { at: serverTimestamp(), by: auth.currentUser.uid });
      $("st-write").textContent = "Correcta";
      toast("Escritura correcta en Firestore (public/ping).", "ok");
    } catch (err) {
      $("st-write").textContent = "Fallida";
      toast(`No se pudo escribir (${err.code}). Revisa que las reglas estén publicadas.`, "error");
    } finally { $("test-btn").disabled = false; }
  });
}

/* ---------- Panel ---------- */
let media = { cloud: "", preset: "" };
let liveCfg = null;
const state = { lib: [], plan: planWithDefaults(), brand: { name: "", showName: false, accent: "#0E6B73", logo: "", ticker: "", tickerMove: true, tickerSep: "●", tickerSpeed: 120, logoPos: "top-right", logoSize: 14, logoOpacity: 0.9 } };
let inited = false;

function esc(t) { return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(text, kind = "ok") {
  const t = $("toast"); t.textContent = text; t.className = `msg ${kind}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 5000);
}
let libShown = [];
let libKind = "programa";   // qué se ve en la Biblioteca: programa | comercial
// Alerta propia (reemplaza el confirm() del navegador). Devuelve true/false.
function askConfirm({ title, text = "", ok = "Aceptar", cancel = "Cancelar", danger = false }) {
  return new Promise((resolve) => {
    const d = $("dlg"), okB = $("dlg-ok"), noB = $("dlg-cancel");
    $("dlg-title").textContent = title; $("dlg-text").textContent = text; $("dlg-text").classList.toggle("hidden", !text);
    okB.textContent = ok; noB.textContent = cancel; okB.classList.toggle("danger", !!danger);
    d.classList.remove("hidden"); okB.focus();
    const key = (e) => { if (e.key === "Escape") done(false); };
    const done = (v) => { d.classList.add("hidden"); okB.onclick = noB.onclick = d.onclick = null; document.removeEventListener("keydown", key); resolve(v); };
    okB.onclick = () => done(true); noB.onclick = () => done(false); d.onclick = (e) => { if (e.target === d) done(false); };
    document.addEventListener("keydown", key);
  });
}
const fail = (err) => toast(`Error: ${err.code || err.message}`, "error");

async function initPanel() {
  if (inited) return; inited = true;
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
  $("lib-form").addEventListener("submit", addItem);
  $("lib-cancel").addEventListener("click", resetEdit);
  $("lib-kind").addEventListener("change", () => { $("lib-cat").style.display = $("lib-kind").value === "programa" ? "" : "none"; });
  initSched();
  initTimeline();
  initDay();
  document.querySelectorAll("#lib-filter [data-kind]").forEach((b) => b.addEventListener("click", () => { libKind = b.dataset.kind; renderLibrary(); }));
  $("monitor").src = new URL("../player/?embed=1&studio=1", location.href).href;
  // La vista previa es la señal maestra: lo que ella emite se publica para que el reproductor público la siga.
  let lastOn = "", lastOnAt = 0, lastO = null;
  setInterval(async () => {
    try {
      const o = $("monitor").contentWindow.__onair;
      if (!o || !$("monitor").contentWindow.__restored || state.channel?.live === false) return;
      const key = `${o.epoch}:${o.index}:${o.sig}`;
      const exp = lastO ? (lastO.p ? lastO.filePos : lastO.filePos + (o.at - lastO.at) / 1000) : 0;
      const jumped = !!lastO && key === lastOn && (Math.abs(o.filePos - exp) > 2 || !!o.p !== !!lastO.p);   // pausa o salto: se guarda enseguida
      if (key === lastOn && !jumped && (o.p || Date.now() - lastOnAt < 10000)) return;
      lastOn = key; lastOnAt = Date.now(); lastO = o;
      await setDoc(doc(db, "public", "onair"), o);
    } catch { /* la vista previa aún no carga */ }
  }, 1000);
  document.querySelectorAll(".drop").forEach((drop) => {
    const kind = drop.dataset.kind, input = drop.querySelector("input");
    input.addEventListener("change", () => { uploadFiles([...input.files], kind); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("video/")), kind));
  });
  $("live-btn").addEventListener("click", toggleLive);
  $("lv-on").addEventListener("click", () => setLiveStream(true));
  $("lv-off").addEventListener("click", () => setLiveStream(false));
  $("cl-save")?.addEventListener("click", async () => {
    media = { cloud: $("cl-cloud").value.trim(), preset: $("cl-preset").value.trim() };
    try { await setDoc(doc(db, "config", "media"), media); renderMedia(); toast("Subida configurada.", "ok"); } catch (err) { fail(err); }
  });
  $("b-logo-file").addEventListener("change", onLogoFile);
  $("b-logo-rm").addEventListener("click", () => { state.brand.logo = ""; renderBrand(); saveBrand(true); });
  $("plan-save-com").addEventListener("click", savePlanFromCommercial);
  ["plan-mode", "plan-iv", "plan-iu", "plan-count", "plan-repeat", "plan-end", "plan-every"].forEach((id) => $(id).addEventListener("input", previewPlan));
  startClock();   // hora del servidor: la misma para el panel y para todos los espectadores
  for (const [id, key] of [["order-box", "fogon.orderOpen"], ["cycle-box", "fogon.cycleOpen"]]) {
    const box = $(id);
    try { if (localStorage.getItem(key) === "0") box.open = false; } catch { /* sin almacenamiento */ }
    box.addEventListener("toggle", () => { try { localStorage.setItem(key, box.open ? "1" : "0"); } catch { /* */ } });
  }
  // Vaciar la parrilla de golpe
  $("order-clear").addEventListener("click", async () => {
    const n = new Set(state.plan.order).size;
    if (!n) { toast("La parrilla ya está vacía.", "error"); return; }
    if (!(await askConfirm({ title: "¿Vaciar la parrilla?", text: `Se quitan los ${n} programas. Siguen en la biblioteca.`, ok: "Vaciar", danger: true }))) return;
    state.plan.order = []; savePlan().then(() => { renderAll(); toast("Parrilla vaciada.", "ok"); }).catch(fail);
  });
  // Dejar solo el programa que está al aire y quitar los demás de la parrilla
  $("order-keep-air").addEventListener("click", async () => {
    const c = state.channel, loc = c?.items?.length ? studioLoc(c, serverNow()) : null;
    if (!loc) { toast("No hay ningún programa al aire ahora.", "error"); return; }
    let k = loc.index; while (k > 0 && c.items[k].type !== "programa") k--;   // si hay un corte comercial, cuenta el programa al que pertenece
    const air = c.items[k];
    if (!air || air.type !== "programa" || !state.lib.some((x) => x.id === air.id)) { toast("No pude saber qué programa está al aire.", "error"); return; }
    const others = state.plan.order.filter((id) => id !== air.id).length + Math.max(0, state.plan.order.filter((id) => id === air.id).length - 1);
    if (!(await askConfirm({ title: "Dejar solo el programa al aire", text: `Se queda «${air.title}» y se quitan los otros ${others}.`, ok: "Dejar solo este" }))) return;
    state.plan.order = [air.id]; savePlan().then(() => { renderAll(); toast(`Solo queda «${air.title}».`, "ok"); }).catch(fail);
  });
  $("publish-btn").addEventListener("click", publish);
  $("publish-btn2").addEventListener("click", publish);
  $("publish-restart").addEventListener("click", () => publish(false, true));
  $("brand-form").addEventListener("submit", async (e) => { e.preventDefault(); await saveBrand(); });
  $("stats-refresh").addEventListener("click", async () => { await loadStats(); toast("Actualizado.", "ok"); });
  $("player-link").href = new URL("../player/", location.href).href;
  try {
    const [libSnap, planSnap, brandSnap, chSnap, mediaSnap, liveSnap] = await Promise.all([
      getDocs(collection(db, "library")), getDoc(doc(db, "config", "plan")),
      getDoc(doc(db, "public", "brand")), getDoc(doc(db, "public", "channel")), getDoc(doc(db, "config", "media")), getDoc(doc(db, "public", "live"))
    ]);
    if (mediaSnap.exists()) media = { ...media, ...mediaSnap.data() };
    liveCfg = liveSnap.exists() ? liveSnap.data() : null; renderLiveStream();
    state.lib = libSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    if (planSnap.exists()) state.plan = planWithDefaults(planSnap.data());
    if (brandSnap.exists()) state.brand = { ...state.brand, ...brandSnap.data() };
    state.channel = chSnap.exists() ? { ...chSnap.data(), items: expandChannel(chSnap.data()) } : null;
  } catch (err) { fail(err); }
  ensureSched();
  renderAll();
  setInterval(renderNow, 1000);
  setInterval(renderCycle, 30000);   // las horas del ciclo se mantienen al día
}

function openTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${name}`));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "estadisticas") loadStats();
}

function renderMedia() {
  if (!$("cl-cloud")) return;
  $("cl-cloud").value = media.cloud || ""; $("cl-preset").value = media.preset || "";
  $("cl-state").textContent = media.cloud && media.preset ? "Subida activa: los videos van a Cloudinary (máx. 100 MB cada uno)." : "Sin configurar.";
}
function renderAll() {
  renderMedia();
  state.plan.order = state.plan.order.filter((id) => state.lib.some((i) => i.id === id));
  renderLibrary(); renderAds(); renderOrder(); renderCycle(); renderBrand(); renderNow(); renderSched(); renderPick(); renderDay();
}

/* Subida a Cloudinary (plan gratis, preset sin firma) */
function cloudUpload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append("file", file); fd.append("upload_preset", media.preset);
    const x = new XMLHttpRequest();
    x.open("POST", `https://api.cloudinary.com/v1_1/${encodeURIComponent(media.cloud)}/video/upload`);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      x.status >= 200 && x.status < 300 && j.secure_url ? resolve(j)
        : reject(new Error(j.error?.message ? `Cloudinary: ${j.error.message}` : `Cloudinary respondió ${x.status}. Revisa el Cloud name y que el preset sea Unsigned.`));
    };
    x.onerror = () => reject(new Error("Sin conexión con Cloudinary."));
    x.send(fd);
  });
}

/* Biblioteca */
async function detectDuration(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (d) => { v.removeAttribute("src"); v.load(); resolve(d); };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration) : NaN);
    v.onerror = () => done(NaN);
    setTimeout(() => done(NaN), 8000);
    v.src = url;
  });
}
// Duración de un video de YouTube sin clave de API: se carga en silencio fuera de pantalla y se lee.
function ytDuration(id) {
  return new Promise((resolve) => {
    const host = document.createElement("div"); host.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;height:120px";
    const inner = document.createElement("div"); host.appendChild(inner); document.body.appendChild(host);
    let p = null, finished = false;
    const done = (d) => { if (finished) return; finished = true; try { p?.destroy(); } catch { /* ya cerrado */ } host.remove(); resolve(d); };
    const make = () => {
      p = new YT.Player(inner, { videoId: id, playerVars: { controls: 0, mute: 1 }, events: {
        onError: () => done(NaN),
        onReady: () => {
          p.mute(); p.playVideo(); let n = 0;
          const iv = setInterval(() => { const d = p.getDuration?.(); if (d > 0) { clearInterval(iv); try { p.pauseVideo(); } catch { /* */ } done(Math.round(d)); } else if (++n > 50) { clearInterval(iv); done(NaN); } }, 250);
        } } });
    };
    if (window.YT?.Player) make();
    else {
      const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { prev?.(); make(); };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) { const sc = document.createElement("script"); sc.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(sc); }
    }
    setTimeout(() => done(NaN), 15000);
  });
}
// ---- Editar un contenido de la biblioteca (título, enlace, tipo, duración) sin crear otro nuevo ----
let editing = null;   // { id, url, dur, play }
function resetEdit() {
  editing = null; $("lib-form").reset();
  $("lib-form").querySelector('button[type="submit"]').textContent = "Guardar enlace";
  $("lib-cancel").hidden = true; document.querySelector(".link-add summary").textContent = "Añadir contenido"; $("lib-cat").style.display = "";
}
function startEdit(id) {
  const it = state.lib.find((x) => x.id === id); if (!it) return;
  const pf = it.playFor > 0 ? Math.min(it.playFor, it.duration) : 0;
  editing = { id, url: it.url, dur: it.duration, play: pf };
  $("lib-title").value = it.title; $("lib-url").value = it.url; $("lib-kind").value = it.kind; $("lib-cat").value = it.cat || ""; $("lib-cat").style.display = it.kind === "programa" ? "" : "none";
  $("lib-dur-h").value = Math.floor(it.duration / 3600) || ""; $("lib-dur-m").value = Math.floor((it.duration % 3600) / 60); $("lib-dur-s").value = Math.round(it.duration % 60);
  $("lib-play-h").value = pf >= 3600 ? Math.floor(pf / 3600) : ""; $("lib-play-m").value = pf ? Math.floor((pf % 3600) / 60) : ""; $("lib-play-s").value = pf ? Math.round(pf % 60) : "";
  $("lib-form").querySelector('button[type="submit"]').textContent = "Guardar cambios";
  $("lib-cancel").hidden = false;
  const box = document.querySelector(".link-add"); box.open = true; box.querySelector("summary").textContent = `Editando: ${it.title}`;
  box.scrollIntoView({ behavior: "smooth", block: "start" }); $("lib-title").focus();
}
async function updateItem(id, d) {
  const it = state.lib.find((x) => x.id === id), { playFor, ...rest } = d;
  if (rest.kind !== it.kind && (state.plan.order.includes(id) || (state.plan.adOrder || []).includes(id))) throw new Error("Para cambiar el tipo, primero quítalo de la parrilla / de los comerciales.");
  await updateDoc(doc(db, "library", id), { ...rest, playFor: playFor > 0 ? playFor : deleteField() });
  Object.assign(it, rest); if (playFor > 0) it.playFor = playFor; else delete it.playFor;
  state.lib.sort((a, b) => a.title.localeCompare(b.title));
  renderAll();
}
async function addItem(e) {
  e.preventDefault();
  let url = $("lib-url").value.trim();
  // Si solo escribes el nombre del archivo (video1.mp4), se busca en la carpeta media del sitio.
  if (/^(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)\//i.test(url)) url = `https://${url}`;
  if (!/^https?:\/\//i.test(url)) url = new URL(`../media/${encodeURIComponent(url.replace(/^\/?(media\/)?/, ""))}`, location.href).href;
  const yt = youtubeId(url), fb = !!facebookUrl(url);
  const ms = (h, a, b) => Math.max(0, Math.floor(Number($(h).value) || 0)) * 3600 + Math.max(0, Math.floor(Number($(a).value) || 0)) * 60 + Math.max(0, Math.floor(Number($(b).value) || 0));
  let duration = ms("lib-dur-h", "lib-dur-m", "lib-dur-s"), playFor = ms("lib-play-h", "lib-play-m", "lib-play-s");
  // Al editar: en YouTube/.mp4, si cambiaste el enlace y no tocaste la duración, se detecta la del video nuevo. En Facebook se conserva la que hay.
  if (editing && !fb && url !== editing.url && duration === editing.dur) duration = 0;
  if (fb && !(duration > 0)) { toast("Escribe la duración del video.", "error"); return; }
  if (!(duration > 0)) { toast("Detectando la duración…", "ok"); duration = yt ? await ytDuration(yt) : await detectDuration(url); }
  if (!(duration > 0)) {
    toast("No pude detectar la duración. Escríbela.", "error");
    return;
  }
  try {
    const kind = $("lib-kind").value, extra = kind === "comercial" && playFor > 0 ? { playFor: Math.min(playFor, duration) } : {};
    if (editing) {
      const eid = editing.id, inChannel = !!(state.channel?.items?.some((x) => x.id === eid) || (state.channel?.media && state.channel.media[eid]));
      const durChanged = duration !== editing.dur, air = airProgramId();
      await updateItem(eid, { title: $("lib-title").value.trim(), kind, url, duration, playFor: extra.playFor || 0, cat: kind === "programa" ? $("lib-cat").value : "" });
      resetEdit();
      // Si ese contenido está en la emisión, se publica solo: el aire usa el enlace y la duración nuevos (si está al aire y cambió la duración, se reinicia).
      if (inChannel) { toast("Guardado. Actualizando la emisión…", "ok"); await publish(true, false, { reloadId: durChanged && air === eid ? eid : null }); }
      else { toast("Cambios guardados.", "ok"); await autoPlace(state.lib.find((x) => x.id === eid)); }
    } else { await saveItem({ title: $("lib-title").value.trim(), kind, url, duration, cat: kind === "programa" ? $("lib-cat").value : "", ...extra }); $("lib-form").reset(); toast("Contenido guardado.", "ok"); }
  } catch (err) { fail(err); }
}
async function saveItem(d) {
  const data = { ...d, active: true, createdAt: serverTimestamp() };
  const r = await addDoc(collection(db, "library"), data);
  state.lib.push({ id: r.id, ...data });
  state.lib.sort((a, b) => a.title.localeCompare(b.title));
  renderAll();
  await autoPlace(state.lib.find((x) => x.id === r.id));   // programa nuevo con categoría: entra enseguida en su franja
}
async function uploadFiles(files, kind) {
  for (const f of files) {
    const row = document.createElement("div"); row.className = "up";
    row.innerHTML = `<div>${esc(f.name)}</div><progress max="100" value="0"></progress><small></small>`;
    $("uploads").prepend(row);
    const note = row.querySelector("small"), bar = row.querySelector("progress");
    try {
      if (media.cloud && media.preset) {
        if (!/\.(mp4|webm)$/i.test(f.name)) throw new Error("Usa un archivo .mp4 (H.264) o .webm.");
        if (f.size > 100 * 1024 * 1024) throw new Error("Pesa más de 100 MB, el límite gratis de Cloudinary. Comprímelo con HandBrake a 720p.");
        const res = await cloudUpload(f, (p) => { bar.value = p; note.textContent = `${p}%`; });
        let duration = Math.round(res.duration || 0);
        if (!(duration > 0)) duration = await detectDuration(res.secure_url);
        if (!(duration > 0)) throw new Error("Se subió, pero no pude leer la duración.");
        await saveItem({ title: f.name.replace(/\.[^.]+$/, ""), kind, url: res.secure_url, duration, provider: "cloudinary", publicId: res.public_id });
        note.textContent = "Listo"; setTimeout(() => row.remove(), 3000);
        continue;
      }
      const local = URL.createObjectURL(f);
      const duration = await detectDuration(local); URL.revokeObjectURL(local);
      if (!(duration > 0)) throw new Error("No se pudo leer la duración del video (¿formato no compatible? usa .mp4).");
      const path = `media/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
      if (!media.cloud || !media.preset) { /* sin Cloudinary: se intenta Firebase Storage */ }
      const task = uploadBytesResumable(sRef(storage, path), f);
      let moved = 0;
      const stall = setTimeout(() => { if (!moved) task.cancel(); }, 20000);
      try {
        await new Promise((res, rej) => {
          task.on("state_changed", (s) => { moved = s.bytesTransferred; const p = Math.round(s.bytesTransferred / s.totalBytes * 100); bar.value = p; note.textContent = `${p}%`; }, rej, res);
        });
      } finally { clearTimeout(stall); }
      const url = await getDownloadURL(task.snapshot.ref);
      await saveItem({ title: f.name.replace(/\.[^.]+$/, ""), kind, url, duration, path });
      note.textContent = "Listo"; setTimeout(() => row.remove(), 3000);
    } catch (err) {
      bar.remove();
      note.className = "msg error";
      note.textContent = /canceled|unauthorized|object-not-found|bucket|retry-limit|storage\//.test(err.code || "")
        ? "La subida no avanza: Firebase Storage no está activado (requiere plan Blaze) o sus reglas no están publicadas. Mientras tanto usa “Añadir por enlace”."
        : (err.message || "Error al subir.");
    }
  }
}
const createdMs = (i) => { const c = i.createdAt; if (!c) return 0; if (typeof c.toMillis === "function") return c.toMillis(); if (typeof c.seconds === "number") return c.seconds * 1000 + Math.round((c.nanoseconds || 0) / 1e6); return Date.now(); };   // recién guardado (aún sin hora del servidor) = el más nuevo
function renderLibrary() {
  const el = $("lib-list"), isAd = libKind === "comercial";
  document.querySelectorAll("#lib-filter [data-kind]").forEach((b) => {
    const ad = b.dataset.kind === "comercial";
    b.textContent = `${ad ? "Anuncios" : "Programas"} (${state.lib.filter((i) => (i.kind === "comercial") === ad).length})`;
    b.classList.toggle("active", b.dataset.kind === libKind);
  });
  const card = (i, num) => {
    const n = state.plan.order.filter((x) => x === i.id).length, prog = i.kind === "programa";
    const onGrid = prog && n > 0 ? `<span class="tag ok">✓ En parrilla</span>` : "";
    const fbTag = i.fbOk === true ? '<span class="tag ok">✓ Se ve</span>' : i.fbOk === false ? '<span class="tag bad">✗ No se ve</span>' : "";
    const dur = fmtDuration(i.duration) + (i.kind === "comercial" && i.playFor > 0 ? ` · al aire ${fmtDuration(Math.min(i.playFor, i.duration))}` : "");
    const catSel = prog ? `<select class="cat-sel" data-cat="${esc(i.id)}" aria-label="Categoría"><option value="">Sin categoría</option>${catsAll().map((c) => `<option value="${esc(c)}"${c === i.cat ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>` : "";
    return `<div class="item lib-item"><div class="lib-main"><b><span class="lib-num">${num}.</span> ${esc(i.title)}</b></div>
    <div class="lib-meta">${onGrid}${fbTag}<span class="lib-dur">${dur}</span>${catSel}</div>
    <div class="lib-meta"><span class="lib-actions"><button class="btn small" data-view="${esc(i.id)}" type="button">Ver</button>${prog ? `<button class="btn small" data-grid="${esc(i.id)}" type="button">＋ Parrilla</button>` : ""}<button class="btn small" data-edit="${esc(i.id)}" type="button">Editar</button><button class="btn del small" data-del="${esc(i.id)}" type="button">Eliminar</button></span></div>
    <details class="lib-link"><summary>Ver enlace</summary><span>${esc(i.url)}</span><button class="btn small" data-copy="${esc(i.url)}" type="button">Copiar enlace</button></details></div>`;
  };
  // Solo se ve lo que elijas (Programas o Anuncios). El número es el orden en que los añadiste; el más reciente sale arriba.
  const asc = state.lib.filter((i) => (i.kind === "comercial") === isAd).sort((a, b) => createdMs(a) - createdMs(b) || String(a.id).localeCompare(String(b.id)));
  const num = new Map(asc.map((i, k) => [i.id, k + 1]));
  libShown = asc.slice().reverse();
  el.innerHTML = asc.length ? libShown.map((i) => card(i, num.get(i.id))).join("") : `<p class="hint">${isAd ? "Sin anuncios" : "Sin programas"}</p>`;
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => startEdit(b.dataset.edit)));
  el.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => openView(b.dataset.view)));
  el.querySelectorAll("[data-grid]").forEach((b) => b.addEventListener("click", () => addToGrid(b.dataset.grid)));
  el.querySelectorAll("[data-cat]").forEach((s) => s.addEventListener("change", async () => {
    const it = state.lib.find((x) => x.id === s.dataset.cat); if (!it) return;
    try { await updateDoc(doc(db, "library", it.id), { cat: s.value }); it.cat = s.value; toast("Guardado.", "ok"); } catch (err) { fail(err); return; }
    await autoPlace(it);   // si aún no estaba en la parrilla, entra en la franja de su nueva categoría
  }));
  el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copiado ✓"; setTimeout(() => { b.textContent = "Copiar enlace"; }, 1500); } catch { toast("No se pudo copiar. Mantén pulsado el enlace para copiarlo.", "error"); } }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const it = state.lib.find((x) => x.id === b.dataset.del);
    if (!(await askConfirm({ title: "¿Eliminar de la biblioteca?", text: it.title, ok: "Eliminar", danger: true }))) return;
    try {
      await deleteDoc(doc(db, "library", it.id));
      if (it.provider === "cloudinary") toast("Eliminado.", "ok");
      if (it.path) { try { await deleteObject(sRef(storage, it.path)); } catch {} }
      state.lib = state.lib.filter((x) => x.id !== it.id);
      await savePlan(); renderAll();
      if (state.channel?.items?.some((x) => x.id === it.id)) { await publish(true); }
    } catch (err) { fail(err); }
  }));
}

/* Control comercial */
function allAdsOrdered() {
  const pos = new Map((state.plan.adOrder || []).map((id, n) => [id, n]));
  return state.lib.filter((i) => i.kind === "comercial")
    .sort((x, y) => (pos.has(x.id) ? pos.get(x.id) : 1e6) - (pos.has(y.id) ? pos.get(y.id) : 1e6) || (x.title || "").localeCompare(y.title || ""));
}
function readPlanForm() {
  return planWithDefaults({
    ...state.plan,
    mode: $("plan-mode").value, intervalValue: Number($("plan-iv").value), intervalUnit: $("plan-iu").value,
    breakCount: Math.max(0, parseInt($("plan-count").value, 10) || 0), breakRepeat: Math.max(1, parseInt($("plan-repeat").value, 10) || 1),
    breakAtEnd: $("plan-end").checked, everyN: Math.max(0, parseInt($("plan-every").value, 10) || 0)
  });
}
function renderCutSummary(plan) {
  const ads = allAdsOrdered().filter((i) => i.active !== false && i.duration > 0);
  const box = $("cut-summary");
  let html = "";
  if (!ads.length) html += '<p class="msg error">Sin anuncios activos.</p>';
  if (plan.mode === "time" || plan.mode === "continuous") {
    if (!(intervalSeconds(plan) > 0)) html += '<p class="msg error">Falta el intervalo.</p>';
    const rows = describeCuts(state.lib, plan);
    html += rows.length ? rows.map((r) => `<p><b>${esc(r.title)}</b> (${fmtDuration(r.duration)}): ${[r.lead ? "al empezar" : "", r.cuts.length ? "cortes en " + r.cuts.map(fmtDuration).join(", ") : "", r.end ? "al terminar" : ""].filter(Boolean).join(" y ") || "sin cortes"}.</p>`).join("")
      : '';
  } else html += `<p>Habrá un corte cada ${plan.everyN} programas.</p>`;
  box.innerHTML = html;
}
function previewPlan() {
  const p = readPlanForm();
  $("plan-time-box").classList.toggle("hidden", p.mode === "programs"); $("plan-end-row").classList.toggle("hidden", p.mode === "continuous"); $("plan-prog-box").classList.toggle("hidden", p.mode !== "programs");
  renderCutSummary(p);
}
function renderAds() {
  const p = state.plan;
  $("plan-mode").value = p.mode; $("plan-iv").value = p.intervalValue; $("plan-iu").value = p.intervalUnit;
  $("plan-count").value = p.breakCount; $("plan-repeat").value = p.breakRepeat; $("plan-end").checked = !!p.breakAtEnd; $("plan-every").value = p.everyN;
  const ads = allAdsOrdered();
  $("ads-list").innerHTML = ads.length ? ads.map((i, n) => `<div class="item"><input type="checkbox" data-ad="${esc(i.id)}" ${i.active !== false ? "checked" : ""} aria-label="Activo">
    <span class="grow"><b>${n + 1}. ${esc(i.title)}</b>
      <div class="row2 playfor">Al aire: <input type="number" min="0" data-pm="${esc(i.id)}" value="${i.playFor > 0 ? Math.floor(Math.min(i.playFor, i.duration) / 60) : ""}" placeholder="min" aria-label="Minutos al aire"><input type="number" min="0" max="59" data-ps="${esc(i.id)}" value="${i.playFor > 0 ? Math.min(i.playFor, i.duration) % 60 : ""}" placeholder="seg" aria-label="Segundos al aire"></div></span><span>${fmtDuration(i.duration)}</span>
    <button class="btn secondary small" data-admv="${n}:-1" type="button" aria-label="Subir">↑</button><button class="btn secondary small" data-admv="${n}:1" type="button" aria-label="Bajar">↓</button></div>`).join("") : '<p class="hint">Sin anuncios</p>';
  $("ads-list").querySelectorAll("[data-ad]").forEach((c) => c.addEventListener("change", async () => {
    const it = state.lib.find((x) => x.id === c.dataset.ad); it.active = c.checked;
    try { await updateDoc(doc(db, "library", it.id), { active: c.checked }); renderCycle(); previewPlan(); } catch (err) { fail(err); }
  }));
  $("ads-list").querySelectorAll("[data-pm],[data-ps]").forEach((inp) => inp.addEventListener("change", async () => {
    const id = inp.dataset.pm || inp.dataset.ps, it = state.lib.find((x) => x.id === id); if (!it) return;
    const m = Math.max(0, Math.floor(Number($(`#ads-list [data-pm="${id}"]`).value) || 0)), sc = Math.max(0, Math.floor(Number($(`#ads-list [data-ps="${id}"]`).value) || 0));
    let playFor = m * 60 + sc; if (playFor > it.duration) { playFor = it.duration; toast(`Máximo ${fmtDuration(it.duration)}.`, "error"); }
    try { await updateDoc(doc(db, "library", it.id), { playFor }); it.playFor = playFor; renderAds(); renderCycle(); toast("Guardado.", "ok"); } catch (err) { fail(err); }
  }));
  $("ads-list").querySelectorAll("[data-admv]").forEach((b) => b.addEventListener("click", () => {
    const [n, d] = b.dataset.admv.split(":").map(Number), ids = ads.map((x) => x.id), m = n + d;
    if (m < 0 || m >= ids.length) return;
    [ids[n], ids[m]] = [ids[m], ids[n]]; state.plan.adOrder = ids;
    savePlan().then(() => { renderAds(); renderCycle(); }).catch(fail);
  }));
  previewPlan();
}
async function savePlanFromCommercial() {
  const p = readPlanForm();
  if (p.mode !== "programs" && !(intervalSeconds(p) >= 5)) { toast("Escribe un intervalo de al menos 5 segundos.", "error"); return; }
  state.plan = p;
  try { await savePlan(); renderCycle(); renderAds(); toast("Guardado.", "ok"); } catch (err) { fail(err); }
}
const savePlan = () => setDoc(doc(db, "config", "plan"), state.plan);

/* Programación */
// Parrilla principal: cada programa UNA sola vez (sin repeticiones ni horarios duplicados). Todas las emisiones, con sus repeticiones y horas, están en «Ciclo de emisión».
const orderFirsts = () => { const seen = new Set(), out = []; state.plan.order.forEach((id, n) => { if (!seen.has(id)) { seen.add(id); out.push(n); } }); return out; };   // posición de la primera emisión de cada programa
function renderOrder() {
  const firsts = orderFirsts(), total = state.plan.order.length;
  $("order-sum").textContent = `Parrilla principal (${firsts.length} programa${firsts.length === 1 ? "" : "s"})`;
  const el = $("order-list");
  if (!firsts.length) { el.innerHTML = '<p class="hint">Parrilla vacía</p>'; return; }
  el.innerHTML = (total > firsts.length ? `<p class="hint">${total - firsts.length} repeticion${total - firsts.length === 1 ? "" : "es"} más en el ciclo de emisión.</p>` : "") + firsts.map((n, r) => {
    const i = state.lib.find((x) => x.id === state.plan.order[n]);
    return `<div class="item ord"><span class="ord-n">${r + 1}.</span><span class="grow"><b>${esc(i.title)}</b></span><span class="ord-d">${fmtDuration(i.duration)}</span>
      <div class="ord-btns"><button class="btn secondary small" data-mv="${r}:-1" type="button" aria-label="Subir">↑</button>
      <button class="btn secondary small" data-mv="${r}:1" type="button" aria-label="Bajar">↓</button>
      <button class="btn secondary small" data-rm="${r}" type="button">Quitar</button></div>
      <div class="airt" data-air="${n}"></div></div>`;
  }).join("");
  el.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", () => {
    const [r, d] = b.dataset.mv.split(":").map(Number), o = state.plan.order, f = orderFirsts(), m = r + d;
    if (m < 0 || m >= f.length) return;
    [o[f[r]], o[f[m]]] = [o[f[m]], o[f[r]]]; savePlan().then(renderAll).catch(fail);   // se intercambian sus primeras emisiones; las repeticiones no se mueven
  }));
  el.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
    const airId = airProgramId();   // programa que suena ahora (antes de quitar)
    const id = state.plan.order[orderFirsts()[Number(b.dataset.rm)]];
    state.plan.order = state.plan.order.filter((x) => x !== id);   // sale de la parrilla y también todas sus repeticiones
    try {
      await savePlan(); renderAll();
      // Si quitaste el que estaba al aire, se publica al instante: salta al siguiente.
      if (airId && !String(airId).startsWith("pin_") && !state.plan.order.includes(airId)) await publish(true);
    } catch (err) { fail(err); }
  }));
}
// Id del programa que está al aire ahora (si hay un corte comercial, el programa al que pertenece).
function airProgramId() {
  const c = state.channel; if (!c?.items?.length || c.live === false) return null;
  const loc = studioLoc(c, serverNow()); if (!loc) return null;
  let k = loc.index; while (k > 0 && c.items[k].type !== "programa") k--;
  return c.items[k]?.type === "programa" ? c.items[k].id : null;
}
// Hora real (República Dominicana) de la próxima emisión de cada tramo del ciclo, igual que el reloj de arriba.
function cycleClock(cyc) {
  const old = state.channel, now = serverNow();
  if (!old?.items?.length || old.live === false || !cyc.length) return null;
  settleChannel(old, now);
  const loc = studioLoc(old, now); if (!loc) return null;
  const r = seamlessPublish(old.items, loc.index, loc.offset, cyc, now); if (!r) return null;
  const L = cycleLength(cyc) * 1000, st = []; let a = 0;
  for (const it of cyc) { st.push(a); a += it.duration * 1000; }
  if (r.next) {
    // Lo de abajo del programa al aire sale en ESTE ciclo (después de lo viejo que falta); lo de arriba, en la próxima vuelta.
    const headMs = r.items.slice(0, r.headLen).reduce((a, i) => a + i.duration * 1000, 0), tf = r.tailFrom;
    return { starts: st.map((x, k) => (k >= tf ? r.epoch + headMs + (x - st[tf]) : r.nextAt + x)), pending: true };
  }
  return { starts: st.map((x, k) => (k >= loc.index ? r.epoch + x : r.epoch + L + x)), pending: false };
}
function renderCycle() {
  const pc = getPinned();
  if (pc) { renderPinnedCycle(pc); return; }
  const cyc = buildCycle(state.lib, state.plan);
  const ads = cyc.filter((i) => i.type === "comercial").length, cuts = new Set(cyc.filter((i) => i.type === "comercial").map((i) => i.breakNo)).size;
  const clk = cycleClock(cyc);
  $("cycle-total").textContent = cyc.length ? `${state.plan.order.length} emisiones de programas (con repeticiones) · ${cuts} cortes · ${ads} anuncios · ciclo ${fmtDuration(cycleLength(cyc))}` : "Sin ciclo";
  let t = 0;
  $("cycle-list").innerHTML = cyc.slice(0, 400).map((i, k) => { const li = `<li class="${i.type === "comercial" ? "ad" : ""}">${clk ? hms(clk.starts[k]) : fmtDuration(t)} · ${esc(itemLabel(i))} · ${fmtDuration(i.duration)}${i.type === "comercial" ? ` (corte ${i.breakNo})` : (i.parts > 1 ? ` (del minuto ${fmtDuration(i.startAt)} al ${fmtDuration(i.startAt + i.duration)})` : "")}</li>`; t += i.duration; return li; }).join("")
    + (cyc.length > 400 ? `<li class="hint">… y ${cyc.length - 400} más</li>` : "");
  $("st-cycle").textContent = state.channel?.items?.length ? `${state.channel.items.length} elementos` : "Sin publicar";
  updateAirTimes(cyc, clk);
}
// Texto corto de «en 25 min» / «en 2 h 05 min» / «hace …».
function relTime(ms) {
  const m = Math.round(Math.abs(ms) / 60000), t = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  return ms < 0 ? `hace ${t}` : m < 1 ? "en un momento" : `en ${t}`;
}
const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
function dayTag() { return ""; }   // sin «mañana» ni fecha: solo la hora
// Escribe debajo de cada programa de la parrilla a qué hora sale (o «AL AIRE AHORA» / «SIGUIENTE»).
function updateAirTimes(cyc, clk) {
  const nodes = document.querySelectorAll("#order-list [data-air]"); if (!nodes.length) return;
  const pc0 = getPinned();
  if (pc0) {   // con fijados: la hora sale del día de hoy ya armado
    const today = pc0.error ? null : pc0.days[pinDayIndex(serverNow(), pc0.K)], mid = pinMidnight(serverNow());
    nodes.forEach((el) => {
      const r = today?.rows.find((x) => x.kind === "filler" && x.oi === Number(el.dataset.air));
      el.innerHTML = r ? `<span class="when">Sale ${esc(hm(mid + r.start * 1000))}</span><span class="when">Termina ${esc(hm(mid + r.end * 1000))}</span>` : '<span class="rel">Hoy no sale (los fijados ocupan su lugar)</span>';
    });
    return;
  }
  const now = serverNow(), order = state.plan.order;
  // Posición de la parrilla → tramo del ciclo donde ese programa arranca (buildCycle descarta los que no duran nada).
  const orderPos = []; order.forEach((id, n) => { const i = state.lib.find((x) => x.id === id); if (i && i.duration > 0) orderPos.push(n); });
  const startIdx = new Map(); let p = -1;
  cyc.forEach((it, k) => { if (it.type === "programa" && (!it.part || it.part === 1)) { p++; if (orderPos[p] != null) startIdx.set(orderPos[p], k); } });
  const cum = []; { let a = 0; for (const it of cyc) { cum.push(a); a += it.duration; } }
  // ¿Cuál de la parrilla está al aire ahora?
  let airPos = -1, airStart = 0; const c = state.channel;
  if (c?.items?.length && c.live !== false) {
    const loc = studioLoc(c, now);
    if (loc) {
      let k0 = loc.index, c0 = -1; for (let k = 0; k <= loc.index; k++) if (c.items[k].type === "programa" && (!c.items[k].part || c.items[k].part === 1)) c0 = k;
      k0 = c0; const air = k0 >= 0 ? c.items[k0] : null;
      if (air) {
        let el = loc.offset; for (let k = k0; k < loc.index; k++) el += c.items[k].duration;   // segundos que lleva al aire este programa
        airStart = now - el * 1000;
        const seq = c.items.slice(0, k0 + 1).filter((x) => x.type === "programa" && (!x.part || x.part === 1)).length - 1;
        const cand = order.map((id, n) => (id === air.id && startIdx.has(n) ? n : -1)).filter((n) => n >= 0);
        airPos = cand.reduce((b, n) => (b < 0 || Math.abs(n - seq) < Math.abs(b - seq) ? n : b), -1);
      }
    }
  }
  // Último tramo de cada programa (si se parte en varias partes por los cortes, termina en la última parte).
  const endIdx = new Map();
  startIdx.forEach((k, n) => { let e = k; const it = cyc[k]; if (it.parts > 1) for (let j = k + 1; j < cyc.length; j++) { const x = cyc[j]; if (x.type === "programa" && x.id === it.id && x.part > 1) { e = j; if (x.part >= it.parts) break; } else if (x.type === "programa") break; } endIdx.set(n, e); });
  nodes.forEach((el) => {
    const n = Number(el.dataset.air), k = startIdx.get(n);
    if (k == null) { el.innerHTML = ""; return; }
    const e = endIdx.get(n);
    if (!clk) { el.innerHTML = `<span class="when">Sale min ${fmtDuration(cum[k])}</span><span class="when">Termina min ${fmtDuration(cum[e] + cyc[e].duration)}</span>`; return; }
    // El que está al aire ya empezó: su hora de inicio es la de este ciclo (no la de la próxima vuelta).
    const t = n === airPos && airStart ? airStart : clk.starts[k];
    const tEnd = t + (cum[e] + cyc[e].duration - cum[k]) * 1000;
    el.innerHTML = `<span class="when">Sale ${esc(hm(t))}${dayTag(t, now)}</span><span class="when">Termina ${esc(hm(tEnd))}${dayTag(tEnd, now)}</span>${n === airPos ? "" : `<span class="rel">${esc(relTime(t - now))}</span>`}`;
  });
}

/* Directo en vivo (YouTube / Facebook) */
function renderLiveStream() {
  const on = !!(liveCfg?.on && liveCfg.ref);
  if (liveCfg?.url) $("lv-url").value = liveCfg.url;
  $("lv-state").textContent = on ? `EN VIVO · ${liveCfg.kind === "facebook" ? "Facebook" : "YouTube"}` : "Sin directo";
  $("lv-on").textContent = on ? "Actualizar directo" : "Poner en vivo";
}
async function setLiveStream(on) {
  try {
    if (on) {
      const url = $("lv-url").value.trim(), l = parseLiveLink(/^(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)\//i.test(url) ? `https://${url}` : url);
      if (!l) { toast("Ese enlace no es de YouTube ni de Facebook.", "error"); return; }
      liveCfg = { on: true, kind: l.kind, ref: l.ref, url, updatedAt: serverTimestamp() };
    } else liveCfg = { ...(liveCfg || {}), on: false, updatedAt: serverTimestamp() };
    await setDoc(doc(db, "public", "live"), liveCfg);
    renderLiveStream();
    toast(on ? "Directo activado." : "Directo quitado.", "ok");
  } catch (err) { fail(err); }
}

/* Cortar / reanudar emisión */
function renderLive() {
  const live = state.channel?.live !== false;
  const b = $("live-btn");
  b.textContent = live ? "Cortar emisión" : "Reanudar emisión";
  b.classList.toggle("resume", !live);
}
async function toggleLive() {
  if (!state.channel) { toast("Aún no hay emisión publicada.", "error"); return; }
  const c = state.channel, live = c.live === false, now = Math.round(serverNow());
  const where = () => { const l = locate(c.items, c.epoch, now); return l ? `«${l.item.type === "comercial" ? "Comercial" : l.item.title}» · minuto ${fmtDuration((l.item.startAt || 0) + l.offset)}` : ""; };
  try {
    let upd;
    if (!live) {
      // CORTAR: se guarda el punto exacto (lo que el Studio está emitiendo) y la hora del corte.
      settleChannel(c, now);
      upd = { live: false, pausedAt: now };
      const loc = c.items?.length ? studioLoc(c, now) : null;
      if (loc) {
        const start = c.items.slice(0, loc.index).reduce((a, i) => a + i.duration, 0);
        upd.epoch = Math.round(now - (start + loc.offset) * 1000);
        if (c.nextSeq) upd.nextAt = c.nextAt + (upd.epoch - c.epoch);
      }
    } else if (c.pausedAt > 0 && now >= c.pausedAt) {
      // REANUDAR: continúa donde se cortó (el reloj del ciclo se corre lo que duró el corte).
      const d = now - c.pausedAt;
      upd = { live: true, epoch: c.epoch + d, pausedAt: null };
      if (c.nextSeq) upd.nextAt = c.nextAt + d;
      else Object.assign(upd, compactChannel(c.items), { nextSeq: null, nextAt: null });
    } else {
      // Se cortó con una versión anterior (sin punto guardado): se usa lo último que el Studio dejó anotado.
      settleChannel(c, Infinity);
      let epoch = now;
      try {
        const snap = await getDoc(doc(db, "public", "onair")), o = snap.exists() ? snap.data() : null, it = o && c.items[o.index];
        if (it && it.id === o.id) {
          const before = c.items.slice(0, o.index).reduce((a, x) => a + x.duration, 0);
          epoch = Math.round(now - (before + Math.max(0, o.filePos - (it.startAt || 0))) * 1000);
        }
      } catch { /* sin datos: empieza de cero */ }
      upd = { live: true, epoch, pausedAt: null, ...compactChannel(c.items), nextSeq: null, nextAt: null };
    }
    await updateDoc(doc(db, "public", "channel"), upd);
    Object.assign(c, { live, ...(upd.epoch != null ? { epoch: upd.epoch } : {}), pausedAt: upd.pausedAt ?? null });
    if (upd.nextAt === null) { delete c.nextSeq; delete c.nextAt; } else if (upd.nextAt != null) c.nextAt = upd.nextAt;
    renderLive(); renderNow();
    toast(live ? `Emisión reanudada en ${where()}.` : `Emisión cortada en ${where()}.`, "ok");
  } catch (err) { fail(err); }
}

/* Publicar */
async function publish(auto, restart, opts) {
  restart = restart === true;   // true solo desde el botón «Publicar y reiniciar»
  opts = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  if (restart && !opts.noAsk && !(await askConfirm({ title: opts.alignAt ? "¿Publicar a este horario?" : "¿Reiniciar la emisión?", text: opts.alignAt ? `El primer programa queda a las ${opts.label}, igual que el reloj.` : "Empieza desde el primer programa.", ok: opts.alignAt ? "Publicar" : "Reiniciar", danger: true }))) return;
  let why = opts.alignAt ? "align" : restart ? "restart" : "";
  const pc = getPinned();
  if (pc?.error) { toast(pc.error, "error"); return; }
  const items = pc ? pc.items : buildCycle(state.lib, state.plan);
  if (!items.length && !auto && !(await askConfirm({ title: "Parrilla vacía", text: "El público verá «Sin programación».", ok: "Publicar" }))) return;
  try {
    await savePlan();
    const now = serverNow(), live = state.channel?.live !== false;
    // Emisión en marcha: NO se reinicia. Lo que está al aire sigue; lo nuevo por debajo entra en este ciclo y lo nuevo por encima, en la próxima repetición.
    let plan = null; const old = state.channel;
    if (!restart && live && old?.items?.length && items.length && !pc) {
      settleChannel(old, now);
      const loc = studioLoc(old, now);
      if (loc) {
        // Si se borró un video de la biblioteca, se saca de lo que falta por emitir; si justo ese estaba al aire, se empieza de cero.
        const gone = (it) => !state.lib.some((x) => x.id === it.id);
        // Si editaste el enlace/título de algo que ya estaba en la emisión, lo viejo se actualiza con lo nuevo de la biblioteca.
        const anyFresh = new Map(); for (const n of items) if (!anyFresh.has(n.id)) anyFresh.set(n.id, n);
        const refresh = (it) => { const f = anyFresh.get(it.id); return f && (f.src !== it.src || f.ref !== it.ref || f.title !== it.title) ? { ...it, title: f.title, src: f.src, ref: f.ref } : it; };
        const cur0 = old.items[loc.index], fa = anyFresh.get(cur0.id);
        const sourceChanged = !!fa && (fa.src !== cur0.src || fa.ref !== cur0.ref);   // cambiaste el enlace de lo que suena
        let k0 = loc.index; while (k0 > 0 && old.items[k0].type !== "programa") k0--;
        const airProg = old.items[k0], airRemoved = airProg?.type === "programa" && !items.some((n) => n.id === airProg.id);
        if (gone(cur0) || airRemoved) {
          // Quitaste (o borraste) lo que estaba al aire: salta YA al siguiente programa de la parrilla, no al primero.
          why = "removed"; plan = jumpPublish(old.items, k0, items, now, false);
        } else if ((sourceChanged && cur0.type === "programa") || (opts.reloadId && airProg?.id === opts.reloadId)) {
          // Cambiaste el enlace o la duración del programa al aire: se recarga ese mismo programa desde el inicio.
          why = sourceChanged ? "reload" : "dur"; plan = jumpPublish(old.items, k0, items, now, true);
        } else {
          const base = old.items.filter((it, k) => k === loc.index || !gone(it)).map(refresh);
          const idx = old.items.slice(0, loc.index).filter((it) => !gone(it)).length;
          plan = seamlessPublish(base, idx, loc.offset, items, now);
        }
      }
    }
    if (!plan) plan = { items, epoch: pc ? pinEpoch(now, pc.K) : Math.round(opts.alignAt || now), next: null, nextAt: 0 };   // con fijados la emisión se alinea al reloj (medianoche de RD)   // primera publicación, directo, pausa o borrado: empieza desde el principio
    const cur = compactChannel(plan.items), nxt = plan.next ? compactChannel(plan.next) : null;
    const channel = { epoch: plan.epoch, live, media: nxt ? { ...cur.media, ...nxt.media } : cur.media, seq: cur.seq, nextSeq: nxt ? nxt.seq : null, nextAt: nxt ? plan.nextAt : null, updatedAt: serverTimestamp() };
    if (JSON.stringify(cur).length > 900000) { toast("La programación de varios días es demasiado grande. Reduce las líneas de los fijados o los cortes comerciales.", "error"); return; }
    await setDoc(doc(db, "public", "channel"), channel);
    state.channel = { epoch: plan.epoch, items: plan.items, live, media: channel.media, seq: channel.seq, ...(nxt ? { nextSeq: nxt.seq, nextAt: plan.nextAt } : {}) };
    renderCycle(); renderNow();
    toast(pc ? `Publicado. Los fijados salen a su hora (${pc.K} día${pc.K === 1 ? "" : "s"} de rotación) y la emisión quedó alineada con el reloj.` : plan.next ? "Publicado. Lo nuevo de arriba entra en la próxima repetición." : why === "align" ? "Emisión alineada al horario." : why === "dur" ? "Duración actualizada: el programa se reinició." : why === "restart" ? "Emisión reiniciada." : why === "removed" ? "Quitaste el programa al aire: pasó al siguiente." : why === "reload" ? "Enlace actualizado: el programa se recargó con el video nuevo." : "Emisión publicada.", "ok");
  } catch (err) { fail(err); }
}
/* ===== Programas FIJADOS: salen SIEMPRE en su franja (de X a Y), con líneas/variaciones por día ===== */
let pinMemo = { key: "", val: null };
function getPinned() {
  const p = state.plan; if (!p.pins?.length) return null;
  const key = JSON.stringify([p.order, p.pins, p.mode, p.intervalValue, p.intervalUnit, p.breakCount, p.breakRepeat, p.breakAtEnd, p.everyN, p.minTailSec, p.adOrder, state.lib.map((i) => [i.id, i.kind, i.duration, i.active, i.playFor, i.url, i.title])]);
  if (key !== pinMemo.key) pinMemo = { key, val: buildPinnedCycle(state.lib, p) };
  return pinMemo.val;
}
const pinMidnight = (ms) => PIN_ANCHOR_MS + Math.floor((ms - PIN_ANCHOR_MS) / DAY_MS) * DAY_MS;   // 00:00 de hoy en República Dominicana
function renderPinnedCycle(pc) {
  if (pc.error) { $("cycle-total").textContent = pc.error; $("cycle-list").innerHTML = ""; updateAirTimes(); return; }
  const now = serverNow(), today = pinDayIndex(now, pc.K), day = pc.days[today], mid = pinMidnight(now);
  const ads = day.items.filter((i) => i.type === "comercial").length, cuts = new Set(day.items.filter((i) => i.type === "comercial").map((i) => i.breakNo)).size;
  $("cycle-total").textContent = `Hoy (día ${today + 1} de ${pc.K} de rotación) · ${day.rows.length} programas, ${state.plan.pins.length} fijado${state.plan.pins.length === 1 ? "" : "s"} · ${cuts} cortes · ${ads} anuncios · el día cierra a las 12:00 AM`;
  let t = mid;
  $("cycle-list").innerHTML = day.items.slice(0, 600).map((i) => { const li = `<li class="${i.type === "comercial" ? "ad" : ""}">${hms(t)} · ${esc(itemLabel(i))} · ${fmtDuration(i.duration)}${i.type === "comercial" ? ` (${i.breakNo ? `corte ${i.breakNo}` : "relleno para llegar a la hora fija"})` : (i.parts > 1 ? ` (del minuto ${fmtDuration(i.startAt)} al ${fmtDuration(i.startAt + i.duration)})` : "")}</li>`; t += i.duration * 1000; return li; }).join("");
  $("st-cycle").textContent = state.channel?.items?.length ? `${state.channel.items.length} elementos` : "Sin publicar";
  updateAirTimes();
}
const hmTxt = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const newId = () => Math.random().toString(36).slice(2, 8);
function normUrl(u) {
  u = String(u || "").trim();
  if (/^(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)\//i.test(u)) u = `https://${u}`;
  if (u && !/^https?:\/\//i.test(u)) u = new URL(`../media/${encodeURIComponent(u.replace(/^\/?(media\/)?/, ""))}`, location.href).href;
  return u;
}
function renderPinList() {
  const el = $("pin-list"); if (!el) return;
  const pins = (state.plan.pins || []).slice().sort((a, b) => pinWindow(a).f - pinWindow(b).f), pc = getPinned();
  if (!pins.length) { el.innerHTML = '<p class="hint">Todavía no hay programas fijados. Pulsa «Fijar programa» o el botón «Fijar» de cualquier fila de abajo.</p>'; return; }
  const today = pc && !pc.error ? pinDayIndex(serverNow(), pc.K) : null;
  el.innerHTML = pins.map((p) => {
    const w = pinWindow(p), n = pinLines(p).length, hoy = today != null && n ? ` · hoy: línea ${(today % n) + 1}` : "";
    return `<div class="pin-card${n ? "" : " bad"}"><div class="pin-main"><b>${esc(p.title)}</b><span>${clockTxt(w.f)} → ${clockTxt(w.t % 1440)}</span><span class="hint">${n} línea${n === 1 ? "" : "s"}${hoy} · ${p.tolMin > 0 ? `margen de ${p.tolMin} min antes o después` : "a la hora exacta"}</span>${n ? "" : '<span class="warn">Sin líneas válidas: no se emite.</span>'}</div><div class="pin-btns"><button class="btn small" data-pa="edit" data-pin="${esc(p.id)}" type="button">Líneas y hora</button><button class="btn danger small" data-pa="unpin" data-pin="${esc(p.id)}" type="button">Quitar</button></div></div>`;
  }).join("");
}

// ---- Día con fijados: las filas de hoy (o del día que elijas), con los fijados bloqueados en su hora ----
let dayView = null;   // día de la rotación que se está viendo (null = hoy)
function renderDayPinned(el, pc) {
  const p = state.plan;
  el.dataset.pinned = "1";
  if (pc.error) { el.innerHTML = `<p class="hint warn">${esc(pc.error)}</p>`; $("day-info").textContent = ""; $("day-undo").disabled = !dayUndo.length; return; }
  const today = pinDayIndex(serverNow(), pc.K), view = dayView == null || dayView >= pc.K ? today : dayView, day = pc.days[view];
  el.dataset.today = view === today ? "1" : "0";
  const slotAt = (min) => (p.slots || []).findIndex((s) => ((min - toMin(s.from) + 1440) % 1440) < slotLen(s));
  const clock = (sec) => clockTxt(sec / 60), mins = (sec) => Math.round(Math.abs(sec) / 60);
  let html = pc.K > 1 ? `<div class="day-tabs">${pc.days.map((_, k) => `<button type="button" class="btn small${k === view ? "" : " secondary"}" data-pa="view" data-d="${k}">Día ${k + 1}${k === today ? " · hoy" : ""}</button>`).join("")}</div>` : "";
  let lastSlot = -2;
  for (const r of day.rows) {
    const si = slotAt(Math.floor(r.start / 60) % 1440);
    if (si !== lastSlot) { lastSlot = si; const sl = p.slots?.[si]; html += `<div class="day-h"><span>${sl ? `${esc(slotLabel(sl))} · ${esc(sl.cat === "*" ? "Variado" : sl.cat)}` : "Sin franja"}</span><span>${sl ? esc(slotHours(sl)) : ""}</span></div>`; }
    if (r.kind === "pin") {
      const pin = p.pins.find((x) => x.id === r.pin), late = r.delta > 60, early = r.delta < -60;
      html += `<div class="day-row pinrow" data-s="${r.start}" data-e="${r.end}"><span class="day-grip" title="Fijado: no se mueve">Fijo</span>
        <span class="day-t">${esc(clock(r.start))}<small>→ ${esc(clock(r.end))}</small></span>
        <span class="day-main"><b>${esc(pin?.title || r.title)}</b><span class="day-meta"><span class="tag pin">Fijado ${esc(clock(r.from))} → ${esc(clock(r.to % 86400))}</span>${r.lines > 1 ? `<span class="tag rep">Línea ${r.lineNo} de ${r.lines}</span>` : ""}${early ? `<span class="tag off">Sale ${mins(r.delta)} min antes</span>` : ""}${late ? `<span class="tag bad">Sale ${mins(r.delta)} min tarde (el anterior se pasó)</span>` : ""}${r.pad > 30 ? `<span class="tag off">${mins(r.pad)} min de anuncios repartidos antes, para llegar a su hora</span>` : ""}${r.endDelta > 60 ? `<span class="tag off">Termina ${mins(r.endDelta)} min después de su franja</span>` : ""}<span>${esc(r.title === pin?.title ? "" : r.title)}</span></span></span>
        <span class="day-btns"><button class="btn secondary small" data-pa="edit" data-pin="${esc(r.pin)}" type="button">Líneas</button><button class="btn danger small" data-pa="unpin" data-pin="${esc(r.pin)}" type="button" title="Quitar el fijado">✕</button></span></div>`;
      continue;
    }
    const i = state.lib.find((x) => x.id === r.id); if (!i) continue;
    const sl = si >= 0 ? p.slots[si] : null, off = sl && sl.cat !== "*" && i.cat !== sl.cat;
    html += `<div class="day-row" draggable="true" data-n="${r.oi}" data-s="${r.start}" data-e="${r.end}"><span class="day-grip" title="Arrastrar">⠿</span>
      <span class="day-t">${esc(clock(r.start))}<small>→ ${esc(clock(r.end))}</small></span>
      <span class="day-main"><b>${esc(i.title)}</b><span class="day-meta">${i.cat ? `<span class="tag">${esc(i.cat)}</span>` : ""}${off ? '<span class="tag off">Fuera de su franja</span>' : ""}<span>${fmtDuration(i.duration)}</span></span></span>
      <span class="day-btns"><button class="btn secondary small" data-act="up" data-n="${r.oi}" type="button" aria-label="Subir">↑</button><button class="btn secondary small" data-act="down" data-n="${r.oi}" type="button" aria-label="Bajar">↓</button><button class="btn secondary small" data-act="swap" data-n="${r.oi}" type="button" title="Cambiar por otro programa" aria-label="Cambiar">⇄</button><button class="btn secondary small" data-act="ins" data-n="${r.oi}" type="button" title="Insertar uno debajo" aria-label="Insertar debajo">＋</button><button class="btn small" data-pa="pinrow" data-n="${r.oi}" data-s="${r.start}" data-e="${r.end}" type="button" title="Fijar este programa en esta hora">Fijar</button><button class="btn danger small" data-act="del" data-n="${r.oi}" type="button" aria-label="Quitar">✕</button></span></div>`;
  }
  el.innerHTML = html;
  const w = day.warn.length ? ` · Aviso: ${day.warn.join(" ")}` : "";
  $("day-info").textContent = `Día ${view + 1} de ${pc.K}${view === today ? " (hoy)" : ""} · ${day.rows.length} programas · nunca se corta un programa · el día cierra a las 12:00 AM${w}`;
  $("day-undo").disabled = !dayUndo.length;
  markDayAir();
}

// ---- Ventana para fijar / editar un fijado ----
let pinDraft = null, pinIsNew = false, pinFromOrder = null, pinSeen = null;
function pinOverlap(d) { const w = pinWindow(d); return (state.plan.pins || []).filter((x) => x.id !== d.id).find((x) => { const o = pinWindow(x); return w.f < o.t && w.t > o.f; }); }
function renderPinTimeInfo() {
  const d = pinDraft, w = pinWindow(d), ov = pinOverlap(d), len = w.t - w.f, bad = toMin(d.to) <= toMin(d.from) && toMin(d.to) !== 0;
  $("pin-time-info").innerHTML = `Franja de ${Math.floor(len / 60) ? `${Math.floor(len / 60)} h ` : ""}${len % 60 ? `${len % 60} min` : ""}`.trim()
    + (ov ? ` · <span class="warn">Se cruza con «${esc(ov.title)}»</span>` : "") + (bad ? ' · <span class="warn">«Hasta» debe ser después de «Desde»; así llega hasta las 12:00 AM</span>' : "");
}
function renderPinLines() {
  const ls = pinDraft.lines, el = $("pin-lines");
  el.innerHTML = ls.length ? ls.map((l, k) => `<div class="pin-line" data-k="${k}">
    <div class="pin-line-h"><b>Línea ${k + 1}</b><span class="hint">${ls.length > 1 ? `sale el día ${k + 1} de cada ${ls.length}` : "sale todos los días"}</span>${l.fbOk === true ? '<span class="tag ok">✓ Se ve</span>' : l.fbOk === false ? '<span class="tag bad">✗ No se ve</span>' : ""}</div>
    <input data-lf="title" value="${esc(l.title)}" placeholder="Nombre (opcional)" maxlength="120">
    <input data-lf="url" value="${esc(l.url)}" placeholder="Enlace">
    <div class="pin-line-r"><label>Duración <input data-lf="dur" value="${esc(fmtDuration(l.duration))}" inputmode="numeric" placeholder="1:30:00"></label>
    <span class="pin-line-b"><button class="btn small" data-lp="view" type="button">Ver</button><button class="btn secondary small" data-lp="up" type="button" aria-label="Subir">↑</button><button class="btn secondary small" data-lp="down" type="button" aria-label="Bajar">↓</button><button class="btn danger small" data-lp="del" type="button" aria-label="Quitar línea">✕</button></span></div></div>`).join("")
    : '<p class="hint">Sin líneas. Agrega al menos una abajo.</p>';
}
function renderPinEditor() {
  const d = pinDraft;
  $("pin-h").textContent = pinIsNew ? "Fijar programa" : "Programa fijado";
  $("pin-title").value = d.title; $("pin-tol").value = String(d.tolMin ?? 5);
  $("pin-time").innerHTML = tsel("pin", "from", d.from) + tsel("pin", "to", d.to);
  $("pin-remove").hidden = pinIsNew; $("pin-view").classList.add("hidden"); $("pin-view").innerHTML = ""; $("pin-seen").classList.add("hidden");
  ["pin-url", "pin-ltitle", "pin-dh", "pin-dm", "pin-ds"].forEach((id) => { $(id).value = ""; });
  renderPinTimeInfo(); renderPinLines();
}
function openPinEditor(src, fromOrder) {
  pinDraft = JSON.parse(JSON.stringify(src)); pinIsNew = !(state.plan.pins || []).some((x) => x.id === src.id); pinFromOrder = fromOrder || null; pinSeen = null;
  renderPinEditor(); $("pin").classList.remove("hidden");
}
const closePin = () => { $("pin").classList.add("hidden"); $("pin-view").innerHTML = ""; pinDraft = null; };
function pinPreview(url, k) {
  const v = $("pin-view"); if (!url) { toast("Pon el enlace primero.", "error"); return; }
  v.innerHTML = embedOf({ url: normUrl(url) }); v.classList.remove("hidden"); pinSeen = k; $("pin-seen").classList.toggle("hidden", k == null);
  v.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function pinAddLine() {
  const raw = $("pin-url").value.trim(); if (!raw) { toast("Pon el enlace.", "error"); return; }
  const url = normUrl(raw), fb = !!facebookUrl(url), yt = youtubeId(url);
  let dur = Math.max(0, Math.floor(Number($("pin-dh").value) || 0)) * 3600 + Math.max(0, Math.floor(Number($("pin-dm").value) || 0)) * 60 + Math.max(0, Math.floor(Number($("pin-ds").value) || 0));
  if (!(dur > 0)) {
    if (fb) { toast("En Facebook hay que escribir la duración.", "error"); return; }
    toast("Detectando la duración…", "ok"); dur = yt ? await ytDuration(yt) : await detectDuration(url);
  }
  if (!(dur > 0)) { toast("No pude detectar la duración. Escríbela.", "error"); return; }
  pinDraft.lines.push({ id: newId(), url, duration: dur, title: $("pin-ltitle").value.trim() });
  ["pin-url", "pin-ltitle", "pin-dh", "pin-dm", "pin-ds"].forEach((id) => { $(id).value = ""; });
  renderPinLines(); toast(`Línea ${pinDraft.lines.length} agregada. Pulsa «Ver» para comprobar que se reproduce.`, "ok");
}
async function pinSave(publishToo) {
  const d = pinDraft; if (!d) return;
  d.title = ($("pin-title").value || "").trim() || d.lines[0]?.title || "Programa fijado";
  if (!pinLines(d).length) { toast("Agrega al menos una línea con enlace y duración.", "error"); return; }
  const ov = pinOverlap(d); if (ov) { toast(`La franja se cruza con «${ov.title}». Cambia la hora.`, "error"); return; }
  const pins = state.plan.pins = state.plan.pins || [], i = pins.findIndex((x) => x.id === d.id);
  if (i >= 0) pins[i] = d; else pins.push(d);
  let moved = "";
  if (pinFromOrder && state.plan.order[pinFromOrder.oi] === pinFromOrder.id) { state.plan.order.splice(pinFromOrder.oi, 1); moved = " Salió de la parrilla de abajo: ahora solo sale en su hora fija."; }
  pinFromOrder = null; closePin();
  try { await savePlan(); renderAll(); } catch (err) { fail(err); return; }
  toast(`«${d.title}» fijado de ${clockTxt(pinWindow(d).f)} a ${clockTxt(pinWindow(d).t % 1440)}.${moved}${publishToo ? "" : " Pulsa «Guardar y publicar» para que salga al aire."}`, "ok");
  if (publishToo) await publish(false);
}
async function unpin(id) {
  const pin = state.plan.pins.find((x) => x.id === id); if (!pin) return;
  if (!(await askConfirm({ title: "¿Quitar el fijado?", text: `«${pin.title}» deja de salir en su hora fija. Sus líneas se pierden.`, ok: "Quitar", danger: true }))) return;
  state.plan.pins = state.plan.pins.filter((x) => x.id !== id);
  try { await savePlan(); renderAll(); toast("Fijado quitado. Pulsa «Guardar y publicar» para aplicarlo al aire.", "ok"); } catch (err) { fail(err); }
}
function initPins() {
  $("pin-new").addEventListener("click", async () => {
    const nid = await pickProgram("Elegir el programa a fijar"); const it = nid && state.lib.find((x) => x.id === nid); if (!it) return;
    const f = Math.ceil(nowMin() / 5) * 5, to = f + Math.max(5, Math.ceil(it.duration / 300) * 5);
    openPinEditor({ id: newId(), title: it.title, from: hmTxt(f), to: to >= 1440 ? "00:00" : hmTxt(to), tolMin: 10, lines: [{ id: newId(), url: it.url, duration: it.duration, title: it.title, ...(it.fbOk != null ? { fbOk: it.fbOk } : {}) }] });
  });
  $("tab-dia").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pa]"); if (!b) return;
    const a = b.dataset.pa;
    if (a === "view") { dayView = Number(b.dataset.d); renderDay(); }
    else if (a === "edit") { const pin = state.plan.pins.find((x) => x.id === b.dataset.pin); if (pin) openPinEditor(pin); }
    else if (a === "unpin") await unpin(b.dataset.pin);
    else if (a === "pinrow") {
      const oi = Number(b.dataset.n), id = state.plan.order[oi], it = state.lib.find((x) => x.id === id); if (!it) return;
      const s = Number(b.dataset.s), en = Number(b.dataset.e), f = Math.round(s / 300) * 5, to = Math.ceil(en / 300) * 5;
      openPinEditor({ id: newId(), title: it.title, from: hmTxt(f), to: to >= 1440 ? "00:00" : hmTxt(to), tolMin: 10, lines: [{ id: newId(), url: it.url, duration: it.duration, title: it.title, ...(it.fbOk != null ? { fbOk: it.fbOk } : {}) }] }, { oi, id });
    }
  });
  const dlg = $("pin");
  $("pin-title").addEventListener("input", () => { if (pinDraft) pinDraft.title = $("pin-title").value; });
  $("pin-tol").addEventListener("change", () => { if (pinDraft) pinDraft.tolMin = Number($("pin-tol").value) || 0; });
  $("pin-time").addEventListener("change", (e) => {
    const box = e.target.closest(".tsel"); if (!box || !pinDraft) return;
    const g = (k) => box.querySelector(`[data-tp="${k}"]`).value, h24 = (Number(g("h")) % 12) + (g("a") === "PM" ? 12 : 0);
    pinDraft[box.dataset.k] = `${String(h24).padStart(2, "0")}:${String(Number(g("m"))).padStart(2, "0")}`; renderPinTimeInfo();
  });
  $("pin-lines").addEventListener("change", (e) => {
    const t = e.target, row = t.closest(".pin-line"); if (!row || !t.dataset.lf || !pinDraft) return;
    const l = pinDraft.lines[Number(row.dataset.k)]; if (!l) return;
    if (t.dataset.lf === "title") l.title = t.value.trim();
    else if (t.dataset.lf === "url") { l.url = normUrl(t.value); l.fbOk = undefined; delete l.fbOk; t.value = l.url; renderPinLines(); }
    else { const d = parseDuration(t.value); if (d > 0) { l.duration = Math.round(d); t.value = fmtDuration(l.duration); } else { toast("Duración no válida. Usa 1:30:00 o 45:00.", "error"); t.value = fmtDuration(l.duration); } }
  });
  $("pin-lines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lp]"); if (!b || !pinDraft) return;
    const k = Number(b.closest(".pin-line").dataset.k), ls = pinDraft.lines, a = b.dataset.lp;
    if (a === "view") pinPreview(ls[k].url, k);
    else if (a === "del") { ls.splice(k, 1); $("pin-view").classList.add("hidden"); $("pin-view").innerHTML = ""; $("pin-seen").classList.add("hidden"); renderPinLines(); }
    else { const m = k + (a === "up" ? -1 : 1); if (m >= 0 && m < ls.length) { [ls[k], ls[m]] = [ls[m], ls[k]]; renderPinLines(); } }
  });
  $("pin-add").addEventListener("click", pinAddLine);
  $("pin-test").addEventListener("click", () => pinPreview($("pin-url").value, null));
  const mark = (ok) => { if (pinSeen == null || !pinDraft?.lines[pinSeen]) return; pinDraft.lines[pinSeen].fbOk = ok; renderPinLines(); toast(ok ? "Marcada: se ve." : "Marcada: no se ve. Se salta mientras haya otras líneas.", "ok"); };
  $("pin-ok").addEventListener("click", () => mark(true)); $("pin-no").addEventListener("click", () => mark(false));
  $("pin-save").addEventListener("click", () => pinSave(false));
  $("pin-savepub").addEventListener("click", () => pinSave(true));
  $("pin-cancel").addEventListener("click", closePin);
  $("pin-remove").addEventListener("click", async () => { const id = pinDraft?.id; closePin(); if (id) await unpin(id); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !dlg.classList.contains("hidden") && $("dlg").classList.contains("hidden")) closePin(); });
}

let tlKey = "";
// ---- Línea de tiempo: grande, con desplazamiento y zoom; el cabezal (raya blanca) arrastra la barra si se sale de la vista ----
const TL_LEVELS = [0.03, 0.06, 0.12, 0.25, 0.5, 1, 2];   // píxeles por segundo
let tlLevel = 4, tlUserAt = 0, tlDrag = null, tlLastIdx = -1, tlRecenter = true;
function renderTimeline(items, loc, total, before, key) {
  const tl = $("timeline"), cw = tl.clientWidth || 600, wpx = Math.max(cw, Math.round(total * TL_LEVELS[tlLevel])), k = `${key}:${tlLevel}:${cw}`;
  if (k !== tlKey) {
    tlKey = k; const sc = tl.scrollLeft;
    tl.innerHTML = `<div class="tl-in" style="width:${wpx}px">` + items.map((i) => `<i class="${i.type === "comercial" ? "ad" : ""}" style="width:${(i.duration / total) * wpx}px" title="${esc(itemLabel(i))} · ${fmtDuration(i.duration)}"><span>${i.type === "comercial" ? "" : esc(i.title)}</span></i>`).join("") + "<u></u></div>";
    tl.scrollLeft = sc; tlLastIdx = -1;
  }
  const inner = tl.querySelector(".tl-in"), frac = (before + loc.offset) / total, hx = frac * wpx;
  inner.querySelector("u").style.left = `${frac * 100}%`;
  if (loc.index !== tlLastIdx) { tlLastIdx = loc.index; inner.querySelector("i.cur")?.classList.remove("cur"); inner.children[loc.index]?.classList.add("cur"); }
  const l = tl.scrollLeft;
  if (tlRecenter) { tlRecenter = false; tl.scrollLeft = Math.max(0, hx - cw * 0.3); }
  else if (Date.now() - tlUserAt > 8000 && (hx > l + cw * 0.8 || hx < l + cw * 0.05)) tl.scrollTo({ left: Math.max(0, hx - cw * 0.3), behavior: "smooth" });   // sigue al cabezal salvo que estés moviendo la barra
}
function initTimeline() {
  const tl = $("timeline"), touch = () => { tlUserAt = Date.now(); };
  tl.addEventListener("pointerdown", (e) => { touch(); if (e.pointerType === "mouse" && e.button === 0) { tlDrag = { x: e.clientX, l: tl.scrollLeft }; tl.classList.add("drag"); try { tl.setPointerCapture(e.pointerId); } catch { /* sin captura */ } } });
  tl.addEventListener("pointermove", (e) => { if (tlDrag) { tl.scrollLeft = tlDrag.l - (e.clientX - tlDrag.x); touch(); } });
  ["pointerup", "pointercancel"].forEach((ev) => tl.addEventListener(ev, () => { tlDrag = null; tl.classList.remove("drag"); }));
  tl.addEventListener("touchstart", touch, { passive: true });
  tl.addEventListener("wheel", (e) => { e.preventDefault(); tl.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY); touch(); }, { passive: false });
  const zoom = (d) => { tlLevel = Math.max(0, Math.min(TL_LEVELS.length - 1, tlLevel + d)); tlKey = ""; tlRecenter = true; tlUserAt = 0; renderNow(); };
  $("tl-minus").addEventListener("click", () => zoom(-1));
  $("tl-plus").addEventListener("click", () => zoom(1));
  $("tl-now").addEventListener("click", () => { tlUserAt = 0; tlRecenter = true; renderNow(); });
}

const TZ = "America/Santo_Domingo";   // hora de República Dominicana
const HMS = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
const HM = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const hm = (ms) => HM.format(new Date(ms));   // 6:49 PM (sin segundos)
const hms = (ms) => HMS.format(new Date(ms));   // 2:33:32 PM (hora de República Dominicana)
// La posición real la marca el video de la vista previa (no el reloj): así la barra de abajo corre junto con él.
function studioLoc(c, now) {
  try {
    const o = $("monitor").contentWindow.__onair;
    if (o && o.epoch === c.epoch && now - o.at < 4000) {
      const item = c.items[o.index];
      if (item && item.id === o.id) {
        const filePos = o.p ? o.filePos : o.filePos + (now - o.at) / 1000;   // en pausa la barra no avanza
        const offset = Math.min(item.duration, Math.max(0, filePos - (item.startAt || 0)));
        return { index: o.index, item, offset, remaining: item.duration - offset };
      }
    }
  } catch { /* la vista previa aún no carga */ }
  return locate(c.items, c.epoch, now);
}
function renderNow() {
  const now = serverNow();
  settleChannel(state.channel, now);   // si toca el relevo a la lista nueva del ciclo
  $("clock").textContent = hms(now);
  const c = state.channel;
  const airKey = c?.items?.length ? `${c.epoch}:${c.live}:${c.items.length}:${Math.floor(((now - c.epoch) / 1000) / 30)}` : "";
  if (airKey !== renderNow.airKey) { renderNow.airKey = airKey; renderCycle(); }   // cada ~30 s y en cada cambio: las horas de la parrilla se mantienen al día
  const paused = c?.live === false;
  const loc = c?.items?.length ? studioLoc(c, now) : null;   // el Studio sigue funcionando aunque el público esté cortado
  $("onair").classList.toggle("off", !loc || paused);
  $("onair").querySelector("b").textContent = paused ? "EMISIÓN CORTADA" : loc ? "AL AIRE" : "FUERA DEL AIRE";
  renderLive();
  if (!loc) {
    ["now-title", "next-title"].forEach((k) => ($(k).textContent = "—"));
    $("now-left").textContent = "--:--"; $("next-start").textContent = "--:--:--"; $("now-bar").style.width = "0";
    $("live-body").innerHTML = ""; $("timeline").innerHTML = ""; tlKey = ""; return;
  }
  const items = c.items, n = items.length;
  const next = items[(loc.index + 1) % n];
  $("now-title").textContent = `${loc.item.type === "comercial" ? "[Comercial] " : ""}${itemLabel(loc.item)}`;
  $("next-title").textContent = itemLabel(next);
  $("now-left").textContent = fmtDuration(loc.remaining);
  $("now-bar").style.width = `${(loc.offset / loc.item.duration) * 100}%`;
  $("next-start").textContent = hms(now + loc.remaining * 1000);

  // Línea de tiempo del ciclo con cabezal
  const total = cycleLength(items);
  let before = 0; for (let k = 0; k < loc.index; k++) before += items[k].duration;
  renderTimeline(items, loc, total, before, `${c.epoch}:${n}:${total}`);

  // Tabla de emisión con horas reales
  // Programas y comerciales (los comerciales salen en ámbar)
  let t = now - loc.offset * 1000, rows = "", shown = 0;
  for (let k = 0; k < n * 2 && shown < 16; k++) {
    const it = items[(loc.index + k) % n], ad = it.type === "comercial";
    rows += `<tr class="${k === 0 ? "cur" : ad ? "ad" : "prog"}"><td>${hms(t)}</td><td>${esc(itemLabel(it))}${ad && it.breakNo ? ` · corte ${it.breakNo}` : ""}</td><td>${it.type}</td><td>${fmtDuration(it.duration)}</td></tr>`; shown++;
    t += it.duration * 1000;
  }
  $("live-body").innerHTML = rows;
}

/* Personalización */
function onLogoFile() {
  const f = $("b-logo-file").files[0]; if (!f) return;
  const img = new Image(), url = URL.createObjectURL(f);
  img.onload = () => {
    const sc = Math.min(1, 400 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    state.brand.logo = cv.toDataURL("image/png"); URL.revokeObjectURL(url);
    $("b-logo-file").value = ""; renderBrand(); toast("Logo cargado.", "ok");
  };
  img.onerror = () => toast("No se pudo leer esa imagen.", "error");
  img.src = url;
}
function renderBrand() {
  $("b-logo-pos").value = state.brand.logoPos || "top-right"; $("b-logo-size").value = state.brand.logoSize || 14; $("b-logo-op").value = Math.round((state.brand.logoOpacity ?? 0.9) * 100);
  $("b-logo-prev").src = state.brand.logo || ""; $("b-logo-prev").classList.toggle("hidden", !state.brand.logo);
  $("b-logo-rm").classList.toggle("hidden", !state.brand.logo);
}
async function saveBrand(keep) {
  state.brand = { name: "", showName: false, accent: state.brand.accent || "#0E6B73", logo: state.brand.logo || "", ticker: "", tickerMove: true, tickerSep: "●", tickerSpeed: 120, logoPos: $("b-logo-pos").value, logoSize: Number($("b-logo-size").value), logoOpacity: Number($("b-logo-op").value) / 100 };
  try { await setDoc(doc(db, "public", "brand"), state.brand); toast("Publicado.", "ok"); } catch (err) { fail(err); }
}

/* Estadísticas */
async function reloadLibrary() {   // vuelve a leer la biblioteca para que las estadísticas usen solo lo que existe hoy
  const [libSnap, chSnap] = await Promise.all([getDocs(collection(db, "library")), getDoc(doc(db, "public", "channel"))]);
  state.lib = libSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  state.channel = chSnap.exists() ? { ...chSnap.data(), items: expandChannel(chSnap.data()) } : null;
  renderAll();
}
async function loadStats() {
  try {
    try { await reloadLibrary(); } catch { /* se usa la biblioteca ya cargada */ }
    const snap = await getDocs(query(collection(db, "stats"), orderBy("at", "desc"), limit(2000)));
    const norm = (t) => String(t || "").trim().toLowerCase();
    const known = new Set(state.lib.map((i) => norm(i.title)));
    const rows = snap.docs.map((d) => d.data()).filter((r) => known.has(norm(r.title)));   // se ignoran programas borrados y pruebas antiguas
    const day = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
    const today = day(Date.now());
    const todayRows = rows.filter((r) => r.at && day(r.at.toDate().getTime()) === today);
    $("stats-summary").innerHTML = `<li><span>Reproducciones</span><b>${rows.length}</b></li>
      <li><span>Espectadores distintos</span><b>${new Set(rows.map((r) => r.sid)).size}</b></li>
      <li><span>Reproducciones hoy</span><b>${todayRows.length}</b></li>
      <li><span>Espectadores hoy</span><b>${new Set(todayRows.map((r) => r.sid)).size}</b></li>`;
    const count = new Map();
    rows.forEach((r) => count.set(norm(r.title), (count.get(norm(r.title)) || 0) + 1));
    const list = state.lib.map((i) => ({ title: i.title, kind: i.kind, n: count.get(norm(i.title)) || 0 })).sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
    $("stats-table").innerHTML = list.length ? `<table><thead><tr><th>Contenido</th><th>Tipo</th><th>Veces</th></tr></thead><tbody>${
      list.map((x) => `<tr><td>${esc(x.title)}</td><td>${esc(x.kind)}</td><td>${x.n}</td></tr>`).join("")}</tbody></table>` : '<p class="hint">Sin contenidos</p>';
  } catch (err) { fail(err); }
}

/* ===== Parrilla práctica · Añadir rápido · Horarios por categoría · Verificador de videos ===== */
const DEFAULT_CATS = ["Caricaturas", "Informativos", "Entretenimiento", "Novelas", "Películas"];
const DEFAULT_SLOTS = [
  { from: "06:00", to: "10:00", cat: "Caricaturas" }, { from: "10:00", to: "14:00", cat: "Informativos" },
  { from: "14:00", to: "18:00", cat: "Entretenimiento" }, { from: "18:00", to: "22:00", cat: "Novelas" },
  { from: "22:00", to: "00:00", cat: "Informativos" }, { from: "00:00", to: "02:00", cat: "Películas" },
  { from: "02:00", to: "06:00", cat: "*" }
];
const OLD_SLOTS = JSON.stringify([
  { from: "06:00", to: "10:00", cat: "Caricaturas" }, { from: "10:00", to: "13:00", cat: "Informativos" },
  { from: "13:00", to: "17:00", cat: "Entretenimiento" }, { from: "17:00", to: "18:00", cat: "*" },
  { from: "18:00", to: "21:00", cat: "Novelas" }, { from: "21:00", to: "22:00", cat: "*" },
  { from: "22:00", to: "00:00", cat: "Películas" }, { from: "00:00", to: "06:00", cat: "*" }
]);
const ORDERS = { long: "Mayor a menor duración", short: "Menor a mayor duración", new: "Más recientes primero", old: "Más antiguos primero", az: "A–Z", rnd: "Al azar" };
function ensureSched() {
  const p = state.plan;
  if (!Array.isArray(p.cats)) p.cats = [...DEFAULT_CATS];
  if (!Array.isArray(p.pins)) p.pins = [];
  if (Array.isArray(p.slots) && JSON.stringify(p.slots.map(({ from, to, cat }) => ({ from, to, cat }))) === OLD_SLOTS) p.slots = null;   // las franjas de la versión anterior se cambian por las nuevas
  if (!Array.isArray(p.slots) || !p.slots.length) p.slots = DEFAULT_SLOTS.map((s) => ({ ...s }));
  p.quick = { which: "new", order: "long", cat: "", max: "", skipBad: true, replace: false, time: true, ...(p.quick || {}) };
  p.hOpt = { order: "old", skipBad: true, fromNow: true, ...(p.hOpt || {}) };
}
const catsAll = () => [...new Set([...(state.plan.cats || []), ...(state.plan.slots || []).map((s) => s.cat).filter((c) => c && c !== "*"), ...state.lib.map((i) => i.cat).filter(Boolean)])];
const sortProgs = (list, how) => sortPrograms(list, how, createdMs);
const toMin = (t) => { const [hh, mm] = String(t || "0:0").split(":").map(Number); return (((hh || 0) * 60 + (mm || 0)) % 1440 + 1440) % 1440; };
const clockTxt = (min) => { min = Math.round(((min % 1440) + 1440) % 1440); const hh = Math.floor(min / 60), mm = min % 60; return `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`; };
const plusHour = (t) => `${String((Math.floor(toMin(t) / 60) + 1) % 24).padStart(2, "0")}:${String(toMin(t) % 60).padStart(2, "0")}`;
let schedVals = false, lastSched = null;
const tsel = (n, k, v) => {
  const m = toMin(v), h24 = Math.floor(m / 60), h12 = h24 % 12 || 12, mi = m % 60, mins = [...new Set([...Array(12).keys()].map((x) => x * 5).concat(mi))].sort((a, b) => a - b);
  return `<span class="tsel" data-n="${n}" data-k="${k}"><small class="tl">${k === "from" ? "Desde" : "Hasta"}</small>`
    + `<select data-tp="h" aria-label="Hora">${[...Array(12).keys()].map((x) => `<option value="${x + 1}"${x + 1 === h12 ? " selected" : ""}>${x + 1}</option>`).join("")}</select><b>:</b>`
    + `<select data-tp="m" aria-label="Minutos">${mins.map((x) => `<option value="${x}"${x === mi ? " selected" : ""}>${String(x).padStart(2, "0")}</option>`).join("")}</select>`
    + `<select data-tp="a" aria-label="AM o PM"><option value="AM"${h24 < 12 ? " selected" : ""}>AM</option><option value="PM"${h24 >= 12 ? " selected" : ""}>PM</option></select></span>`;
};

function initSched() {
  ["q-order", "h-order"].forEach((id) => { $(id).innerHTML = Object.entries(ORDERS).map(([k, v]) => `<option value="${k}">${v}</option>`).join(""); });
  $("quick-btn").addEventListener("click", quickAdd);
  $("pick-q").addEventListener("input", renderPick);
  $("pick-list").addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (b) addToGrid(b.dataset.pick); });
  $("cat-add").addEventListener("click", () => {
    const v = $("cat-new").value.trim(); if (!v) return;
    if (!catsAll().some((c) => c.toLowerCase() === v.toLowerCase())) state.plan.cats.push(v);
    $("cat-new").value = ""; savePlan().then(renderAll).catch(fail);
  });
  $("cat-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-catdel]"); if (!b) return; state.plan.cats.splice(Number(b.dataset.catdel), 1); savePlan().then(renderAll).catch(fail); });
  $("slot-add").addEventListener("click", () => { const l = state.plan.slots.at(-1); state.plan.slots.push({ from: l ? l.to : "06:00", to: plusHour(l ? l.to : "06:00"), cat: "*" }); savePlan().then(renderSched).catch(fail); });
  $("slot-list").addEventListener("change", (e) => {
    const t = e.target, sl = state.plan.slots, box = t.closest(".tsel");
    if (box) {
      const g = (k) => box.querySelector(`[data-tp="${k}"]`).value, h24 = (Number(g("h")) % 12) + (g("a") === "PM" ? 12 : 0);
      sl[+box.dataset.n][box.dataset.k] = `${String(h24).padStart(2, "0")}:${String(Number(g("m"))).padStart(2, "0")}`;
    } else if (t.dataset.sc != null) sl[+t.dataset.sc].cat = t.value; else return;
    savePlan().then(renderSched).catch(fail);
  });
  $("slot-reset").addEventListener("click", () => { state.plan.slots = DEFAULT_SLOTS.map((x) => ({ ...x })); savePlan().then(() => { renderSched(); toast("Franjas restauradas.", "ok"); }).catch(fail); });
  $("slot-list").addEventListener("click", (e) => { const b = e.target.closest("[data-sd]"); if (!b) return; state.plan.slots.splice(Number(b.dataset.sd), 1); savePlan().then(renderSched).catch(fail); });
  $("gen-btn").addEventListener("click", generateSchedule);
  $("align-btn").addEventListener("click", () => publishAligned(false));
  $("fbv-close").addEventListener("click", closeView);
  $("fbv-prev").addEventListener("click", () => { if (vw.i > 0) { vw.i--; showView(); } });
  $("fbv-next").addEventListener("click", () => { if (vw.i < vw.list.length - 1) { vw.i++; showView(); } });
  $("fbv-ok").addEventListener("click", () => markView(true));
  $("fbv-no").addEventListener("click", () => markView(false));
  $("fbv").addEventListener("click", (e) => { if (e.target === $("fbv")) closeView(); });
}

function renderSched() {
  const p = state.plan, cats = catsAll();
  const opts = (sel) => cats.map((c) => `<option value="${esc(c)}"${c === sel ? " selected" : ""}>${esc(c)}</option>`).join("");
  const set = (id, html) => { const el = $(id), v = el.value; el.innerHTML = html; el.value = v; };
  set("lib-cat", `<option value="">Sin categoría</option>${opts("")}`);
  set("q-cat", `<option value="">Todas</option>${opts("")}`);
  $("cat-chips").innerHTML = (p.cats || []).map((c, n) => `<span class="chip">${esc(c)}<button type="button" data-catdel="${n}" aria-label="Quitar">×</button></span>`).join("");
  $("slot-list").innerHTML = (p.slots || []).map((s, n) => `<div class="slot-wrap"><div class="slot-sum"><b>${slotLabel(s)}</b><span>${slotHours(s)}</span></div><div class="slot">${tsel(n, "from", s.from)}<button class="btn del small" data-sd="${n}" type="button" aria-label="Quitar">×</button>${tsel(n, "to", s.to)}<select class="cat" data-sc="${n}" aria-label="Categoría"><option value="*"${s.cat === "*" ? " selected" : ""}>Variado</option>${opts(s.cat)}</select></div></div>`).join("");
  renderSlotStrip();
  if (!schedVals) {
    schedVals = true; const q = p.quick, o = p.hOpt;
    $("q-which").value = q.which; $("q-order").value = q.order; $("q-cat").value = q.cat; $("q-max").value = q.max; $("q-skip").checked = !!q.skipBad; $("q-replace").checked = !!q.replace;
    $("h-order").value = o.order; $("h-skip").checked = !!o.skipBad; $("h-now").checked = o.fromNow !== false; $("q-time").checked = q.time !== false;
  }
  $("lib-cat").style.display = $("lib-kind").value === "programa" ? "" : "none";
}

// ---- Parrilla: lista con búsqueda y botón ＋ en cada programa (no se cierra al añadir) ----
function renderPick() {
  const el = $("pick-list"), q = ($("pick-q").value || "").trim().toLowerCase(), st = el.scrollTop;
  const progs = sortProgs(state.lib.filter((i) => i.kind === "programa" && (!q || (i.title || "").toLowerCase().includes(q))), "old");
  el.innerHTML = progs.length ? progs.map((i) => {
    const n = state.plan.order.filter((x) => x === i.id).length;
    return `<div class="pick-row"><span class="pick-t">${esc(i.title)}</span><span class="pick-d">${fmtDuration(i.duration)}${n ? " · ✓" : ""}${i.fbOk === false ? " · ✗" : ""}</span><button class="btn small" data-pick="${esc(i.id)}" type="button" aria-label="Añadir">＋</button></div>`;
  }).join("") : '<p class="hint">Sin resultados</p>';
  el.scrollTop = st;
}
function addToGrid(id) {
  if (!state.lib.some((x) => x.id === id)) return;
  if (state.plan.order.includes(id)) { toast("Ya está en la parrilla principal.", "error"); return; }   // cada programa va una sola vez; las repeticiones las arma el ciclo
  state.plan.order.push(id);
  savePlan().then(() => { renderAll(); toast("Añadido a la parrilla.", "ok"); }).catch(fail);
}

// ---- Añadir rápido ----
function quickAdd() {
  const q = { which: $("q-which").value, order: $("q-order").value, cat: $("q-cat").value, max: $("q-max").value, skipBad: $("q-skip").checked, replace: $("q-replace").checked, time: $("q-time").checked };
  state.plan.quick = q;
  if (q.time) { runSchedule({ order: q.order, skipBad: q.skipBad, fromNow: true }); return; }   // empieza por lo que toca a esta hora
  let list = state.lib.filter((i) => i.kind === "programa" && i.duration > 0);
  if (q.cat) list = list.filter((i) => i.cat === q.cat);
  if (q.skipBad) list = list.filter((i) => i.fbOk !== false);
  if (q.which === "new" && !q.replace) list = list.filter((i) => !state.plan.order.includes(i.id));
  list = sortProgs(list, q.order);
  const max = parseInt(q.max, 10); if (max > 0) list = list.slice(0, max);
  if (!list.length) { toast("No hay programas con ese criterio.", "error"); return; }
  state.plan.order = q.replace ? list.map((i) => i.id) : state.plan.order.concat(list.map((i) => i.id));
  savePlan().then(() => { renderAll(); toast(`Añadidos ${list.length} programas.`, "ok"); }).catch(fail);
}

// ---- Horarios: reparte los programas por categoría y franja horaria (sin IA, sin costo) ----
const nowMin = () => { const [hh, mm] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(serverNow())).split(":").map(Number); return (hh % 24) * 60 + mm; };
// S = minuto del día donde empieza la parrilla (hora actual o la primera franja). La franja que está en curso se parte: primero lo que le queda, al final lo que ya pasó.
const normSlots = (S0) => normalizeSlots(state.plan.slots, S0, toMin);
function generateSchedule() { runSchedule({ order: $("h-order").value, skipBad: $("h-skip").checked, fromNow: $("h-now").checked }); }
// Posición (en plan.order) del programa que está al aire, o -1 si no se sabe.
function airOrderIndex() {
  const c = state.channel, id = airProgramId(); if (!c?.items?.length || !id) return -1;
  const loc = studioLoc(c, serverNow()); if (!loc) return -1;
  let n = -1; for (let k = 0; k <= loc.index; k++) { const it = c.items[k]; if (it.type === "programa" && (!it.part || it.part === 1)) n++; }
  const ord = state.plan.order; if (ord[n] === id) return n;
  let best = -1; ord.forEach((x, j) => { if (x === id && (best < 0 || Math.abs(j - n) < Math.abs(best - n))) best = j; });
  return best;
}
// Un programa nuevo (o al que se le pone categoría) entra enseguida en la franja de su categoría, sin reiniciar la emisión:
// si esa franja está al aire sale justo después del programa actual; si viene más adelante, sale primero en ella; si ya pasó, en la próxima repetición.
async function autoPlace(it) {
  try {
    if (!it || it.kind !== "programa" || !it.cat || !(it.duration > 0) || it.fbOk === false) return false;
    const r = placeNewProgram(state.lib, state.plan, it, airOrderIndex());
    if (!r) return false;
    await savePlan(); renderAll();
    if (state.channel?.items?.length) await publish(true);
    toast(r.replaced ? `«${it.title}» sustituyó una repetición de «${r.replaced}» en el ciclo (${r.cat}). «${r.replaced}» sigue en la parrilla.` : `«${it.title}» entró a la parrilla en ${r.cat}.`, "ok");
    return true;
  } catch (err) { fail(err); return false; }
}
// Reglas: cada programa termina completo aunque se pase de su franja; solo el último bloque «Variado» del día se corta de golpe (ahí la hora se repite);
// si no alcanzan los programas, se repiten al azar en otro orden; un programa nuevo entra enseguida en la franja de su categoría.
function runSchedule(opt) {
  const p = state.plan, ns = normSlots(opt.fromNow ? nowMin() : null);
  if (!ns) { toast("Añade al menos una franja.", "error"); return; }
  p.hOpt = { order: opt.order, skipBad: opt.skipBad, fromNow: opt.fromNow };
  const r = buildSchedule({ library: state.lib, plan: p, ns, how: opt.order, skipBad: opt.skipBad, createdMs });
  if (!r.order.length) { toast("No hay programas para esas franjas.", "error"); return; }
  const { order, durs, rows, len } = r;
  p.order = order; p.fit = { order: [...order], durs: { ...durs } }; p.slotMap = r.slotMap; p.dayStart = ns.S; lastSched = { rows, len, S: ns.S };
  savePlan().then(async () => {
    renderAll(); renderSummary(); toast(`Parrilla desde las ${clockTxt(ns.S)}: ${order.length} programas.`, "ok");
    if (await askConfirm({ title: "¿Publicar a este horario?", text: `El primer programa sale a las ${clockTxt(ns.S)}.`, ok: "Publicar", cancel: "Solo guardar" })) await publishAligned(true);
  }).catch(fail);
}
function renderSummary() {
  const el = $("h-summary"); if (!lastSched) { el.innerHTML = ""; return; }
  const { rows, len, S } = lastSched, nm = (c) => (c === "*" ? "Variado" : c);
  el.innerHTML = rows.map((r) => {
    const lbl = `<b>${clockTxt(S + r.start)}–${clockTxt(S + r.end)}</b> · ${esc(nm(r.cat))}`;
    if (r.empty) return `<p class="warn">${lbl}: sin programas</p>`;
    const drift = Math.abs(r.startAt - r.start * 60) > 600;   // un programa que se pasó de su franja corre la siguiente
    return `<p class="${drift ? "warn" : ""}">${lbl}: ${r.n} programa${r.n === 1 ? "" : "s"} · real ${clockTxt(S + r.startAt / 60)}–${clockTxt(S + r.endAt / 60)}${r.cut ? " · el último se corta para dar paso al inicio del día" : ""}</p>`;
  }).join("") + `<p><b>Ciclo:</b> ${fmtDuration(len)} (día completo = 24:00:00)</p>`;
}
async function publishAligned(noAsk) {
  const S = state.plan.dayStart;
  if (!Number.isFinite(S)) { toast("Primero genera la parrilla.", "error"); return; }
  const [y, m, d] = new Date(serverNow()).toLocaleDateString("en-CA", { timeZone: TZ }).split("-").map(Number);
  let at = Date.UTC(y, m - 1, d, Math.floor(S / 60) + 4, S % 60);   // hora de República Dominicana = UTC−4
  if (at > serverNow()) at -= 86400000;
  await publish(false, true, { alignAt: at, label: clockTxt(S), noAsk: noAsk === true });
}

// ---- Verificador: ventana emergente para ver cada video y marcar si se ve o no ----
let vw = { list: [], i: 0 };
function embedOf(it) {
  const fb = facebookUrl(it.url), yt = youtubeId(it.url);
  if (fb) return `<iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(fb)}&show_text=false&width=640" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  if (yt) return `<iframe src="https://www.youtube.com/embed/${yt}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  return `<video src="${esc(it.url)}" controls playsinline></video>`;
}
function openView(id) {
  vw = { list: libShown.slice(), i: Math.max(0, libShown.findIndex((x) => x.id === id)) };
  $("fbv").classList.remove("hidden"); showView();
}
function showView() {
  const it = vw.list[vw.i]; if (!it) { closeView(); return; }
  $("fbv-title").textContent = `${vw.i + 1}/${vw.list.length} · ${it.title}`;
  $("fbv-box").innerHTML = embedOf(it);
  $("fbv-state").textContent = it.fbOk === true ? "✓ Marcado: se ve" : it.fbOk === false ? "✗ Marcado: no se ve" : "";
}
function closeView() { $("fbv").classList.add("hidden"); $("fbv-box").innerHTML = ""; }
async function markView(ok) {
  const it = vw.list[vw.i]; if (!it) return;
  try { await updateDoc(doc(db, "library", it.id), { fbOk: ok }); it.fbOk = ok; } catch (err) { fail(err); return; }
  renderLibrary(); renderPick();
  if (vw.i < vw.list.length - 1) { vw.i++; showView(); } else { closeView(); toast("Revisaste todos.", "ok"); }
}


/* ===== Franjas: etiqueta clara y barra de las 24 horas ===== */
const slotLen = (s) => ((toMin(s.to) - toMin(s.from) + 1440) % 1440) || 1440;
const slotLabel = (s) => `${clockTxt(toMin(s.from))} → ${clockTxt(toMin(s.to))}`;
const slotHours = (s) => { const m = slotLen(s), h = Math.floor(m / 60), r = m % 60; return `${h ? `${h} h` : ""}${h && r ? " " : ""}${r ? `${r} min` : ""}`; };
const CAT_COLORS = ["#2f7d5d", "#3b6fb6", "#9a5bb5", "#c27a2c", "#b8505a", "#4a9aa5", "#7d8a2f", "#8a6a4a"];
const catColor = (c) => (c === "*" ? "#6b7280" : CAT_COLORS[Math.max(0, catsAll().indexOf(c)) % CAT_COLORS.length]);
function renderSlotStrip() {
  const el = $("slot-strip"), warn = $("slot-warn"); if (!el) return;
  const sl = state.plan.slots || [], cover = new Array(1440).fill(0), parts = [];
  sl.forEach((s) => {
    const f = toMin(s.from), len = slotLen(s);
    for (let k = 0; k < len; k++) cover[(f + k) % 1440]++;
    const first = Math.min(len, 1440 - f); parts.push({ s, a: f, b: f + first });
    if (len > first) parts.push({ s, a: 0, b: len - first });
  });
  let html = parts.map(({ s, a, b }) => `<i class="${cover.slice(a, b).some((x) => x > 1) ? "ov" : ""}" style="left:${(a / 1440) * 100}%;width:${((b - a) / 1440) * 100}%;background:${catColor(s.cat)}" title="${esc(slotLabel(s))} · ${esc(s.cat === "*" ? "Variado" : s.cat)}">${esc(s.cat === "*" ? "Variado" : s.cat)}</i>`).join("");
  html += [0, 6, 12, 18, 24].map((h) => `<b style="left:${(h / 24) * 100}%">${clockTxt(h * 60 % 1440)}</b>`).join("");
  el.innerHTML = html;
  const gaps = cover.filter((x) => x === 0).length, ovl = cover.filter((x) => x > 1).length, fmt = (m) => `${Math.floor(m / 60) ? Math.floor(m / 60) + " h " : ""}${m % 60 ? (m % 60) + " min" : ""}`.trim();
  warn.textContent = [gaps ? `Faltan ${fmt(gaps)} sin franja.` : "", ovl ? `Hay ${fmt(ovl)} donde se cruzan dos franjas (borde rojo).` : ""].filter(Boolean).join(" ");
}

/* ===== Elegir un programa de la biblioteca (ventana con búsqueda y categoría) ===== */
function pickProgram(title, preferCat) {
  return new Promise((resolve) => {
    const dlg = $("dpick"), q = $("dpick-q"), cs = $("dpick-cat"), list = $("dpick-list");
    $("dpick-title").textContent = title; q.value = "";
    cs.innerHTML = `<option value="">Todas las categorías</option>${catsAll().map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}<option value="__none">Sin categoría</option>`;
    cs.value = preferCat && catsAll().includes(preferCat) ? preferCat : "";
    const done = (v) => { dlg.classList.add("hidden"); q.oninput = cs.onchange = list.onclick = dlg.onclick = $("dpick-cancel").onclick = null; resolve(v); };
    const draw = () => {
      const t = q.value.trim().toLowerCase(), c = cs.value;
      const progs = sortPrograms(state.lib.filter((i) => i.kind === "programa" && i.duration > 0 && (!t || (i.title || "").toLowerCase().includes(t)) && (!c || (c === "__none" ? !i.cat : i.cat === c))), "az");
      list.innerHTML = progs.length ? progs.map((i) => `<div class="pick-row"><span class="pick-t">${esc(i.title)}</span><span class="pick-d">${esc(i.cat || "—")} · ${fmtDuration(i.duration)}</span><button class="btn small" data-id="${esc(i.id)}" type="button">Elegir</button></div>`).join("") : '<p class="hint">Sin resultados</p>';
    };
    q.oninput = draw; cs.onchange = draw; draw();
    list.onclick = (e) => { const b = e.target.closest("[data-id]"); if (b) done(b.dataset.id); };
    $("dpick-cancel").onclick = () => done(null);
    dlg.onclick = (e) => { if (e.target === dlg) done(null); };
    dlg.classList.remove("hidden"); setTimeout(() => q.focus(), 50);
  });
}

/* ===== Editor de las 24 horas: todas las emisiones del ciclo (con repeticiones), para mover, cambiar, insertar y quitar ===== */
const dayUndo = [];
// Emisión n del ciclo → { start, end } en segundos desde el inicio del ciclo.
function dayTimes() {
  const p = state.plan, order = p.order, cyc = buildCycle(state.lib, p);
  const orderPos = []; order.forEach((id, n) => { const i = state.lib.find((x) => x.id === id); if (i && i.duration > 0) orderPos.push(n); });
  const startIdx = new Map(); let q = -1;
  cyc.forEach((it, k) => { if (it.type === "programa" && (!it.part || it.part === 1)) { q++; if (orderPos[q] != null) startIdx.set(orderPos[q], k); } });
  const cum = []; let a = 0; for (const it of cyc) { cum.push(a); a += it.duration; }
  const times = new Map();
  startIdx.forEach((k, n) => {
    let e = k; const it = cyc[k];
    if (it.parts > 1) for (let j = k + 1; j < cyc.length; j++) { const x = cyc[j]; if (x.type === "programa" && x.id === it.id && x.part > 1) { e = j; if (x.part >= it.parts) break; } else if (x.type === "programa") break; }
    times.set(n, { start: cum[k], end: cum[e] + cyc[e].duration });
  });
  return { times, total: a };
}
function renderDay() {
  const el = $("day-list"); if (!el) return;
  renderPinList();
  const pc = getPinned();
  if (pc) { renderDayPinned(el, pc); return; }
  const p = state.plan, order = p.order, S = Number.isFinite(p.dayStart) ? p.dayStart : null, { times, total } = dayTimes();
  const clock = (sec) => (S == null ? fmtDuration(sec) : clockTxt(S + sec / 60));
  const slotAt = (min) => (p.slots || []).findIndex((s) => ((min - toMin(s.from) + 1440) % 1440) < slotLen(s));
  const seen = new Set(); let lastSlot = -2, warned = false, html = "";
  order.forEach((id, n) => {
    const i = state.lib.find((x) => x.id === id), t = times.get(n); if (!i) return;
    const rep = seen.has(id); seen.add(id);
    let si = -1;
    if (t && S != null) si = slotAt(((S + t.start / 60) % 1440 + 1440) % 1440);
    if (t && t.start >= 86400 && !warned) { warned = true; html += `<div class="day-h warn"><span>Desde aquí el ciclo pasa de las 24 horas</span></div>`; lastSlot = -2; }
    if (S != null && si !== lastSlot) {
      lastSlot = si; const sl = p.slots[si];
      html += `<div class="day-h"><span>${sl ? `${esc(slotLabel(sl))} · ${esc(sl.cat === "*" ? "Variado" : sl.cat)}` : "Sin franja"}</span><span>${sl ? esc(slotHours(sl)) : ""}</span></div>`;
    }
    const sl = si >= 0 ? p.slots[si] : null, off = sl && sl.cat !== "*" && i.cat !== sl.cat;
    html += `<div class="day-row" draggable="true" data-n="${n}"><span class="day-grip" title="Arrastrar">⠿</span>
      <span class="day-t">${t ? `${esc(clock(t.start))}<small>→ ${esc(clock(t.end))}</small>` : "—"}</span>
      <span class="day-main"><b>${esc(i.title)}</b><span class="day-meta">${i.cat ? `<span class="tag">${esc(i.cat)}</span>` : ""}${rep ? '<span class="tag rep">Repetición</span>' : ""}${off ? '<span class="tag off">Fuera de su franja</span>' : ""}<span>${fmtDuration(i.duration)}</span></span></span>
      <span class="day-btns"><button class="btn secondary small" data-act="up" data-n="${n}" type="button" aria-label="Subir">↑</button><button class="btn secondary small" data-act="down" data-n="${n}" type="button" aria-label="Bajar">↓</button><button class="btn secondary small" data-act="swap" data-n="${n}" type="button" title="Cambiar por otro programa" aria-label="Cambiar">⇄</button><button class="btn secondary small" data-act="ins" data-n="${n}" type="button" title="Insertar uno debajo" aria-label="Insertar debajo">＋</button><button class="btn danger small" data-act="del" data-n="${n}" type="button" aria-label="Quitar">✕</button></span></div>`;
  });
  el.innerHTML = html || '<p class="hint">No hay emisiones. Usa «Añadir al final» o genera la parrilla en Horarios.</p>';
  const diff = total - 86400, dTxt = Math.abs(diff) < 60 ? "justo 24 h" : diff > 0 ? `${fmtDuration(diff)} más que un día` : `${fmtDuration(-diff)} menos que un día`;
  $("day-info").textContent = order.length ? `${order.length} emisiones · ciclo ${fmtDuration(total)} (${dTxt})${S != null ? ` · empieza a las ${clockTxt(S)}` : ""}` : "";
  $("day-undo").disabled = !dayUndo.length;
  markDayAir();
}
function markDayAir() {
  const el = $("day-list"); if (!el || $("tab-dia").classList.contains("hidden")) return;
  if (getPinned() && el.dataset.pinned) {
    const sec = (serverNow() - pinMidnight(serverNow())) / 1000, mine = el.dataset.today === "1";
    el.querySelectorAll(".day-row").forEach((r) => r.classList.toggle("air", mine && sec >= Number(r.dataset.s) && sec < Number(r.dataset.e)));
    return;
  }
  let idx = -1; try { idx = airOrderIndex(); } catch { /* sin emisión */ }
  el.querySelectorAll(".day-row").forEach((r) => r.classList.toggle("air", Number(r.dataset.n) === idx));
}
// Aplica un cambio a la lista de emisiones, lo guarda y deja el paso anterior para «Deshacer».
async function dayEdit(fn, msg) {
  const before = [...state.plan.order];
  if (fn(state.plan.order) === false) return;
  dayUndo.push(before); if (dayUndo.length > 40) dayUndo.shift();
  try { await savePlan(); renderAll(); if (msg) toast(msg, "ok"); } catch (err) { fail(err); }
}
function initDay() {
  const list = $("day-list");
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    if (b.dataset.act === "noop") return;
    const n = Number(b.dataset.n), act = b.dataset.act, id = state.plan.order[n], it = state.lib.find((x) => x.id === id);
    if (act === "up" || act === "down") { const m = n + (act === "up" ? -1 : 1); await dayEdit((o) => { if (m < 0 || m >= o.length) return false; [o[n], o[m]] = [o[m], o[n]]; }); }
    else if (act === "del") {
      await dayEdit((o) => { o.splice(n, 1); }, state.plan.order.includes(id) ? `Quité esa emisión de «${it?.title}». Sigue en la parrilla principal.` : `Quité «${it?.title}»: ya no queda ninguna emisión suya, salió de la parrilla principal.`);
    } else if (act === "swap") { const nid = await pickProgram("Cambiar por otro programa", it?.cat); if (nid) await dayEdit((o) => { o[n] = nid; }); }
    else if (act === "ins") { const nid = await pickProgram("Insertar debajo", it?.cat); if (nid) await dayEdit((o) => { o.splice(n + 1, 0, nid); }); }
  });
  // Arrastrar y soltar (en pantallas táctiles usa ↑ ↓)
  let from = -1;
  list.addEventListener("dragstart", (e) => { const r = e.target.closest(".day-row"); if (!r) return; from = Number(r.dataset.n); r.classList.add("drag"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(from)); } catch { /* */ } });
  list.addEventListener("dragend", () => { from = -1; list.querySelectorAll(".drag,.over").forEach((x) => x.classList.remove("drag", "over")); });
  list.addEventListener("dragover", (e) => { const r = e.target.closest(".day-row"); if (!r || from < 0 || r.dataset.n == null) return; e.preventDefault(); list.querySelectorAll(".over").forEach((x) => x.classList.remove("over")); r.classList.add("over"); });
  list.addEventListener("drop", async (e) => {
    const r = e.target.closest(".day-row"); if (!r || from < 0 || r.dataset.n == null) return; e.preventDefault();
    const to = Number(r.dataset.n), f = from; from = -1;
    if (to !== f) await dayEdit((o) => { const [x] = o.splice(f, 1); o.splice(to, 0, x); });
  });
  $("day-add").addEventListener("click", async () => { const nid = await pickProgram("Añadir al final del ciclo"); if (nid) await dayEdit((o) => { o.push(nid); }, "Añadido al final."); });
  $("day-undo").addEventListener("click", async () => {
    const prev = dayUndo.pop(); if (!prev) return;
    state.plan.order = prev;
    try { await savePlan(); renderAll(); toast("Deshecho.", "ok"); } catch (err) { fail(err); }
  });
  $("day-pub").addEventListener("click", () => publish(false));
  initPins();
  setInterval(markDayAir, 5000);
  // Modo ampliado: el panel de control ocupa toda la pantalla y tapa la vista previa
  const sec = document.querySelector('section[aria-label="Control"]');
  const setBig = (on) => {
    sec.classList.toggle("ctl-big", on); document.body.classList.toggle("ctl-big-on", on);
    $("ctl-expand").textContent = on ? "✕ Reducir" : "⤢ Ampliar"; $("ctl-expand").setAttribute("aria-pressed", on ? "true" : "false");
    try { localStorage.setItem("fogon.ctlBig", on ? "1" : "0"); } catch { /* */ }
    if (on) sec.scrollTop = 0;
  };
  $("ctl-expand").addEventListener("click", () => setBig(!sec.classList.contains("ctl-big")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sec.classList.contains("ctl-big") && $("dpick").classList.contains("hidden")) setBig(false); });
  try { if (localStorage.getItem("fogon.ctlBig") === "1") setBig(true); } catch { /* */ }
}
