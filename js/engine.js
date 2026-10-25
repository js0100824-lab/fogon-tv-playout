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

// Construye el ciclo de emisión: programas en orden, y cada `everyN` programas
// un corte de `breakCount` comerciales activos, rotando entre ellos.
export function buildCycle(library, plan) {
  const byId = new Map(library.map((i) => [i.id, i]));
  const programs = (plan.order || []).map((id) => byId.get(id)).filter((i) => i && i.duration > 0);
  const ads = library.filter((i) => i.kind === "comercial" && i.active !== false && i.duration > 0);
  const everyN = Math.max(0, plan.everyN | 0), breakCount = Math.max(0, plan.breakCount | 0);
  const out = [];
  let adCursor = 0;
  programs.forEach((p, idx) => {
    out.push(toItem(p, "programa"));
    const last = idx === programs.length - 1;
    if (everyN > 0 && breakCount > 0 && ads.length && (idx + 1) % everyN === 0 && !last) {
      for (let k = 0; k < breakCount; k++) out.push(toItem(ads[adCursor++ % ads.length], "comercial"));
    }
  });
  // Corte al cierre del ciclo para que el ciclo siguiente no empiece sin publicidad.
  if (everyN > 0 && breakCount > 0 && ads.length && programs.length) {
    for (let k = 0; k < breakCount; k++) out.push(toItem(ads[adCursor++ % ads.length], "comercial"));
  }
  return out;
}

function toItem(i, type) {
  return { id: i.id, type, title: i.title, duration: i.duration, ...toSource(i.url) };
}

export const cycleLength = (items) => items.reduce((a, i) => a + i.duration, 0);

// Qué se emite en el instante `nowMs` y en qué segundo exacto.
export function locate(items, epochMs, nowMs) {
  const total = cycleLength(items);
  if (!total) return null;
  let t = (((nowMs - epochMs) / 1000) % total + total) % total;
  for (let index = 0; index < items.length; index++) {
    if (t < items[index].duration) {
      return { index, item: items[index], offset: t, remaining: items[index].duration - t };
    }
    t -= items[index].duration;
  }
  return { index: 0, item: items[0], offset: 0, remaining: items[0].duration };
}
