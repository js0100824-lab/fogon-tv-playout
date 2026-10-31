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
  // plan.fit = { order, durs }: duración ajustada de algunos programas (para que cada franja termine a su hora). Solo vale si la parrilla sigue igual.
  const fit = plan.fit && Array.isArray(plan.fit.order) && plan.fit.order.length === (plan.order || []).length && plan.fit.order.every((id, n) => id === plan.order[n]) ? plan.fit.durs || {} : null;
  const programs = (plan.order || []).map((id, n) => { const i = byId.get(id); if (!i) return null; const o = fit ? Number(fit[n]) : 0; return o > 0 && o !== i.duration ? { ...i, duration: o } : i; }).filter((i) => i && i.duration > 0);
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
  // tailFrom: desde qué tramo de la lista nueva se emite YA en este ciclo (lo anterior espera a la próxima vuelta) · headLen: tramos viejos que se emiten primero.
  return { items: hybrid, epoch, next: newItems, nextAt: Math.round(epoch + cycleLength(hybrid) * 1000), tailFrom: tailProgram >= 0 && tailProgram < nS.length ? nS[tailProgram] : newItems.length, headLen: head.length };
}

// Salto inmediato a un programa de la lista nueva (sin esperar al final del actual).
// stay=true  → vuelve a empezar el MISMO programa que estaba al aire (p. ej. cambiaste su enlace y debe recargarse).
// stay=false → pasa al SIGUIENTE programa que siga existiendo (p. ej. quitaste el que estaba al aire).
// index: cualquier tramo del programa al aire (o de su corte comercial). Devuelve { items, epoch, next, nextAt } o null.
export function jumpPublish(oldItems, index, newItems, now, stay) {
  if (!oldItems?.length || !newItems?.length || !(index >= 0 && index < oldItems.length)) return null;
  const oS = programStarts(oldItems), nS = programStarts(newItems);
  if (!oS.length || !nS.length) return null;
  let c = 0; for (let k = 0; k < oS.length; k++) if (oS[k] <= index) c = k;
  const hits = (id) => nS.map((k, j) => (newItems[k].id === id ? j : -1)).filter((j) => j >= 0);
  let target = -1;
  if (stay) target = nearest(hits(oldItems[oS[c]].id), c);
  for (let q = c + 1; q < oS.length && target < 0; q++) target = nearest(hits(oldItems[oS[q]].id), q - 1);   // los de abajo primero
  for (let q = 0; q < c && target < 0; q++) target = nearest(hits(oldItems[oS[q]].id), q);                    // si no queda nada abajo, vuelta al inicio
  if (target < 0) target = 0;
  const before = newItems.slice(0, nS[target]).reduce((a, i) => a + i.duration, 0);
  return { items: newItems, epoch: Math.round(now - before * 1000), next: null, nextAt: 0 };
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


/* ---------------- Generador de horarios (franjas por categoría) ----------------
   Reglas:
   · Un programa SIEMPRE termina completo, aunque se pase de la hora de su franja (la siguiente franja gana menos tiempo).
   · La única excepción es el último bloque del día, si es «Variado» (*): ahí la hora se repite y se corta de golpe para dar paso a lo que sigue.
   · Cuando los programas de una categoría no alcanzan, se repiten al azar en otro orden: si la primera vuelta fue A-B-C, la siguiente no puede ser A-B-C.
   · Un programa nuevo entra enseguida en la franja de su categoría (placeNewProgram). */
export const isKids = (c) => /caricatur|mu[nñ]equit|infantil|dibujos/i.test(c || "");

export function shuffleList(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const k = Math.floor(rng() * (i + 1)); [a[i], a[k]] = [a[k], a[i]]; }
  return a;
}

export function sortPrograms(list, how, createdMs = () => 0, rng = Math.random) {
  if (how === "rnd") return shuffleList(list, rng);
  const f = {
    long: (x, y) => y.duration - x.duration, short: (x, y) => x.duration - y.duration,
    new: (x, y) => createdMs(y) - createdMs(x), old: (x, y) => createdMs(x) - createdMs(y),
    az: (x, y) => (x.title || "").localeCompare(y.title || "")
  }[how];
  return f ? list.slice().sort(f) : list.slice();
}

