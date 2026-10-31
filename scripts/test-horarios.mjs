// Pruebas del generador de horarios: node scripts/test-horarios.mjs
import { buildSchedule, normalizeSlots, buildCycle, cycleLength, placeNewProgram, planWithDefaults } from "../js/engine.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("  ✗", m); } else console.log("  ✓", m); };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const min = (n) => n * 60;
const SLOTS = [
  { from: "06:00", to: "10:00", cat: "Caricaturas" }, { from: "10:00", to: "14:00", cat: "Informativos" },
  { from: "14:00", to: "18:00", cat: "Entretenimiento" }, { from: "18:00", to: "22:00", cat: "Novelas" },
  { from: "22:00", to: "00:00", cat: "Informativos" }, { from: "00:00", to: "02:00", cat: "Películas" }, { from: "02:00", to: "06:00", cat: "*" }
];
const mk = (id, cat, dur) => ({ id, title: id, kind: "programa", cat, duration: dur, url: "x.mp4", active: true });
const lib = [];
for (let i = 0; i < 3; i++) lib.push(mk(`car${i}`, "Caricaturas", min(23 + i)));            // pocos: se repiten
for (let i = 0; i < 4; i++) lib.push(mk(`inf${i}`, "Informativos", min(47 + i * 5)));
for (let i = 0; i < 5; i++) lib.push(mk(`ent${i}`, "Entretenimiento", min(41 + i * 3)));
for (let i = 0; i < 4; i++) lib.push(mk(`nov${i}`, "Novelas", min(52 + i * 7)));
for (let i = 0; i < 3; i++) lib.push(mk(`pel${i}`, "Películas", min(95 + i * 9)));
const ads = [1, 2, 3].map((n) => ({ id: `ad${n}`, title: `ad${n}`, kind: "comercial", url: "a.mp4", duration: 20 + n * 5, active: true }));
const plan = planWithDefaults({ mode: "continuous", intervalValue: 10, intervalUnit: "m", breakCount: 2 });
const full = [...lib, ...ads];

function gen(S0, library = full, p = plan) {
  const ns = normalizeSlots(SLOTS, S0, toMin);
  const r = buildSchedule({ library, plan: p, ns, how: "old", rng });
  return { ns, ...r };
}
const durOf = (id) => lib.find((x) => x.id === id).duration;

console.log("1) Los programas terminan completos (solo se corta el último bloque Variado)");
for (const S0 of [null, 6 * 60, 4 * 60 + 15, 13 * 60 + 40, 23 * 60]) {
  seed = 11; const r = gen(S0);
  const cuts = Object.keys(r.durs).map(Number);
  const lastIdx = r.order.length - 1;
  ok(cuts.every((k) => k === lastIdx || r.slotMap.tailFrom >= 0 && k >= r.slotMap.tailFrom), `S=${S0 ?? "1ª franja"}: recortes solo al final del día (${cuts.length ? "índices " + cuts : "ninguno"})`);
  const lastRow = r.rows.at(-1);
  if (cuts.length) ok(lastRow.cat === "*" && cuts.every((k) => k >= lastRow.i0), `S=${S0 ?? "1ª franja"}: el recorte cae en el bloque Variado final`);
  const cyc = buildCycle(full, { ...plan, order: r.order, fit: { order: r.order, durs: r.durs } });
  const byProg = new Map();
  for (const it of cyc) if (it.type === "programa") byProg.set(it.id + "@" + r.order.indexOf(it.id), 0);
  // suma de tramos de cada posición == duración real (salvo la recortada)
  let pos = -1, acc = 0, bad = 0, idxs = [];
  for (const it of cyc) { if (it.type !== "programa") continue; if (!it.part || it.part === 1) { if (pos >= 0) idxs.push(acc); pos++; acc = 0; } acc += it.duration; }
  idxs.push(acc);
  r.order.forEach((id, n) => { if (!(n in r.durs) && Math.abs(idxs[n] - durOf(id)) > 0.01) bad++; });
  ok(bad === 0, `S=${S0 ?? "1ª franja"}: ningún programa del medio quedó más corto que su duración real`);
  if (S0 == null || S0 === 6 * 60) ok(Math.abs(cycleLength(cyc) - 86400) <= 60, `S=${S0}: el día cierra en 24 h (${(cycleLength(cyc) / 3600).toFixed(3)} h)`);
}

