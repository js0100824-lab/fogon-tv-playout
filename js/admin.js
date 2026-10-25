import { auth, db, storage, isConfigured } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, deleteDoc, updateDoc, getDocs, collection, query, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { parseDuration, fmtDuration, youtubeId, buildCycle, cycleLength, locate } from "./engine.js";

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
const state = { lib: [], plan: { order: [], everyN: 2, breakCount: 2 }, brand: { name: "Fogón TV", accent: "#0E6B73", logo: "", ticker: "" } };
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
  $("monitor").src = new URL("../player/?embed=1", location.href).href;
  document.querySelectorAll(".drop").forEach((drop) => {
    const kind = drop.dataset.kind, input = drop.querySelector("input");
    input.addEventListener("change", () => { uploadFiles([...input.files], kind); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("video/")), kind));
  });
  $("live-btn").addEventListener("click", toggleLive);
  $("b-logo-file").addEventListener("change", onLogoFile);
  $("b-logo-rm").addEventListener("click", () => { state.brand.logo = ""; renderBrand(); saveBrand(true); });
  $("plan-save-com").addEventListener("click", savePlanFromCommercial);
  $("order-add-btn").addEventListener("click", () => {
    const id = $("order-add").value; if (!id) return;
    state.plan.order.push(id); savePlan().then(renderAll).catch(fail);
  });
  $("publish-btn").addEventListener("click", publish);
  $("publish-btn2").addEventListener("click", publish);
  $("brand-form").addEventListener("submit", async (e) => { e.preventDefault(); await saveBrand(); });
  $("stats-refresh").addEventListener("click", loadStats);
  $("player-link").href = new URL("../player/", location.href).href;
  try {
    const [libSnap, planSnap, brandSnap, chSnap] = await Promise.all([
      getDocs(collection(db, "library")), getDoc(doc(db, "config", "plan")),
      getDoc(doc(db, "public", "brand")), getDoc(doc(db, "public", "channel"))
    ]);
    state.lib = libSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    if (planSnap.exists()) state.plan = { ...state.plan, ...planSnap.data() };
    if (brandSnap.exists()) state.brand = { ...state.brand, ...brandSnap.data() };
    state.channel = chSnap.exists() ? chSnap.data() : null;
  } catch (err) { fail(err); }
  renderAll();
  setInterval(renderNow, 1000);
}

function openTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${name}`));
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "estadisticas") loadStats();
}

function renderAll() {
  state.plan.order = state.plan.order.filter((id) => state.lib.some((i) => i.id === id));
  renderLibrary(); renderAds(); renderOrder(); renderCycle(); renderBrand(); renderNow();
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
async function addItem(e) {
  e.preventDefault();
  let url = $("lib-url").value.trim();
  // Si solo escribes el nombre del archivo (video1.mp4), se busca en la carpeta media del sitio.
  if (!/^https?:\/\//i.test(url)) url = new URL(`../media/${encodeURIComponent(url.replace(/^\/?(media\/)?/, ""))}`, location.href).href;
  const yt = youtubeId(url);
  let duration = parseDuration($("lib-dur").value);
  if (!(duration > 0) && !yt) duration = await detectDuration(url);
  if (!(duration > 0)) {
    toast(yt ? "Para YouTube escribe la duración (por ejemplo 3:25)."
      : "No se pudo abrir ese video. Revisa: 1) que el archivo ya esté en la carpeta media de GitHub y el flujo de Actions esté en verde; 2) que el nombre esté bien escrito; 3) que sea .mp4 H.264. Si todo está bien, escribe la duración a mano.", "error");
    return;
  }
  try {
    await saveItem({ title: $("lib-title").value.trim(), kind: $("lib-kind").value, url, duration });
    $("lib-form").reset(); toast("Contenido guardado.", "ok");
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
      const local = URL.createObjectURL(f);
      const duration = await detectDuration(local); URL.revokeObjectURL(local);
      if (!(duration > 0)) throw new Error("No se pudo leer la duración del video (¿formato no compatible? usa .mp4).");
      const path = `media/${Date.now()}-${f.name.replace(/[^\w.-]+/g, "_")}`;
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
  el.innerHTML = state.lib.map((i) => `<div class="item"><div class="grow"><b>${esc(i.title)}</b><small>${esc(i.url)}</small></div>
    <span class="tag">${esc(i.kind)}</span><span>${fmtDuration(i.duration)}</span>
    ${i.kind === "programa" ? `<button class="btn secondary small" data-add="${esc(i.id)}" type="button" title="Añadir a la parrilla">+</button>` : ""}
    <button class="btn del small" data-del="${esc(i.id)}" type="button" title="Eliminar de la biblioteca">🗑 Eliminar</button></div>`).join("");
  el.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
    state.plan.order.push(b.dataset.add); savePlan().then(renderAll).catch(fail); toast("Añadido a la parrilla.", "ok");
  }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const it = state.lib.find((x) => x.id === b.dataset.del);
    if (!confirm(`¿Eliminar “${it.title}”?`)) return;
    try {
      await deleteDoc(doc(db, "library", it.id));
      if (it.path) { try { await deleteObject(sRef(storage, it.path)); } catch {} }
      state.lib = state.lib.filter((x) => x.id !== it.id);
      await savePlan(); renderAll();
      if (state.channel?.items?.some((x) => x.id === it.id)) { await publish(true); }
    } catch (err) { fail(err); }
  }));
}

/* Control comercial */
function renderAds() {
  $("plan-every").value = state.plan.everyN; $("plan-count").value = state.plan.breakCount;
  const ads = state.lib.filter((i) => i.kind === "comercial");
  $("ads-list").innerHTML = ads.length ? ads.map((i) => `<label class="item"><input type="checkbox" data-ad="${esc(i.id)}" ${i.active !== false ? "checked" : ""}>
    <span class="grow"><b>${esc(i.title)}</b></span><span>${fmtDuration(i.duration)}</span></label>`).join("") : '<p class="hint">Agrega comerciales en la Biblioteca.</p>';
  $("ads-list").querySelectorAll("[data-ad]").forEach((c) => c.addEventListener("change", async () => {
    const it = state.lib.find((x) => x.id === c.dataset.ad); it.active = c.checked;
    try { await updateDoc(doc(db, "library", it.id), { active: c.checked }); renderCycle(); } catch (err) { fail(err); }
  }));
}
async function savePlanFromCommercial() {
  state.plan.everyN = Math.max(0, parseInt($("plan-every").value, 10) || 0);
  state.plan.breakCount = Math.max(0, parseInt($("plan-count").value, 10) || 0);
  try { await savePlan(); renderCycle(); toast("Control comercial guardado. Pulsa Publicar para aplicarlo.", "ok"); } catch (err) { fail(err); }
}
const savePlan = () => setDoc(doc(db, "config", "plan"), state.plan);

/* Programación */
function renderOrder() {
  const progs = state.lib.filter((i) => i.kind === "programa");
  $("order-add").innerHTML = progs.map((i) => `<option value="${esc(i.id)}">${esc(i.title)} (${fmtDuration(i.duration)})</option>`).join("");
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
function renderCycle() {
  const cyc = buildCycle(state.lib, state.plan);
  $("cycle-total").textContent = cyc.length ? `${cyc.length} elementos · duración del ciclo ${fmtDuration(cycleLength(cyc))}. Al terminar, vuelve a empezar.` : "Añade programas con duración para generar el ciclo.";
  $("cycle-list").innerHTML = cyc.map((i) => `<li class="${i.type === "comercial" ? "ad" : ""}">${esc(i.title)} · ${fmtDuration(i.duration)}${i.type === "comercial" ? " (comercial)" : ""}</li>`).join("");
  $("st-cycle").textContent = state.channel?.items?.length ? `${state.channel.items.length} elementos` : "Sin publicar";
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
  const live = state.channel.live === false;
  if (!live && !confirm("¿Cortar la emisión? El público verá un aviso de pausa.")) return;
  try {
    await updateDoc(doc(db, "public", "channel"), { live });
    state.channel.live = live; renderLive(); renderNow();
    toast(live ? "Emisión reanudada." : "Emisión cortada. El público ve el aviso de pausa.", "ok");
  } catch (err) { fail(err); }
}

/* Publicar */
async function publish(auto) {
  const items = buildCycle(state.lib, state.plan);
  if (!items.length && !auto && !confirm("La parrilla está vacía. ¿Publicar sin programación? El público verá “Sin programación”.")) return;
  const epoch = state.channel?.epoch || Date.now();
  try {
    await savePlan();
    const live = state.channel?.live !== false;
    const channel = { epoch, items, live, updatedAt: serverTimestamp() };
    await setDoc(doc(db, "public", "channel"), channel);
    state.channel = { epoch, items, live };
    renderCycle(); renderNow();
    toast("Emisión publicada. El reproductor se actualiza solo.", "ok");
  } catch (err) { fail(err); }
}
let tlKey = "";
const hms = (ms) => new Date(ms).toLocaleTimeString("es", { hour12: false });
function renderNow() {
  const now = Date.now();
  $("clock").textContent = hms(now);
  const c = state.channel;
  const paused = c?.live === false;
  const loc = c?.items?.length ? locate(c.items, c.epoch, now) : null;
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
  $("now-title").textContent = `${loc.item.type === "comercial" ? "[Comercial] " : ""}${loc.item.title}`;
  $("next-title").textContent = next.title;
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
    rows += `<tr class="${k === 0 ? "cur" : it.type === "comercial" ? "ad" : "prog"}"><td>${hms(t)}</td><td>${esc(it.title)}</td><td>${it.type}</td><td>${fmtDuration(it.duration)}</td></tr>`;
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
  $("b-name").value = state.brand.name || ""; $("b-accent").value = state.brand.accent || "#0E6B73";
  $("b-logo-prev").src = state.brand.logo || ""; $("b-logo-prev").classList.toggle("hidden", !state.brand.logo);
  $("b-logo-rm").classList.toggle("hidden", !state.brand.logo); $("b-ticker").value = state.brand.ticker || "";
}
async function saveBrand(keep) {
  state.brand = { name: $("b-name").value.trim() || "Fogón TV", accent: $("b-accent").value, logo: state.brand.logo || "", ticker: $("b-ticker").value.trim() };
  try { await setDoc(doc(db, "public", "brand"), state.brand); toast("Personalización publicada.", "ok"); } catch (err) { fail(err); }
}

/* Estadísticas */
async function loadStats() {
  try {
    const snap = await getDocs(query(collection(db, "stats"), orderBy("at", "desc"), limit(2000)));
    const rows = snap.docs.map((d) => d.data());
    const sessions = new Set(rows.map((r) => r.sid));
    const today = new Date().toDateString();
    const todayRows = rows.filter((r) => r.at?.toDate().toDateString() === today);
    $("stats-summary").innerHTML = `<li><span>Reproducciones (últimas ${rows.length})</span><b>${rows.length}</b></li>
      <li><span>Espectadores distintos</span><b>${sessions.size}</b></li>
      <li><span>Reproducciones hoy</span><b>${todayRows.length}</b></li>
      <li><span>Espectadores hoy</span><b>${new Set(todayRows.map((r) => r.sid)).size}</b></li>`;
    const by = new Map();
    rows.forEach((r) => { const k = `${r.type}|${r.title}`; by.set(k, (by.get(k) || 0) + 1); });
    const list = [...by].sort((a, b) => b[1] - a[1]);
    $("stats-table").innerHTML = list.length ? `<table><thead><tr><th>Contenido</th><th>Tipo</th><th>Veces</th></tr></thead><tbody>${
      list.map(([k, n]) => { const [t, ...ti] = k.split("|"); return `<tr><td>${esc(ti.join("|"))}</td><td>${esc(t)}</td><td>${n}</td></tr>`; }).join("")}</tbody></table>` : '<p class="hint">Todavía no hay reproducciones registradas.</p>';
  } catch (err) { fail(err); }
}