// Franjas {from,to,cat} → trozos del día contados desde el minuto S. La franja en curso se parte: primero lo que le queda, al final lo que ya pasó.
export function normalizeSlots(slots, S0, toMin) {
  const raw = (slots || []).map((s) => ({ f: toMin(s.from), t: toMin(s.to), cat: s.cat }));
  if (!raw.length) return null;
  const S = S0 == null ? raw[0].f : S0, out = [];
  for (const s of raw) {
    const len = ((s.t - s.f + 1440) % 1440) || 1440, off = (S - s.f + 1440) % 1440;
    if (off < len) {
      out.push({ cat: s.cat, start: 0, end: len - off });
      if (off > 0) out.push({ cat: s.cat, start: 1440 - off, end: 1440 });
    } else { const rel = (s.f - S + 1440) % 1440; out.push({ cat: s.cat, start: rel, end: Math.min(1440, rel + len) }); }
  }
  return { S, slots: out.sort((a, b) => a.start - b.start) };
}

// Programas de una franja. «Variado» (*) va rotando entre las categorías (menos caricaturas), empezando por una distinta cada vez.
export function poolFor(s, base, how, rot, createdMs, rng) {
  if (s.cat !== "*") return sortPrograms(base.filter((i) => i.cat === s.cat), how, createdMs, rng);
  const groups = new Map();
  for (const i of sortPrograms(base.filter((x) => !isKids(x.cat)), how, createdMs, rng)) { const k = i.cat || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  let lists = [...groups.values()]; if (lists.length) { const r = rot % lists.length; lists = lists.slice(r).concat(lists.slice(0, r)); }
  const out = [];
  for (let k = 0; ; k++) { let any = false; for (const l of lists) if (l[k]) { out.push(l[k]); any = true; } if (!any) break; }
  return out;
}

// Orden de una vuelta de repetición: al azar y distinto al de TODAS las vueltas anteriores (ABC → BCA, nunca otra vez ABC) mientras queden órdenes sin usar;
// si se puede, sin empezar con el último que salió.
const factorial = (n) => { let f = 1; for (let k = 2; k <= n; k++) f *= k; return f; };
function nextRound(pool, rd, last, rng) {
  if (pool.length < 2) return pool.slice();
  const prev = rd.played, key = prev.join("|");
  if (prev.length === pool.length) rd.seen.add(key);
  if (pool.length <= 8 && rd.seen.size >= factorial(pool.length)) { rd.seen = new Set(prev.length === pool.length ? [key] : []); }   // ya salieron todos los órdenes posibles: se empieza de nuevo
  let soft = null;
  for (let t = 0; t < 200; t++) {
    const a = shuffleList(pool, rng), k = a.map((i) => i.id).join("|");
    if (rd.seen.has(k) || (prev.length && a.slice(0, prev.length).map((i) => i.id).join("|") === key)) continue;
    if (a[0].id !== last) return a;
    soft = soft || a;
  }
  return soft || pool.slice(1).concat(pool[0]);
}

// Devuelve { order, durs, rows, len, slotMap }. `durs` solo puede tener una entrada: el último programa del último bloque «Variado» (el único que se corta).
export function buildSchedule({ library, plan, ns, how, skipBad = true, createdMs = () => 0, rng = Math.random }) {
  const base = library.filter((i) => i.kind === "programa" && i.duration > 0 && !(skipBad && i.fbOk === false));
  const durs = {}, order = [], used = new Set(), rows = [], rounds = new Map();
  const ev = (ids) => cycleLength(buildCycle(library, { ...plan, order: ids, fit: { order: ids, durs } }));   // largo real del ciclo (anuncios incluidos)
  const fitTo = (idx, lo, hi, end) => { let a = lo, b = hi; while (a < b) { const m = Math.ceil((a + b) / 2); durs[idx] = m; if (ev(order) <= end) a = m; else b = m - 1; } durs[idx] = a; };
  const lastSlot = ns.slots.length - 1;
  let len = 0, last = null, rot = 0;
  ns.slots.forEach((s, si) => {
    const cutOk = si === lastSlot && s.cat === "*";                  // solo aquí se permite cortar de golpe
    const end = s.end * 60, pool = poolFor(s, base, how, rot, createdMs, rng), row = { ...s, n: 0, startAt: len, i0: order.length, cut: false };
    if (s.cat === "*") rot++;
    if (!pool.length) { row.empty = true; row.endAt = len; row.i1 = order.length; rows.push(row); return; }
    const rd = rounds.get(s.cat) || { played: [], seen: new Set(), ord: null }; rounds.set(s.cat, rd);
    const byId = new Map(pool.map((i) => [i.id, i]));
    let ord = rd.ord ? rd.ord.map((id) => byId.get(id)).filter(Boolean) : []; for (const i of pool) if (!ord.includes(i)) ord.push(i);
    const take = (i, t) => { used.add(i.id); last = i.id; rd.played.push(i.id); row.n++; len = t; };
    for (let guard = 0; guard < 300 && end - len > 60; guard++) {
      let cand = ord.filter((i) => !used.has(i.id));
      if (!cand.length) {   // ya salieron todos: otra vuelta, al azar y en otro orden
        pool.forEach((i) => used.delete(i.id));
        ord = nextRound(pool, rd, last, rng); rd.played = []; cand = ord.slice();
      }
      let pick = null;
      for (const i of cand) { const t = ev([...order, i.id]); if (t <= end) { pick = { i, t }; break; } }
      if (cutOk) {
        // Último bloque del día: se evita dejar un hueco al final cortando de golpe un programa justo a la hora.
        if (!pick || end - pick.t < 120) {
          const over = cand.find((i) => (!pick || i.id !== pick.i.id) && ev([...order, i.id]) > end);
          if (over && end - len >= 60) {
            const idx = order.length; order.push(over.id); fitTo(idx, 30, over.duration, end);
            if (ev(order) <= end) { take(over, ev(order)); row.cut = true; continue; }
            order.pop(); delete durs[idx];
          }
        }
      } else if (!pick) {
        // Nada cabe entero: entra el que se pase menos, y termina completo. Solo si así queda más cerca de la hora que dejando la franja corta.
        let best = null; for (const i of cand) { const t = ev([...order, i.id]); if (!best || t < best.t) best = { i, t }; }
        if (best && best.t - end <= end - len) pick = best;
      }
      if (!pick) break;
      order.push(pick.i.id); take(pick.i, pick.t);
    }
    rd.ord = ord.map((i) => i.id);
    row.endAt = len; row.i1 = order.length; rows.push(row);
  });
  const fin = rows[rows.length - 1], tailFrom = fin && ns.slots[lastSlot].cat === "*" && fin.n > 0 ? fin.i0 : -1;
  const slotMap = { order: [...order], target: ns.slots[lastSlot].end * 60, tailFrom, rows: rows.map(({ cat, start, end, i0, i1 }) => ({ cat, start, end, i0, i1 })) };
  return { order, durs, rows, len, slotMap };
}

// Tras meter un programa en la parrilla, el ciclo crece. Si el último bloque es «Variado» (se puede cortar), ahí se recupera el tiempo:
// se acorta el último programa y, si hace falta, se quitan los últimos, para que el día siga cerrando a su hora.
export function absorbTail(library, plan) {
  const sm = plan.slotMap; if (!sm || !(sm.tailFrom >= 0) || !(sm.target > 0)) return false;
  const order = plan.order, durs = { ...(plan.fit?.durs || {}) };
  const ev = () => cycleLength(buildCycle(library, { ...plan, order, fit: { order, durs } }));
  const byId = new Map(library.map((i) => [i.id, i]));
  let changed = false;
  while (ev() > sm.target && order.length - 1 >= sm.tailFrom) {
    const idx = order.length - 1, full = byId.get(order[idx])?.duration || 0, cur = durs[idx] > 0 ? durs[idx] : full;
    durs[idx] = 30;
    if (ev() <= sm.target) { let a = 30, b = cur; while (a < b) { const m = Math.ceil((a + b) / 2); durs[idx] = m; if (ev() <= sm.target) a = m; else b = m - 1; } durs[idx] = a; changed = true; break; }
    delete durs[idx]; order.pop(); changed = true;
    sm.rows[sm.rows.length - 1].i1 = Math.min(sm.rows[sm.rows.length - 1].i1, order.length);
  }
  plan.fit = { order: [...order], durs }; sm.order = [...order];
  return changed;
}

// Mete un programa nuevo en la parrilla. airIdx = posición (en plan.order) del programa al aire (-1 si no se sabe).
// 1) Lo normal: SUSTITUYE una repetición de su misma categoría en el ciclo (la primera que aún no ha salido; si todas ya pasaron, la primera de la próxima vuelta).
//    El programa sustituido no se toca en la parrilla principal: solo pierde esa repetición, y nunca la que está al aire.
// 2) Si no queda ninguna repetición de esa categoría, se SUMA en su franja: justo después del programa al aire si es de esa franja, primero en ella si viene más adelante.
// Devuelve { at, cat, replaced } (replaced = título del programa que perdió una repetición, o null si se sumó) o null si no hay dónde ponerlo.
export function placeNewProgram(library, plan, item, airIdx = -1) {
  const sm = plan.slotMap, order = plan.order || [];
  if (!item?.cat || order.includes(item.id)) return null;
  const byId = new Map(library.map((i) => [i.id, i]));
  const valid = !!(sm && Array.isArray(sm.rows) && Array.isArray(sm.order) && sm.order.length === order.length && sm.order.every((id, n) => id === order[n]));
  const repeats = [];   // posiciones que son repetición (el programa ya había salido antes en el ciclo) de la misma categoría
  const seen = new Set(); order.forEach((id, n) => { if (seen.has(id) && byId.get(id)?.cat === item.cat && n !== airIdx) repeats.push(n); seen.add(id); });
  if (repeats.length) {
    const at = repeats.find((n) => n > airIdx) ?? repeats[0], old = byId.get(order[at]);
    order[at] = item.id;
    const durs = { ...(plan.fit?.durs || {}) }; delete durs[at];   // si esa posición estaba recortada, deja de estarlo
    if (valid) { plan.fit = { order: [...order], durs }; sm.order = [...order]; absorbTail(library, plan); } else plan.fit = null;
    return { at, cat: item.cat, replaced: old?.title || null };
  }
  if (!sm || !Array.isArray(sm.rows)) return null;
  if (!valid) {
    // La parrilla se tocó a mano y ya no se sabe dónde cae cada franja: entra después del último programa de su categoría.
    let j = -1; order.forEach((id, n) => { if (byId.get(id)?.cat === item.cat) j = n; });
    if (j < 0) return null;
    order.splice(j + 1, 0, item.id); plan.fit = null; plan.slotMap = { ...sm, order: null };
    return { at: j + 1, cat: item.cat, replaced: null };
  }
  let cand = sm.rows.map((r, n) => ({ r, n })).filter(({ r }) => r.cat === item.cat);
  if (!cand.length && !isKids(item.cat)) cand = sm.rows.map((r, n) => ({ r, n })).filter(({ r }) => r.cat === "*");
  if (!cand.length) return null;
  const pick = cand.find(({ r }) => r.i1 > airIdx) || cand[0], r = pick.r;
  const at = airIdx >= r.i0 && airIdx < r.i1 ? airIdx + 1 : r.i0;
  order.splice(at, 0, item.id);
  sm.rows.forEach((x, n) => { if (n === pick.n) x.i1++; else if (n > pick.n) { x.i0++; x.i1++; } });
  const durs = {}; for (const [k, v] of Object.entries(plan.fit?.durs || {})) durs[Number(k) >= at ? Number(k) + 1 : Number(k)] = v;
  plan.fit = { order: [...order], durs }; sm.order = [...order];
  if (sm.tailFrom >= 0) sm.tailFrom = sm.rows[sm.rows.length - 1].i0;
  absorbTail(library, plan);
  return { at, cat: r.cat === "*" ? "Variado" : r.cat, replaced: null };
}


/* ---------------- Programas FIJADOS ----------------
   Un fijado es un programa que sale SIEMPRE a su hora (de X a Y), todos los días.
   · pin = { id, title, from:"HH:MM", to:"HH:MM", tolMin, lines:[{ id, url, duration, title, fbOk }] }
   · Cada línea es una variación: el día 1 sale la línea 1, el día 2 la línea 2… y vuelve a empezar.
   · El resto del día lo llena la parrilla principal (plan.order) como una cola que sigue corriendo de un día al siguiente.
   · Si el programa anterior no cabe antes de la hora fija, se prueba otro que sí quepa; si ninguno cabe, el último se corta para que el fijado llegue puntual.
     El fijado puede salir hasta `tolMin` minutos antes de su hora (nunca después, salvo que el fijado anterior se haya pasado).
   · El ciclo publicado dura K días exactos (K = largo de la rotación de líneas) y arranca a medianoche de República Dominicana,
     así la hora del reloj y la hora de la emisión siempre coinciden. */
export const DAY_SEC = 86400, DAY_MS = 86400000, PIN_MAX_DAYS = 14;
export const PIN_ANCHOR_MS = Date.UTC(2025, 0, 1, 4, 0, 0);   // 00:00 de República Dominicana (UTC−4, sin horario de verano)
const hhmm = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return ((((h || 0) * 60 + (m || 0)) % 1440) + 1440) % 1440; };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export const pinLineId = (pin, line) => `pin_${pin.id}_${line.id}`;