console.log("2) Un programa que se pasa de la hora termina completo");
{
  const L = [mk("a", "Novelas", min(45)), mk("b", "Novelas", min(45)), mk("c", "Novelas", min(45))];
  const sl = [{ from: "18:00", to: "20:00", cat: "Novelas" }, { from: "20:00", to: "21:00", cat: "Informativos" }, { from: "21:00", to: "18:00", cat: "*" }];
  const ns = normalizeSlots(sl, 18 * 60, toMin);
  const r = buildSchedule({ library: [...L, mk("i", "Informativos", min(30))], plan: planWithDefaults({ mode: "programs", everyN: 99 }), ns, how: "old", rng });
  const row = r.rows[0];
  ok(row.n === 3 && row.endAt === min(135) && !("0" in r.durs) && !("1" in r.durs) && !("2" in r.durs), `3 programas de 45 min en una franja de 2 h: el tercero empieza a los 90 y termina completo a los 135 (${row.endAt / 60} min), sin recorte`);
  const r2 = buildSchedule({ library: [mk("a", "Novelas", min(50)), mk("b", "Novelas", min(50)), mk("c", "Novelas", min(50)), mk("i", "Informativos", min(30))], plan: planWithDefaults({ mode: "programs", everyN: 99 }), ns, how: "old", rng });
  ok(r2.rows[0].n === 2 && r2.rows[0].endAt === min(100), "Si el tercero se pasaría más de lo que sobra (30 contra 20 min), no arranca: la franja siguiente empieza 20 min antes");
}

console.log("3) Repeticiones al azar y en otro orden");
{
  for (const sd of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    seed = sd;
    const L = ["A", "B", "C"].map((id, n) => mk(id, "Novelas", min(20 + n)));
    const ns = normalizeSlots([{ from: "18:00", to: "23:00", cat: "Novelas" }, { from: "23:00", to: "18:00", cat: "*" }], 18 * 60, toMin);
    const r = buildSchedule({ library: L, plan: planWithDefaults({ mode: "programs", everyN: 99 }), ns, how: "old", rng });
    const seq = r.order.slice(0, r.rows[0].n);
    const rounds = []; for (let i = 0; i + 3 <= seq.length; i += 3) rounds.push(seq.slice(i, i + 3).join(""));
    const distinct = new Set(rounds).size === rounds.length || rounds.length > 6;
    const first = rounds[0] === "ABC";
    if (sd <= 3) console.log("    semilla", sd, "→", rounds.join(" | "));
    if (!(distinct && first)) { fails++; console.log("  ✗ semilla", sd, rounds.join(" | ")); }
  }
  ok(true, "10 semillas: la primera vuelta sigue el orden elegido y ninguna vuelta repite el orden de una anterior (mientras quedan órdenes distintos)");
}

