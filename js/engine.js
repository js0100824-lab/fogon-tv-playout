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

export function facebookUrl(url) {
  return /^https?:\/\/(?:[\w-]+\.)?(?:facebook\.com|fb\.watch)\//i.test(String(url).trim()) ? String(url).trim() : null;
}

export function toSource(url) {
  const id = youtubeId(url);
  if (id) return { src: "youtube", ref: id };
  const fb = facebookUrl(url);
  return fb ? { src: "facebook", ref: fb } : { src: "file", ref: url };
}

// Enlace de un directo (YouTube o Facebook) → { kind, ref } o null.
export function parseLiveLink(url) {
  const yt = youtubeId(url);
  if (yt) return { kind: "youtube", ref: yt };
  const fb = facebookUrl(url);
  return fb ? { kind: "facebook", ref: fb } : null;
}

/* ---------------- Plan de cortes ---------------- */
export const PLAN_DEFAULTS = {
  order: [], adOrder: [],
  mode: "continuous",      // "continuous" = cada X minutos de programación corrida (entre varios programas) · "time" = dentro de cada programa · "programs" = cada N programas
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
  // Un comercial puede tener «duración al aire» (playFor): solo se emite ese tiempo y luego sigue la programación.
  const dur = type === "comercial" && i.playFor > 0 ? Math.min(i.playFor, i.duration) : i.duration;
  return { id: i.id, type, title: i.title, duration: dur, startAt: 0, ...toSource(i.url), ...extra };
}

