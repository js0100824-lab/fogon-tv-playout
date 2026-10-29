import { auth, db, storage, isConfigured } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, deleteField, getDocs, collection, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { parseDuration, fmtDuration, youtubeId, facebookUrl, parseLiveLink, buildCycle, cycleLength, locate, planWithDefaults, compactChannel, expandChannel, describeCuts, itemLabel, intervalSeconds, seamlessPublish, settleChannel } from "./engine.js?v=31";
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
const state = { lib: [], plan: planWithDefaults(), brand: { name: "", showName: false, accent: "#0E6B73", logo: "", ticker: "", logoPos: "top-right", logoSize: 14, logoOpacity: 0.9 } };
let inited = false;

function esc(t) { return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(text, kind = "ok") {
  const t = $("toast"); t.textContent = text; t.className = `msg ${kind}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 5000);
}
const fail = (err) => toast(`Error: ${err.code || err.message}`, "error");

async function initPanel() {
  if (inited) return; inited = true;
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
  $("lib-form").addEventListener("submit", addItem);
  $("lib-cancel").addEventListener("click", resetEdit);
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
  $("order-add-btn").addEventListener("click", () => {
    const id = $("order-add").value; if (!id) return;
    state.plan.order.push(id); savePlan().then(renderAll).catch(fail);
  });
  $("publish-btn").addEventListener("click", publish);
  $("publish-btn2").addEventListener("click", publish);
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
  renderLibrary(); renderAds(); renderOrder(); renderCycle(); renderBrand(); renderNow();
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
  $("lib-cancel").hidden = true; document.querySelector(".link-add summary").textContent = "Añadir por enlace (YouTube, Facebook o .mp4)";
}
function startEdit(id) {
  const it = state.lib.find((x) => x.id === id); if (!it) return;
  const pf = it.playFor > 0 ? Math.min(it.playFor, it.duration) : 0;
  editing = { id, url: it.url, dur: it.duration, play: pf };
  $("lib-title").value = it.title; $("lib-url").value = it.url; $("lib-kind").value = it.kind;
  $("lib-dur-m").value = Math.floor(it.duration / 60); $("lib-dur-s").value = Math.round(it.duration % 60);
  $("lib-play-m").value = pf ? Math.floor(pf / 60) : ""; $("lib-play-s").value = pf ? Math.round(pf % 60) : "";
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
  const ms = (a, b) => Math.max(0, Math.floor(Number($(a).value) || 0)) * 60 + Math.max(0, Math.floor(Number($(b).value) || 0));
  let duration = ms("lib-dur-m", "lib-dur-s"), playFor = ms("lib-play-m", "lib-play-s");
  // Al editar: si cambiaste el enlace y no tocaste la duración, se vuelve a detectar la del video nuevo.
  if (editing && url !== editing.url && duration === editing.dur) duration = 0;
  if (fb && !(duration > 0)) { toast("Facebook no permite detectar la duración. Escribe los minutos y segundos del video en los campos de Duración.", "error"); return; }
  if (!(duration > 0)) { toast("Detectando la duración…", "ok"); duration = yt ? await ytDuration(yt) : await detectDuration(url); }
  if (!(duration > 0)) {
    toast(yt ? "No pude detectar la duración de ese video de YouTube (puede tener la inserción bloqueada). Escribe los minutos y segundos del video en los campos de Duración."
      : "No se pudo abrir ese video. Revisa: 1) que el archivo ya esté en la carpeta media de GitHub y el flujo de Actions esté en verde; 2) que el nombre esté bien escrito; 3) que sea .mp4 H.264. Si todo está bien, escribe la duración a mano.", "error");
    return;
  }
  try {
    const kind = $("lib-kind").value, extra = kind === "comercial" && playFor > 0 ? { playFor: Math.min(playFor, duration) } : {};
    if (editing) {
      await updateItem(editing.id, { title: $("lib-title").value.trim(), kind, url, duration, playFor: extra.playFor || 0 });
      resetEdit(); toast("Cambios guardados. Pulsa “Publicar cambios” para que la emisión use el enlace nuevo.", "ok");
    } else { await saveItem({ title: $("lib-title").value.trim(), kind, url, duration, ...extra }); $("lib-form").reset(); toast("Contenido guardado.", "ok"); }
  } catch (err) { fail(err); }
}
async function saveItem(d) {
  const data = { ...d, active: true, createdAt: serverTimestamp() };
  const r = await addDoc(collection(db, "library"), data);
  state.lib.push({ id: r.id, ...data });
  state.lib.sort((a, b) => a.title.localeCompare(b.title));
  renderAll();
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
function renderLibrary() {
  const el = $("lib-list");
  if (!state.lib.length) { el.innerHTML = '<p class="hint">Aún no hay contenidos.</p>'; return; }
  el.innerHTML = state.lib.map((i) => {
    const n = state.plan.order.filter((x) => x === i.id).length;
    const onGrid = i.kind === "programa" && n > 0 ? `<span class="tag ok">✓ En parrilla${n > 1 ? ` ×${n}` : ""}</span>` : "";
    const dur = fmtDuration(i.duration) + (i.kind === "comercial" && i.playFor > 0 ? ` · al aire ${fmtDuration(Math.min(i.playFor, i.duration))}` : "");
    return `<div class="item lib-item"><div class="lib-main"><b>${esc(i.title)}</b></div>
    <div class="lib-meta"><span class="tag">${esc(i.kind)}</span>${onGrid}<span class="lib-dur">${dur}</span><span class="lib-actions"><button class="btn small" data-edit="${esc(i.id)}" type="button" title="Cambiar título, enlace o duración">Editar</button><button class="btn del small" data-del="${esc(i.id)}" type="button" title="Eliminar de la biblioteca">Eliminar</button></span></div>
    <details class="lib-link"><summary>Ver enlace</summary><span>${esc(i.url)}</span><button class="btn small" data-copy="${esc(i.url)}" type="button">Copiar enlace</button></details></div>`;
  }).join("");
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => startEdit(b.dataset.edit)));
  el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copiado ✓"; setTimeout(() => { b.textContent = "Copiar enlace"; }, 1500); } catch { toast("No se pudo copiar. Mantén pulsado el enlace para copiarlo.", "error"); } }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const it = state.lib.find((x) => x.id === b.dataset.del);
    if (!confirm(`¿Eliminar “${it.title}”?`)) return;
    try {
      await deleteDoc(doc(db, "library", it.id));
      if (it.provider === "cloudinary") toast("Se quitó de la biblioteca. El archivo sigue en tu Cloudinary: bórralo desde su panel si quieres liberar espacio.", "ok");
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
  const per = plan.breakCount * plan.breakRepeat;
  let html = "";
  if (!ads.length) html += '<p class="msg error">No hay comerciales activos: no se hará ningún corte. Marca al menos uno abajo.</p>';
  if (plan.mode === "time" || plan.mode === "continuous") {
    if (!(intervalSeconds(plan) > 0)) html += '<p class="msg error">Escribe cada cuánto tiempo va el corte.</p>';
    const rows = describeCuts(state.lib, plan);
    html += rows.length ? rows.map((r) => `<p><b>${esc(r.title)}</b> (${fmtDuration(r.duration)}): ${[r.lead ? "al empezar" : "", r.cuts.length ? "cortes en " + r.cuts.map(fmtDuration).join(", ") : "", r.end ? "al terminar" : ""].filter(Boolean).join(" y ") || "sin cortes (sigue al próximo programa)"}.</p>`).join("")
      : '<p class="hint">Añade programas a la parrilla para ver dónde caen los cortes.</p>';
  } else html += `<p>Habrá un corte cada ${plan.everyN} programas.</p>`;
  html += `<p class="hint">Cada corte: ${plan.breakCount} anuncio(s) en orden${plan.breakRepeat > 1 ? `, la tanda repetida ${plan.breakRepeat} veces` : ""} = ${per} anuncios por corte.</p>`;
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
      <div class="row2 playfor">Al aire: <input type="number" min="0" data-pm="${esc(i.id)}" value="${i.playFor > 0 ? Math.floor(Math.min(i.playFor, i.duration) / 60) : ""}" placeholder="min" aria-label="Minutos al aire"><input type="number" min="0" max="59" data-ps="${esc(i.id)}" value="${i.playFor > 0 ? Math.min(i.playFor, i.duration) % 60 : ""}" placeholder="seg" aria-label="Segundos al aire"></div></span><span title="Duración total del video">${fmtDuration(i.duration)}</span>
    <button class="btn secondary small" data-admv="${n}:-1" type="button" aria-label="Subir">↑</button><button class="btn secondary small" data-admv="${n}:1" type="button" aria-label="Bajar">↓</button></div>`).join("") : '<p class="hint">Agrega comerciales en la Biblioteca.</p>';
  $("ads-list").querySelectorAll("[data-ad]").forEach((c) => c.addEventListener("change", async () => {
    const it = state.lib.find((x) => x.id === c.dataset.ad); it.active = c.checked;
    try { await updateDoc(doc(db, "library", it.id), { active: c.checked }); renderCycle(); previewPlan(); } catch (err) { fail(err); }
  }));
  $("ads-list").querySelectorAll("[data-pm],[data-ps]").forEach((inp) => inp.addEventListener("change", async () => {
    const id = inp.dataset.pm || inp.dataset.ps, it = state.lib.find((x) => x.id === id); if (!it) return;
    const m = Math.max(0, Math.floor(Number($(`#ads-list [data-pm="${id}"]`).value) || 0)), sc = Math.max(0, Math.floor(Number($(`#ads-list [data-ps="${id}"]`).value) || 0));
    let playFor = m * 60 + sc; if (playFor > it.duration) { playFor = it.duration; toast(`El comercial dura ${fmtDuration(it.duration)}; no puede pasar de eso.`, "error"); }
    try { await updateDoc(doc(db, "library", it.id), { playFor }); it.playFor = playFor; renderAds(); renderCycle(); toast(playFor > 0 ? `“${it.title}” durará ${fmtDuration(playFor)} al aire. Pulsa «Publicar cambios» para aplicarlo.` : "Se emitirá completo. Pulsa «Publicar cambios» para aplicarlo.", "ok"); } catch (err) { fail(err); }
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
  try { await savePlan(); renderCycle(); renderAds(); toast("Control comercial guardado. Pulsa «Publicar cambios» para aplicarlo.", "ok"); } catch (err) { fail(err); }
}
const savePlan = () => setDoc(doc(db, "config", "plan"), state.plan);

/* Programación */
function renderOrder() {
  const progs = state.lib.filter((i) => i.kind === "programa");
  const inCount = (id) => state.plan.order.filter((x) => x === id).length;
  const fresh = progs.filter((i) => !inCount(i.id)), used = progs.filter((i) => inCount(i.id));
  const opt = (i, mark) => `<option value="${esc(i.id)}">${mark ? `✓ ${esc(i.title)} (${fmtDuration(i.duration)}) · ya está${inCount(i.id) > 1 ? ` ×${inCount(i.id)}` : ""}` : `${esc(i.title)} (${fmtDuration(i.duration)})`}</option>`;
  $("order-add").innerHTML = (fresh.length ? `<optgroup label="Aún NO están en la parrilla (${fresh.length})">${fresh.map((i) => opt(i, false)).join("")}</optgroup>` : "")
    + (used.length ? `<optgroup label="YA están en la parrilla (${used.length}) · si los añades se repiten">${used.map((i) => opt(i, true)).join("")}</optgroup>` : "");
  if ($("order-hint")) $("order-hint").textContent = !progs.length ? "" : fresh.length ? `Faltan por añadir ${fresh.length} de ${progs.length} programas.` : "Todos los programas ya están en la parrilla.";
  const el = $("order-list");
  if (!state.plan.order.length) { el.innerHTML = '<p class="hint">Aún no hay programas en la parrilla.</p>'; return; }
  el.innerHTML = state.plan.order.map((id, n) => {
    const i = state.lib.find((x) => x.id === id);
    return `<div class="item"><span>${n + 1}.</span><span class="grow"><b>${esc(i.title)}</b></span><span>${fmtDuration(i.duration)}</span>
      <button class="btn secondary small" data-mv="${n}:-1" type="button" aria-label="Subir">↑</button>
      <button class="btn secondary small" data-mv="${n}:1" type="button" aria-label="Bajar">↓</button>
      <button class="btn secondary small" data-rm="${n}" type="button">Quitar</button></div>`;
  }).join("");
  el.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", () => {
    const [n, d] = b.dataset.mv.split(":").map(Number), o = state.plan.order, m = n + d;
    if (m < 0 || m >= o.length) return;
    [o[n], o[m]] = [o[m], o[n]]; savePlan().then(renderAll).catch(fail);
  }));
  el.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    state.plan.order.splice(Number(b.dataset.rm), 1); savePlan().then(renderAll).catch(fail);
  }));
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
  return r.next ? { starts: st.map((x) => r.nextAt + x), pending: true } : { starts: st.map((x, k) => (k >= loc.index ? r.epoch + x : r.epoch + L + x)), pending: false };
}
function renderCycle() {
  const cyc = buildCycle(state.lib, state.plan);
  const ads = cyc.filter((i) => i.type === "comercial").length, cuts = new Set(cyc.filter((i) => i.type === "comercial").map((i) => i.breakNo)).size;
  const clk = cycleClock(cyc);
  $("cycle-total").textContent = cyc.length ? `${cuts} cortes · ${ads} anuncios · duración del ciclo ${fmtDuration(cycleLength(cyc))}. Al terminar, vuelve a empezar.${clk ? (clk.pending ? " Horas de la próxima repetición (los cambios de arriba entran ahí)." : " Horas de la próxima emisión de cada tramo.") : ""}` : "Añade programas con duración para generar el ciclo.";
  let t = 0;
  $("cycle-list").innerHTML = cyc.slice(0, 400).map((i, k) => { const li = `<li class="${i.type === "comercial" ? "ad" : ""}">${clk ? hms(clk.starts[k]) : fmtDuration(t)} · ${esc(itemLabel(i))} · ${fmtDuration(i.duration)}${i.type === "comercial" ? ` (corte ${i.breakNo})` : (i.parts > 1 ? ` (del minuto ${fmtDuration(i.startAt)} al ${fmtDuration(i.startAt + i.duration)})` : "")}</li>`; t += i.duration; return li; }).join("")
    + (cyc.length > 400 ? `<li class="hint">… y ${cyc.length - 400} más</li>` : "");
  $("st-cycle").textContent = state.channel?.items?.length ? `${state.channel.items.length} elementos` : "Sin publicar";
}