// Líneas que se pueden emitir (con enlace y duración). Las marcadas «No se ve» se saltan, salvo que todas lo estén.
export function pinLines(pin) {
  const ok = (pin?.lines || []).filter((l) => l && l.id && l.url && l.duration > 0);
  const good = ok.filter((l) => l.fbOk !== false);
  return good.length ? good : ok;
}
// Franja en minutos del día. Si «hasta» no es posterior a «desde» (p. ej. 12:00 AM), la franja llega hasta medianoche.
export function pinWindow(pin) { const f = hhmm(pin.from), t = hhmm(pin.to); return { f, t: t > f ? t : 1440 }; }
// Fijados válidos y en orden; si dos se pisan, se descarta el que empieza dentro del anterior.
export function activePins(plan) {
  const all = (plan?.pins || []).filter((p) => p && p.id && pinLines(p).length).map((p) => ({ p, ...pinWindow(p) })).sort((a, b) => a.f - b.f);
  const out = []; let end = -1;
  for (const x of all) { if (x.f < end) continue; out.push(x.p); end = x.t; }
  return out;
}
// Días que dura la rotación: el mínimo común múltiplo del nº de líneas de cada fijado (tope PIN_MAX_DAYS).
export function pinDays(pins) {
  const ls = pins.map((p) => pinLines(p).length), mx = Math.max(1, ...ls);
  let l = 1; for (const n of ls) { l = (l / gcd(l, n)) * n; if (l > PIN_MAX_DAYS) return Math.min(mx, PIN_MAX_DAYS); }
  return l;
}
export const pinDayIndex = (nowMs, K) => ((Math.floor((nowMs - PIN_ANCHOR_MS) / DAY_MS) % K) + K) % K;
export const pinEpoch = (nowMs, K) => PIN_ANCHOR_MS + Math.floor((nowMs - PIN_ANCHOR_MS) / (K * DAY_MS)) * K * DAY_MS;

