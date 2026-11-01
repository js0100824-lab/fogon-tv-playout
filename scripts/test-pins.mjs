// Pruebas de 24/7 y fijados: node scripts/test-pins.mjs
import { buildPinnedCycle, buildSchedule, normalizeSlots, planWithDefaults, cycleLength, DAY_SEC, sameCat } from "../js/engine.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("  ✗", m); } else console.log("  ✓", m); };
const min = (n) => n * 60;
const SLOTS = [
  { from: "06:00", to: "10:00", cat: "Caricaturas" }, { from: "10:00", to: "14:00", cat: "Informativos" },
  { from: "14:00", to: "15:00", cat: "Películas" }, { from: "15:00", to: "18:00", cat: "Entretenimiento" },
  { from: "18:00", to: "22:00", cat: "Novelas" }, { from: "22:00", to: "00:00", cat: "Informativos" }, { from: "00:00", to: "06:00", cat: "*" }
];
const mk = (id, cat, dur) => ({ id, title: id, kind: "programa", cat, duration: dur, url: "x.mp4", active: true });
const lib = [];
for (let i = 0; i < 4; i++) lib.push(mk(`car${i}`, "Caricaturas", min(23 + i)));
for (let i = 0; i < 5; i++) lib.push(mk(`inf${i}`, "Informativos", min(32 + i * 6)));
for (let i = 0; i < 3; i++) lib.push(mk(`pel${i}`, "peliculas", min(95 + i * 9)));   // sin tilde y sin mayúscula: igual debe coincidir
for (let i = 0; i < 5; i++) lib.push(mk(`ent${i}`, "Entretenimiento", min(41 + i * 3)));
for (let i = 0; i < 5; i++) lib.push(mk(`nov${i}`, "Novelas", min(52 + i * 7)));
for (let i = 0; i < 3; i++) lib.push(mk(`var${i}`, "Variedades", min(30 + i * 10)));
const ads = [1, 2, 3].map((n) => ({ id: `ad${n}`, title: `ad${n}`, kind: "comercial", url: "a.mp4", duration: 20 + n * 5, active: true }));
const library = [...lib, ...ads];
const line = (id, dur) => ({ id, url: `https://x/${id}.mp4`, duration: dur, title: id });
const pins = [{ id: "n3", title: "Noticiero 3PM", from: "15:00", to: "16:00", tolMin: 0, lines: [line("a", min(50))] }];
// la parrilla principal NO tiene películas: antes por eso no salía ninguna
const plan = planWithDefaults({ mode: "continuous", intervalValue: 10, breakCount: 2, order: lib.filter((i) => !i.id.startsWith("pel")).map((i) => i.id), pins, slots: SLOTS });
const r = buildPinnedCycle(library, plan);
ok(!r.error, "sin error " + (r.error || ""));
const day = r.days[0], by = new Map(library.map((i) => [i.id, i]));
const hm = (s) => { const m = (Math.floor(s / 60) + 360) % 1440; return `${m / 60 | 0}:${String(m % 60).padStart(2, "0")}`; };
ok(day.rows[0].start === 0, "el día empieza a las 6:00 a. m. (" + hm(day.rows[0].start) + ")");
ok(!day.items.some((i) => i.type === "comercial" && !i.breakNo), "ningún anuncio de relleno (solo cortes configurados)");
// duración real: cada programa suma lo que dura (salvo el recorte final del ciclo)
const runs = []; for (const i of day.items) { if (i.type !== "programa") continue; const l = runs[runs.length - 1]; if (l && l.id === i.id && Math.abs(l.at + l.t - (i.startAt || 0)) < 0.01) l.t += i.duration; else runs.push({ id: i.id, at: i.startAt || 0, t: i.duration }); }
let cut = 0; for (const x of runs) { const full = by.get(x.id)?.duration ?? min(50); if (Math.abs(x.t - full) > 1) cut++; }
ok(cut <= 1, `cada programa emite su duración real (${cut} recortado en el cierre del ciclo como máximo)`);
const pel = day.rows.filter((x) => x.kind === "filler" && sameCat(by.get(x.id)?.cat, "Películas"));
ok(pel.length >= 1, `hay película en la franja de películas aunque no esté en la parrilla (${pel.map((x) => hm(x.start)).join(", ")})`);
ok(pel.some((x) => { const m = ((x.start / 60) + 360) % 1440; return m >= 14 * 60 && m < 15 * 60; }), "una película EMPIEZA entre las 2:00 y las 3:00 p. m.");
const pin = day.rows.find((x) => x.kind === "pin"), pm = (pin.start / 60 + 360) % 1440;
ok(pm >= 15 * 60 && pm <= 16 * 60, `el fijado se lanza dentro de su intervalo 3–4 p. m. (sale ${hm(pin.start)})`);
// categoría de cada relleno según la hora en que EMPIEZA
let bad = 0;
for (const x of day.rows.filter((q) => q.kind === "filler")) {
  const m = (Math.floor(x.start / 60) + 360) % 1440, sl = SLOTS.filter((s) => { const f = +s.from.slice(0, 2) * 60, len = ((+s.to.slice(0, 2) * 60 - f + 1440) % 1440) || 1440; return (m - f + 1440) % 1440 < len; }).pop();
  if (sl && sl.cat !== "*" && !sameCat(by.get(x.id).cat, sl.cat)) bad++;
}
ok(bad === 0, `cada programa es de la categoría de la hora en que empieza (${bad} fuera)`);
// orden de las categorías: en el orden de las franjas
const seq = day.rows.filter((x) => x.kind === "filler").map((x) => by.get(x.id).cat); const firstIdx = (c) => seq.findIndex((x) => sameCat(x, c));
ok(firstIdx("Caricaturas") < firstIdx("Informativos") && firstIdx("Informativos") < firstIdx("Películas") && firstIdx("Películas") < firstIdx("Novelas"), "orden: Caricaturas → Informativos → Películas → Novelas");
// con relleno activado SÍ hay anuncios (opción)
const r2 = buildPinnedCycle(library, { ...plan, fillAds: true });
ok(!r2.error, "con «relleno con anuncios» activado también arma el día");
// parrilla rápida: ciclo desde las 6:00 y sin cortes
const ns = normalizeSlots(SLOTS, null, (t) => +t.slice(0, 2) * 60 + +t.slice(3));
ok(ns.S === 360, "parrilla rápida sin hora actual empieza a las 6:00 a. m.");
const sch = buildSchedule({ library, plan: planWithDefaults({ breakCount: 0 }), ns, how: "old" });
ok(Object.keys(sch.durs).length === 0, "la parrilla rápida no recorta ningún programa");
ok(sch.rows.filter((x) => !x.empty).length >= 6, "todas las franjas con programas se llenan");
console.log(fails ? `\n${fails} fallos` : "\nTodo bien"); process.exit(fails ? 1 : 0);