/* Directo en vivo (YouTube / Facebook) */
function renderLiveStream() {
  const on = !!(liveCfg?.on && liveCfg.ref);
  if (liveCfg?.url) $("lv-url").value = liveCfg.url;
  $("lv-state").textContent = on ? `EN VIVO ahora (${liveCfg.kind === "facebook" ? "Facebook" : "YouTube"}). El público ve el directo, no la parrilla.` : "Sin directo activo: se emite la parrilla.";
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
    toast(on ? "Directo activado. El reproductor lo muestra ahora." : "Directo quitado. Vuelve la parrilla.", "ok");
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
      settleChannel(c, Infinity);   // emisión cortada con una versión anterior: no hay punto guardado, empieza de cero
      upd = { live: true, epoch: now, pausedAt: null, ...compactChannel(c.items), nextSeq: null, nextAt: null };
    }
    await updateDoc(doc(db, "public", "channel"), upd);
    Object.assign(c, { live, ...(upd.epoch != null ? { epoch: upd.epoch } : {}), pausedAt: upd.pausedAt ?? null });
    if (upd.nextAt === null) { delete c.nextSeq; delete c.nextAt; } else if (upd.nextAt != null) c.nextAt = upd.nextAt;
    renderLive(); renderNow();
    toast(live ? "Emisión reanudada: continúa desde donde se cortó." : "Emisión cortada. El público ve el aviso de pausa.", "ok");
  } catch (err) { fail(err); }
}

