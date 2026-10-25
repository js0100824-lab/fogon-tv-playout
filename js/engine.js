// Motor de emisión: lógica pura (sin Firebase), probada en scripts/test.mjs.

export function parseDuration(text) {
  const s = String(text ?? "").trim();
  if (!s) return NaN;
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
    return p.reduce((a, n) => a * 60 + n, 0);
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : NaN;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/);
  return m ? m[1] : null;
}

export function toSource(url) {
  const id = youtubeId(url);
  return id ? { src: "youtube", ref: id } : { src: "file", ref: url };
}

/* ---------------- Plan de cortes ---------------- */
export const PLAN_DEFAULTS = {
  order: [], adOrder: [],
  mode: "time",            // "time" = cada X minutos/segundos dentro del programa · "programs" = cada N programas
  intervalValue: 10, intervalUnit: "m",
  breakCount: 3,           // anuncios distintos por corte
  breakRepeat: 1,          // cuántas veces se repite esa tanda en cada corte
  breakAtEnd: true,        // corte también al terminar cada programa
  everyN: 2,               // modo "programs"
  minTailSec: 15           // no cortar si al programa le quedan menos de estos segundos
};
export const planWithDefaults = (p) => ({ ...PLAN_DEFAULTS, ...(p || {}) });

export function intervalSeconds(plan) {
  const v = Number(plan.intervalValue);
  if (!(v > 0)) return 0;
  return Math.max(1, Math.round(plan.intervalUnit === "s" ? v : v * 60));
}

// Segundos del programa en los que se hace un corte interno (sin contar el final).
export function cutPoints(duration, plan) {
  const T = intervalSeconds(plan), tail = Math.max(0, Number(plan.minTailSec) || 0);
  const out = [];
  if (!(T > 0) || !(duration > 0)) return out;
  for (let t = T; t < duration - tail && out.length < 500; t += T) out.push(t);
  return out;
}

// Anuncios activos, en el orden elegido por el usuario (adOrder) y luego por título.
export function activeAds(library, plan) {
  const pos = new Map((plan.adOrder || []).map((id, n) => [id, n]));
  return library
    .filter((i) => i.kind === "comercial" && i.active !== false && i.duration > 0)
    .sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6) - (pos.has(b.id) ? pos.get(b.id) : 1e6) || (a.title || "").localeCompare(b.title || ""));
}

function toItem(i, type, extra = {}) {
  return { id: i.id, type, title: i.title, duration: i.duration, startAt: 0, ...toSource(i.url), ...extra };
}

// Construye el ciclo de emisión como lista de tramos. Un programa largo se parte en varios
// tramos (cada uno con su `startAt` dentro del archivo) y entre ellos van los anuncios,
// de modo que al volver el programa continúa exactamente donde se quedó.
export function buildCycle(library, rawPlan) {
  const plan = planWithDefaults(rawPlan);
  const byId = new Map(library.map((i) => [i.id, i]));
  const programs = (plan.order || []).map((id) => byId.get(id)).filter((i) => i && i.duration > 0);
  const ads = activeAds(library, plan);
  const count = Math.max(0, Math.floor(Number(plan.breakCount) || 0));
  const repeat = Math.max(1, Math.floor(Number(plan.breakRepeat) || 1));
  const canBreak = ads.length > 0 && count > 0;
  const out = [];
  let cursor = 0, breakNo = 0;

  const addBreak = () => {
    if (!canBreak) return;
    breakNo++;
    const tanda = [];
    for (let k = 0; k < count; k++) tanda.push(ads[cursor++ % ads.length]);
    for (let r = 0; r < repeat; r++) for (const ad of tanda) out.push(toItem(ad, "comercial", { breakNo }));
  };

  programs.forEach((p, idx) => {
    if (plan.mode === "programs") {
      out.push(toItem(p, "programa"));
      const every = Math.max(0, plan.everyN | 0);
      if (every > 0 && (idx + 1) % every === 0 && idx !== programs.length - 1) addBreak();
      return;
    }
    const cuts = canBreak ? cutPoints(p.duration, plan) : [];   // sin anuncios no se parte el programa
    const edges = [0, ...cuts, p.duration];
    const parts = edges.length - 1;
    for (let k = 0; k < parts; k++) {
      out.push(toItem(p, "programa", { startAt: edges[k], duration: edges[k + 1] - edges[k], part: k + 1, parts }));
      if (k < parts - 1) addBreak();
    }
    if (plan.breakAtEnd) addBreak();
  });
  // En modo "entre programas" siempre hay un corte al cierre del ciclo.
  if (plan.mode === "programs" && programs.length) addBreak();
  return out;
}

export const cycleLength = (items) => items.reduce((a, i) => a + i.duration, 0);

// Qué se emite en el instante `nowMs` (hora del servidor) y en qué segundo exacto.
export function locate(items, epochMs, nowMs) {
  const total = cycleLength(items);
  if (!total) return null;
  let t = (((nowMs - epochMs) / 1000) % total + total) % total;
  for (let index = 0; index < items.length; index++) {
    if (t < items[index].duration) {
      const item = items[index];
      return { index, item, offset: t, remaining: item.duration - t, filePos: (item.startAt || 0) + t };
    }
    t -= items[index].duration;
  }
  const item = items[0];
  return { index: 0, item, offset: 0, remaining: item.duration, filePos: item.startAt || 0 };
}

/* ---------------- Formato compacto del canal ----------------
   Con cortes cortos hay muchísimos tramos; se guarda cada video una sola vez (media) y la
   secuencia como listas cortas, para no pasar el límite de 1 MB de un documento de Firestore. */
export function compactChannel(items) {
  const media = {}, seq = [];
  for (const i of items) {
    if (!media[i.id]) media[i.id] = { t: i.title, s: i.src, r: i.ref };
    seq.push([i.id, i.type === "comercial" ? 1 : 0, Math.round((i.startAt || 0) * 1000) / 1000, Math.round(i.duration * 1000) / 1000, i.part || 0, i.parts || 0, i.breakNo || 0]);
  }
  return { media, seq };
}
export function expandChannel(ch) {
  if (!ch) return [];
  if (Array.isArray(ch.items)) return ch.items;
  const media = ch.media || {};
  return (ch.seq || []).filter((r) => media[r[0]]).map(([id, ad, startAt, duration, part, parts, breakNo]) => ({
    id, type: ad ? "comercial" : "programa", title: media[id].t, src: media[id].s, ref: media[id].r,
    startAt, duration, ...(part ? { part, parts } : {}), ...(breakNo ? { breakNo } : {})
  }));
}

// Título para mostrar un tramo: «Película · parte 2 de 3».
export function itemLabel(i) {
  return i.type === "comercial" ? i.title : (i.parts > 1 ? `${i.title} · parte ${i.part} de ${i.parts}` : i.title);
}

// Resumen para mostrar en el panel: dónde caerán los cortes de cada programa.
export function describeCuts(library, rawPlan) {
  const plan = planWithDefaults(rawPlan);
  const byId = new Map(library.map((i) => [i.id, i]));
  return (plan.order || []).map((id) => byId.get(id)).filter((i) => i && i.duration > 0).map((p) => {
    const cuts = plan.mode === "time" ? cutPoints(p.duration, plan) : [];
    return { title: p.title, duration: p.duration, cuts, end: plan.mode === "time" ? !!plan.breakAtEnd : false };
  });
}