console.log("4) Programa nuevo entra en su categoría");
{
  seed = 5; const r = gen(6 * 60);
  const p = { ...plan, order: [...r.order], fit: { order: [...r.order], durs: { ...r.durs } }, slotMap: JSON.parse(JSON.stringify(r.slotMap)) };
  const before = cycleLength(buildCycle(full, p));
  const nuevo = mk("nuevaNovela", "Novelas", min(44));
  const library2 = [...full, nuevo];
  // programa al aire: el primero de Novelas
  const rowN = p.slotMap.rows.find((x) => x.cat === "Novelas");
  const res = placeNewProgram(library2, p, nuevo, rowN.i0 + 1);
  ok(res && res.at === rowN.i0 + 2, `Entra justo después del programa de Novelas al aire (posición ${res?.at})`);
  const nowRows = p.slotMap.rows.find((x) => x.cat === "Novelas");
  ok(p.order.slice(nowRows.i0, nowRows.i1).includes("nuevaNovela"), "Queda dentro del rango de la franja Novelas");
  const after = cycleLength(buildCycle(library2, p));
  ok(after <= before + 1 && after >= 86400 - 120, `El día sigue cerrando a su hora gracias al corte del último bloque (${(after / 3600).toFixed(3)} h)`);
  ok(p.order.filter((x) => x === "nuevaNovela").length === 1, "No se duplica");
  const mid = Object.keys(p.fit.durs).map(Number).filter((k) => k < p.slotMap.tailFrom);
  ok(mid.length === 0, "Ningún programa fuera del bloque final quedó recortado");
  const dep = placeNewProgram([...library2, mk("dep", "Deportes", min(30))], p, mk("dep", "Deportes", min(30)), 0);
  ok(dep && dep.cat === "Variado", "Categoría sin franja propia (Deportes): entra en el bloque Variado");
  const none = placeNewProgram(library2, p, mk("x", "Infantil", min(30)), 0);
  ok(none === null, "Categoría infantil sin franja: no se mete en Variado");
}
console.log("4b) Programa nuevo sustituye una repetición");
{
  seed = 5; const r = gen(6 * 60);
  const p = { ...plan, order: [...r.order], fit: { order: [...r.order], durs: { ...r.durs } }, slotMap: JSON.parse(JSON.stringify(r.slotMap)) };
  const uniq = new Set(p.order).size, total = p.order.length;
  const cnt = (id) => p.order.filter((x) => x === id).length;
  const repCar = p.order.filter((id, n) => id.startsWith("car") && p.order.indexOf(id) !== n);
  ok(repCar.length > 0, `Hay repeticiones de Caricaturas en el ciclo (${repCar.length})`);
  const before = Object.fromEntries(["car0", "car1", "car2"].map((id) => [id, cnt(id)]));
  const n = mk("carNueva", "Caricaturas", min(24)), lib3 = [...full, n];
  const res = placeNewProgram(lib3, p, n, 0);
  ok(res && res.replaced && p.order.length === total, `Sustituye una repetición (de «${res?.replaced}») y el ciclo no gana posiciones (${p.order.length}/${total})`);
  ok(p.order.includes("carNueva") && new Set(p.order).size === uniq + 1, "Sale en el ciclo y los originales siguen en la parrilla");
  ok(["car0", "car1", "car2"].every((id) => cnt(id) >= 1), "Ninguno de los originales desapareció (solo perdió una repetición)");
  ok(["car0", "car1", "car2"].filter((id) => cnt(id) < before[id]).length === 1, "Exactamente un original perdió una repetición");
  const air = placeNewProgram(lib3, { ...p, order: ["car0", "car1", "car0"], slotMap: null, fit: null }, mk("c9", "Caricaturas", 60), 2);
  ok(air === null, "Si la única repetición es la que está al aire, no se toca");
  const p2 = { ...plan, order: [...r.order], fit: null, slotMap: JSON.parse(JSON.stringify(r.slotMap)) };
  const n2 = mk("deporte1", "Deportes", min(30));
  const res2 = placeNewProgram([...full, n2], p2, n2, 0);
  ok(!res2 || res2.replaced === null, "Sin repeticiones de esa categoría: se suma en lugar de sustituir");
}
console.log("5) Parrilla editada a mano: respaldo");
{
  seed = 5; const r = gen(6 * 60);
  const p = { ...plan, order: [...r.order].reverse(), fit: null, slotMap: JSON.parse(JSON.stringify(r.slotMap)) };
  const n = mk("nueva2", "Entretenimiento", min(30)), res = placeNewProgram([...full, n], p, n, -1);
  const j = p.order.indexOf("nueva2");
  ok(res && p.order[j - 1].startsWith("ent"), "Entra justo después del último programa de Entretenimiento");
}
console.log(fails ? `\n${fails} fallo(s)` : "\nTodo bien"); process.exit(fails ? 1 : 0);