/* Publicar */
async function publish(auto) {
  const items = buildCycle(state.lib, state.plan);
  if (!items.length && !auto && !confirm("La parrilla está vacía. ¿Publicar sin programación? El público verá “Sin programación”.")) return;
  try {
    await savePlan();
    const now = serverNow(), live = state.channel?.live !== false;
    // Emisión en marcha: NO se reinicia. Lo que está al aire sigue; lo nuevo por debajo entra en este ciclo y lo nuevo por encima, en la próxima repetición.
    let plan = null; const old = state.channel;
    if (live && old?.items?.length && items.length) {
      settleChannel(old, now);
      const loc = studioLoc(old, now);
      if (loc) {
        // Si se borró un video de la biblioteca, se saca de lo que falta por emitir; si justo ese estaba al aire, se empieza de cero.
        const gone = (it) => !state.lib.some((x) => x.id === it.id);
        if (!gone(old.items[loc.index])) {
          const base = old.items.filter((it, k) => k === loc.index || !gone(it));
          const idx = old.items.slice(0, loc.index).filter((it) => !gone(it)).length;
          plan = seamlessPublish(base, idx, loc.offset, items, now);
        }
      }
    }
    if (!plan) plan = { items, epoch: Math.round(now), next: null, nextAt: 0 };   // primera publicación, directo, pausa o borrado: empieza desde el principio
    const cur = compactChannel(plan.items), nxt = plan.next ? compactChannel(plan.next) : null;
    const channel = { epoch: plan.epoch, live, media: nxt ? { ...nxt.media, ...cur.media } : cur.media, seq: cur.seq, nextSeq: nxt ? nxt.seq : null, nextAt: nxt ? plan.nextAt : null, updatedAt: serverTimestamp() };
    await setDoc(doc(db, "public", "channel"), channel);
    state.channel = { epoch: plan.epoch, items: plan.items, live, media: channel.media, seq: channel.seq, ...(nxt ? { nextSeq: nxt.seq, nextAt: plan.nextAt } : {}) };
    renderCycle(); renderNow();
    toast(plan.next ? "Publicado. La emisión sigue sin reiniciarse: lo que añadiste arriba entra en la próxima repetición." : "Emisión publicada. El reproductor se actualiza solo.", "ok");
  } catch (err) { fail(err); }
}
let tlKey = "";
const TZ = "America/Santo_Domingo";   // hora de República Dominicana
const HMS = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
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
  const total = cycleLength(items), key = `${c.epoch}:${n}:${total}`;
  if (key !== tlKey) {
    tlKey = key;
    $("timeline").innerHTML = items.map((i) => `<i class="${i.type === "comercial" ? "ad" : ""}" style="flex:${i.duration}" title="${esc(i.title)}"></i>`).join("") + "<u></u>";
  }
  let before = 0; for (let k = 0; k < loc.index; k++) before += items[k].duration;
  const head = $("timeline").querySelector("u"); if (head) head.style.left = `${((before + loc.offset) / total) * 100}%`;

  // Tabla de emisión con horas reales
  let t = now - loc.offset * 1000, rows = "";
  for (let k = 0; k < Math.min(n * 2, 14); k++) {
    const it = items[(loc.index + k) % n];
    rows += `<tr class="${k === 0 ? "cur" : it.type === "comercial" ? "ad" : "prog"}"><td>${hms(t)}</td><td>${esc(itemLabel(it))}</td><td>${it.type}</td><td>${fmtDuration(it.duration)}</td></tr>`;
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
    $("b-logo-file").value = ""; renderBrand(); toast("Logo cargado. Pulsa Guardar y publicar.", "ok");
  };
  img.onerror = () => toast("No se pudo leer esa imagen.", "error");
  img.src = url;
}
function renderBrand() {
  $("b-logo-pos").value = state.brand.logoPos || "top-right"; $("b-logo-size").value = state.brand.logoSize || 14; $("b-logo-op").value = Math.round((state.brand.logoOpacity ?? 0.9) * 100);
  $("b-accent").value = state.brand.accent || "#0E6B73";
  $("b-logo-prev").src = state.brand.logo || ""; $("b-logo-prev").classList.toggle("hidden", !state.brand.logo);
  $("b-logo-rm").classList.toggle("hidden", !state.brand.logo); $("b-ticker").value = state.brand.ticker || "";
}
async function saveBrand(keep) {
  state.brand = { name: "", showName: false, accent: $("b-accent").value, logo: state.brand.logo || "", ticker: $("b-ticker").value.trim(), logoPos: $("b-logo-pos").value, logoSize: Number($("b-logo-size").value), logoOpacity: Number($("b-logo-op").value) / 100 };
  try { await setDoc(doc(db, "public", "brand"), state.brand); toast("Personalización publicada.", "ok"); } catch (err) { fail(err); }
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
      list.map((x) => `<tr><td>${esc(x.title)}</td><td>${esc(x.kind)}</td><td>${x.n}</td></tr>`).join("")}</tbody></table>` : '<p class="hint">Aún no hay contenidos en la biblioteca.</p>';
  } catch (err) { fail(err); }
}