// Modo «continuous»: el reloj de cortes corre a través de todos los programas. Cada `intervalo` de programación
// emitida sale un corte, aunque haya pasado de un programa a otro (un corte puede caer a mitad de un programa).
// Devuelve, por programa: lead (corte antes de empezarlo), cuts (segundos internos) y end (corte al terminarlo),
// y tailBreak (corte al cerrar el ciclo, para que la cadencia no se rompa al repetirse).
export function continuousLayout(programs, rawPlan) {
  const plan = planWithDefaults(rawPlan);
  const T = intervalSeconds(plan), tail = Math.max(0, Number(plan.minTailSec) || 0);
  const rows = []; let acc = 0;
  for (const p of programs) {
    const D = p.duration, row = { lead: false, cuts: [], end: false };
    let pos = 0, guard = 0;
    while (T > 0 && guard++ < 2000) {
      const at = pos + (T - acc);                        // punto del programa donde toca el siguiente corte
      if (at > D) { acc += D - pos; break; }              // el intervalo no se cumple en este programa: sigue en el próximo
      if (at >= D - tail) { row.end = true; acc = 0; break; }   // cae al final (o a pocos segundos): corte al terminar
      if (pos === 0 && !row.cuts.length && !row.lead && T > tail && at < tail) { row.lead = true; acc = 0; continue; }   // cae justo al empezar: corte antes
      row.cuts.push(at); pos = at; acc = 0;
    }
    if (!(T > 0)) acc += D;
    rows.push(row);
  }
  return { rows, tailBreak: T > 0 && acc > 0 && acc >= T / 2 };
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

  const cont = plan.mode === "continuous" && canBreak ? continuousLayout(programs, plan) : null;
  programs.forEach((p, idx) => {
    if (cont) {
      const r = cont.rows[idx];
      if (r.lead) addBreak();
      const edges = [0, ...r.cuts, p.duration], parts = edges.length - 1;
      for (let k = 0; k < parts; k++) {
        out.push(toItem(p, "programa", { startAt: edges[k], duration: edges[k + 1] - edges[k], ...(parts > 1 ? { part: k + 1, parts } : {}) }));
        if (k < parts - 1) addBreak();
      }
      if (r.end) addBreak();
      return;
    }
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
  if (cont && cont.tailBreak) addBreak();
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
    // Cada tramo es un texto "id|esAnuncio|inicio|duración|parte|partes|corte" (Firestore no admite listas dentro de listas).
    seq.push([i.id, i.type === "comercial" ? 1 : 0, Math.round((i.startAt || 0) * 1000) / 1000, Math.round(i.duration * 1000) / 1000, i.part || 0, i.parts || 0, i.breakNo || 0].join("|"));
  }
  return { media, seq };
}
export function expandChannel(ch) {
  if (!ch) return [];
  if (Array.isArray(ch.items)) return ch.items;
  const media = ch.media || {};
  return (ch.seq || []).map((row) => String(row).split("|")).filter((r) => media[r[0]]).map(([id, ad, startAt, duration, part, parts, breakNo]) => ({
    id, type: Number(ad) ? "comercial" : "programa", title: media[id].t, src: media[id].s, ref: media[id].r,
    startAt: Number(startAt), duration: Number(duration), ...(Number(part) ? { part: Number(part), parts: Number(parts) } : {}), ...(Number(breakNo) ? { breakNo: Number(breakNo) } : {})
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
  const progs = (plan.order || []).map((id) => byId.get(id)).filter((i) => i && i.duration > 0);
  if (plan.mode === "continuous") {
    const { rows, tailBreak } = continuousLayout(progs, plan);
    return progs.map((p, n) => ({ title: p.title, duration: p.duration, cuts: rows[n].cuts, lead: rows[n].lead, end: rows[n].end || (tailBreak && n === progs.length - 1) }));
  }
  return progs.map((p) => {
    const cuts = plan.mode === "time" ? cutPoints(p.duration, plan) : [];
    return { title: p.title, duration: p.duration, cuts, end: plan.mode === "time" ? !!plan.breakAtEnd : false };
  });
}


/* ---------------- Publicar sin reiniciar el ciclo ----------------
   Al editar la parrilla con la emisión en marcha, lo que ya pasó o está sonando no se toca:
   · Cambios por DEBAJO del programa actual → entran en este mismo ciclo, cuando se llegue a ellos.
   · Cambios por ENCIMA del programa actual → esperan a la próxima repetición del ciclo.
   Se logra con una lista de "transición" (lo viejo hasta terminar el programa actual + lo nuevo que le sigue)
   que se emite una vez; al acabar, entra la lista nueva completa (campos nextSeq / nextAt del canal). */
const isProgramStart = (i) => i.type === "programa" && (!i.part || i.part === 1);
const programStarts = (items) => { const out = []; items.forEach((it, n) => { if (isProgramStart(it)) out.push(n); }); return out; };
const nearest = (list, target) => list.reduce((best, j) => (best < 0 || Math.abs(j - target) < Math.abs(best - target) || (Math.abs(j - target) === Math.abs(best - target) && j > best) ? j : best), -1);
const sameSeq = (a, b) => a.length === b.length && compactChannel(a).seq.join("\n") === compactChannel(b).seq.join("\n");

// oldItems: lista que está al aire · index/offset: tramo y segundo exactos que suenan ahora · newItems: ciclo recién construido.
// Devuelve { items, epoch, next, nextAt } o null si no se puede (entonces se publica desde cero).
export function seamlessPublish(oldItems, index, offset, newItems, now) {
  if (!oldItems?.length || !newItems?.length || !(index >= 0 && index < oldItems.length)) return null;
  const oS = programStarts(oldItems), nS = programStarts(newItems);
  if (!oS.length) return null;
  let c = 0; for (let k = 0; k < oS.length; k++) if (oS[k] <= index) c = k;          // programa que está al aire (los anuncios cuentan para el programa anterior)
  const headEnd = c + 1 < oS.length ? oS[c + 1] : oldItems.length;                   // lo viejo llega hasta que acaba el programa actual y su corte
  const head = oldItems.slice(0, headEnd);
  const nIds = nS.map((k) => newItems[k].id);
  const hits = (id) => nIds.map((x, j) => (x === id ? j : -1)).filter((j) => j >= 0);
  let tailProgram = -1;                                                              // primer programa NUEVO que se emite tras el actual
  const same = nearest(hits(oldItems[oS[c]].id), c);
  if (same >= 0) tailProgram = same + 1;
  else for (let q = c + 1; q < oS.length && tailProgram < 0; q++) { const j = nearest(hits(oldItems[oS[q]].id), q); if (j >= 0) tailProgram = j; }   // el actual fue quitado: sigue con el siguiente que aún exista
  const tail = tailProgram >= 0 && tailProgram < nS.length ? newItems.slice(nS[tailProgram]) : [];
  const hybrid = head.concat(tail);
  const start = oldItems.slice(0, index).reduce((a, i) => a + i.duration, 0);
  const epoch = Math.round(now - (start + offset) * 1000);
  if (sameSeq(hybrid, newItems)) return { items: newItems, epoch, next: null, nextAt: 0 };
  return { items: hybrid, epoch, next: newItems, nextAt: Math.round(epoch + cycleLength(hybrid) * 1000) };
}

// Si ya pasó la hora de relevo, el canal pasa a la lista nueva (cada cliente lo hace solo, con el mismo resultado).
export function settleChannel(ch, now) {
  if (!ch || ch.live === false || !ch.nextSeq || !(now >= ch.nextAt)) return false;
  const next = expandChannel({ media: ch.media, seq: ch.nextSeq });
  if (!next.length) return false;
  ch.items = next; ch.epoch = ch.nextAt; delete ch.nextSeq; delete ch.nextAt;
  return true;
}


/* ---------------- Programa al aire y el que sigue (para mostrar en la página) ----------------
   Devuelve { now, next, ad }: cada programa con título, hora de inicio/fin (ms, hora del servidor) y duración (s).
   Los anuncios no cuentan como programa: durante un corte sigue figurando el programa al que pertenece. */
const startsProgram = (i) => i.type === "programa" && (!i.part || i.part === 1);
export function nowNext(items, epochMs, nowMs, nextItems) {
  const loc = locate(items, epochMs, nowMs); if (!loc) return null;
  const cumOf = (list) => { const c = []; let a = 0; for (const i of list) { c.push(a); a += i.duration; } return { c, total: a }; };
  const { c: cum, total } = cumOf(items);
  const t0 = nowMs - (cum[loc.index] + loc.offset) * 1000;
  const prog = (list, k, base, c) => {
    const it = list[k]; let last = k;
    if (it.parts > 1) for (let j = k + 1; j < list.length; j++) {
      const x = list[j];
      if (x.type === "programa" && x.id === it.id && x.part > 1) { last = j; if (x.part >= it.parts) break; }
      else if (x.type === "programa") break;
    }
    const dur = it.parts > 1 ? (list[last].startAt || 0) + list[last].duration - (it.startAt || 0) : it.duration;
    return { title: it.title, start: Math.round(base + c[k] * 1000), end: Math.round(base + (c[last] + list[last].duration) * 1000), duration: Math.round(dur), last };
  };
  let s = -1; for (let k = loc.index; k >= 0; k--) if (startsProgram(items[k])) { s = k; break; }
  const now = s >= 0 ? prog(items, s, t0, cum) : null;
  let next = null;
  for (let k = (now ? now.last : loc.index) + 1; k < items.length && !next; k++) if (startsProgram(items[k])) next = prog(items, k, t0, cum);
  if (!next) {
    const list = nextItems?.length ? nextItems : items, { c } = cumOf(list), base = t0 + total * 1000;
    const k = list.findIndex(startsProgram); if (k >= 0) next = prog(list, k, base, c);
  }
  const strip = (x) => x && { title: x.title, start: x.start, end: x.end, duration: x.duration };
  return { now: strip(now), next: strip(next), ad: items[loc.index].type === "comercial" };
}