function spansOf(items) {
  const out = []; let t = 0;
  for (const it of items) {
    if (it.type === "programa") {
      if (!it.part || it.part === 1) out.push({ id: it.id, start: t, end: t + it.duration });
      else { const p = out[out.length - 1]; if (p && p.id === it.id) p.end = t + it.duration; }
    }
    t += it.duration;
  }
  return out;
}

// Devuelve null si no hay fijados; si no, { items, K, days:[{ items, rows, warn }], error? }.
// rows de cada día: { kind:"filler", oi, id, title, start, end } | { kind:"pin", pin, line, lineNo, lines, id, title, start, end, from, to, delta }  (segundos desde las 00:00)
export function buildPinnedCycle(library, rawPlan) {
  const plan = { ...planWithDefaults(rawPlan), fit: null };
  const pins = activePins(plan); if (!pins.length) return null;
  const K = pinDays(pins), byId = new Map(library.map((i) => [i.id, i]));
  const lib2 = library.slice();
  for (const p of pins) for (const l of pinLines(p)) lib2.push({ id: pinLineId(p, l), kind: "programa", title: l.title || p.title || "Programa fijado", url: l.url, duration: l.duration, active: true });
  const byId2 = new Map(lib2.map((i) => [i.id, i]));
  const fillers = (plan.order || []).map((id, oi) => ({ oi, id })).filter((f) => { const i = byId.get(f.id); return i && i.kind === "programa" && i.duration > 0; });
  if (!fillers.length) return { items: [], K, days: [], error: "Hace falta al menos un programa en la parrilla principal para llenar las horas libres." };
  let queue = [], lastId = null;
  const refill = () => { while (queue.length < 60) for (const f of fillers) queue.push(f); };
  const days = [];
  for (let d = 0; d < K; d++) {
    const order = [], durs = {}, tags = [];
    const build = (o) => buildCycle(lib2, { ...plan, order: o, fit: { order: o, durs } });
    const endOf = (o) => cycleLength(build(o));
    const startOf = (o, id) => { let t = 0; for (const it of build(o)) { if (it.id === id && it.type === "programa" && (!it.part || it.part === 1)) return t; t += it.duration; } return t; };
    const dayPins = pins.map((p) => { const ls = pinLines(p), line = ls[d % ls.length], w = pinWindow(p); return { pin: p, line, id: pinLineId(p, line), f: w.f * 60, t: w.t * 60, tol: Math.max(0, Number(p.tolMin) || 0) * 60, lineNo: (d % ls.length) + 1, lines: ls.length }; });
    // Llena el hueco hasta `target`. nextId = el fijado que viene después (su hora de inicio es lo que se mide); null = fin del día.
    const fillTo = (target, tol, nextId) => {
      const measure = () => (nextId ? startOf([...order, nextId], nextId) : endOf(order));
      const after = (f) => (nextId ? startOf([...order, f.id, nextId], nextId) : endOf([...order, f.id]));
      let cur = measure();
      for (let guard = 0; guard < 500; guard++) {
        if (target - cur <= tol || (!nextId && target - cur < 1)) break;
        refill();
        const okC = (f) => f.id !== lastId || fillers.every((x) => x.id === f.id);
        let best = -1, bestT = -1;
        for (let q = 0, lim = Math.min(queue.length, 40); q < lim; q++) {
          if (!okC(queue[q])) continue;
          const t = after(queue[q]);
          if (t <= target && (nextId || target - t === 0 || target - t >= 60)) { if (q < 8) { best = q; bestT = t; break; } if (t > bestT) { best = q; bestT = t; } }   // al cierre del día no se deja un residuo de segundos: mejor cortar uno más largo
        }
        if (best >= 0) { const f = queue.splice(best, 1)[0]; order.push(f.id); tags.push({ oi: f.oi }); lastId = f.id; cur = bestT; continue; }
        // Nada cabe entero: se corta el siguiente para que la hora fija llegue puntual.
        let qi = queue.findIndex((f) => okC(f) && byId.get(f.id).duration > target - cur); if (qi < 0) qi = queue.findIndex(okC); if (qi < 0) qi = 0;
        const f = queue[qi], idx = order.length, full = byId.get(f.id).duration;
        order.push(f.id); let lo = 45, hi = full - 1, got = 0;
        const fits = () => (nextId ? startOf([...order, nextId], nextId) : endOf(order));
        while (lo <= hi) { const m = (lo + hi) >> 1; durs[idx] = m; if (fits() <= target) { got = m; lo = m + 1; } else hi = m - 1; }
        if (!got) { order.pop(); delete durs[idx]; break; }   // el hueco es muy chico: el fijado sale un poco antes
        durs[idx] = got; queue.splice(qi, 1); tags.push({ oi: f.oi }); lastId = f.id; cur = fits();
      }
    };
    for (const dp of dayPins) { fillTo(dp.f, dp.tol, dp.id); order.push(dp.id); tags.push({ pin: dp }); lastId = dp.id; }
    fillTo(DAY_SEC, 0, null);
    const items = build(order), warn = [];
    let total = cycleLength(items);
    if (total > DAY_SEC + 0.0005) {   // un fijado se pasó de medianoche: se corta ahí para no descuadrar el día siguiente
      let over = total - DAY_SEC; warn.push("Se corta a medianoche para empezar el día siguiente puntual.");
      while (over > 0.0005 && items.length) { const last = items[items.length - 1]; if (last.duration > over + 0.0005) { last.duration -= over; over = 0; } else { over -= last.duration; items.pop(); } }
    } else if (total < DAY_SEC - 0.0005) {   // quedaron segundos sueltos: los absorbe el último programa (si es un corte, tiene más video de donde sacar)
      const r = DAY_SEC - total;
      for (let k = items.length - 1; k >= 0; k--) if (items[k].type === "programa") { const it = items[k], file = byId2.get(it.id)?.duration || 0; if ((it.startAt || 0) + it.duration + r <= file + 0.0005 || r < 60) it.duration += r; else warn.push("Al día le faltan unos segundos para cerrar las 24 h."); break; }
    }
    const spans = spansOf(items), rows = [];
    spans.forEach((s, k) => {
      const tg = tags[k]; if (!tg) return;
      if (tg.pin) { const dp = tg.pin; rows.push({ kind: "pin", pin: dp.pin.id, line: dp.line.id, lineNo: dp.lineNo, lines: dp.lines, id: s.id, title: byId2.get(s.id)?.title || dp.pin.title, start: s.start, end: s.end, from: dp.f, to: dp.t, delta: s.start - dp.f, endDelta: s.end - dp.t }); }
      else rows.push({ kind: "filler", oi: tg.oi, id: s.id, title: byId2.get(s.id)?.title || "", start: s.start, end: s.end });
    });
    days.push({ items, rows, warn });
  }
  return { items: days.flatMap((x) => x.items), K, days };
}
