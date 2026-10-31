// Pruebas de los programas fijados: node scripts/test-pins.mjs
import { distributePad, buildPinnedCycle, planWithDefaults, locate, cycleLength, pinEpoch, pinDayIndex, DAY_SEC, DAY_MS, PIN_ANCHOR_MS, compactChannel, expandChannel } from "../js/engine.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("  ✗", m); } else console.log("  ✓", m); };
const min = (n) => n * 60;
const SLOTS = [
  { from: "06:00", to: "10:00", cat: "Caricaturas" }, { from: "10:00", to: "14:00", cat: "Informativos" },
  { from: "14:00", to: "18:00", cat: "Entretenimiento" }, { from: "18:00", to: "22:00", cat: "Novelas" },
  { from: "22:00", to: "00:00", cat: "Informativos" }, { from: "00:00", to: "02:00", cat: "Películas" }, { from: "02:00", to: "06:00", cat: "*" }
];
const mk = (id, cat, dur) => ({ id, title: id, kind: "programa", cat, duration: dur, url: "x.mp4", active: true });
const lib = [];
for (let i = 0; i < 4; i++) lib.push(mk(`car${i}`, "Caricaturas", min(23 + i)));
for (let i = 0; i < 5; i++) lib.push(mk(`inf${i}`, "Informativos", min(32 + i * 6)));
lib.push(mk("Escuadron Informativo", "Informativos", min(44)));
for (let i = 0; i < 5; i++) lib.push(mk(`ent${i}`, "Entretenimiento", min(41 + i * 3)));
for (let i = 0; i < 5; i++) lib.push(mk(`nov${i}`, "Novelas", min(52 + i * 7)));
for (let i = 0; i < 4; i++) lib.push(mk(`pel${i}`, "Películas", min(95 + i * 9)));
for (let i = 0; i < 3; i++) lib.push(mk(`var${i}`, "Variedades", min(30 + i * 10)));
const ads = [1, 2, 3].map((n) => ({ id: `ad${n}`, title: `ad${n}`, kind: "comercial", url: "a.mp4", duration: 20 + n * 5, active: true }));
const library = [...lib, ...ads], fullOf = new Map(library.map((i) => [i.id, i.duration]));
const line = (id, dur) => ({ id, url: `https://x/${id}.mp4`, duration: dur, title: id });
const pins = [
  { id: "am", title: "Matutino", from: "07:00", to: "09:00", tolMin: 10, lines: [line("a", min(95)), line("b", min(110)), line("c", min(100))] },
  { id: "n1", title: "Noticiero 12", from: "12:00", to: "13:00", tolMin: 10, lines: [line("a", min(55))] },
  { id: "nt", title: "Noticiero 2PM", from: "14:00", to: "15:00", tolMin: 10, lines: [line("a", min(50)), line("b", min(55))] },
  { id: "k4", title: "Película 4PM", from: "16:00", to: "18:00", tolMin: 10, lines: [line("a", min(110))] },
  { id: "n9", title: "Noticiero 9PM", from: "21:00", to: "22:00", tolMin: 0, lines: [line("a", min(58))] }
];
const plan = planWithDefaults({ mode: "continuous", intervalValue: 10, intervalUnit: "m", breakCount: 2, order: lib.map((i) => i.id), pins, slots: SLOTS });
const t0 = Date.now(); const r = buildPinnedCycle(library, plan); console.log(`Construido en ${Date.now() - t0} ms`);
ok(!r.error, "sin error " + (r.error || ""));
const catAt = (sec) => { const m = Math.floor(sec / 60) % 1440; const s = SLOTS.find((x) => { const f = +x.from.slice(0, 2) * 60, len = ((+x.to.slice(0, 2) * 60 - f + 1440) % 1440) || 1440; return ((m - f + 1440) % 1440) < len; }); return s?.cat; };
let wrongCat = 0, fillRows = 0;
for (let d = 0; d < r.K; d++) {
  const day = r.days[d], tot = cycleLength(day.items);
  ok(Math.abs(tot - DAY_SEC) < 0.01, `día ${d + 1}: dura exactamente 24 h (${tot})`);
  for (const p of pins) {
    const row = day.rows.find((x) => x.kind === "pin" && x.pin === p.id), tol = p.tolMin * 60;
    ok(row && Math.abs(row.delta) <= tol + 1, `día ${d + 1} · ${p.title}: sale ${Math.round(row?.delta)} s respecto a su hora (margen ±${p.tolMin} min)`);
  }
  // NINGÚN programa se corta: cada emisión suma su duración completa
  const bad = []; let cur = null;
  for (const it of day.items) {
    if (it.type !== "programa") continue;
    if (!it.part || it.part === 1) { if (cur) bad.push(cur); cur = { id: it.id, sum: 0 }; }
    cur.sum += it.duration;
  }
  if (cur) bad.push(cur);
  const cut = bad.filter((x) => Math.abs(x.sum - (fullOf.get(x.id) ?? x.sum)) > 0.01);
  ok(!cut.length, `día ${d + 1}: ningún programa cortado ${cut.length ? JSON.stringify(cut) : ""}`);
  for (const row of day.rows) if (row.kind === "filler") { fillRows++; const cat = lib.find((i) => i.id === row.id).cat; if (cat !== catAt(row.start) && catAt(row.start) !== "*") wrongCat++; }
  ok(day.rows.every((x, k, a) => k === 0 || x.start >= a[k - 1].end - 0.01), `día ${d + 1}: filas sin solaparse`);
}
ok(wrongCat / fillRows <= 0.05, `categoría correcta en el hueco: ${fillRows - wrongCat} de ${fillRows} (${wrongCat} fuera)`);
// El reloj: a la hora fija suena el fijado
for (const dayN of [0, 1, 2]) {
  const abs = PIN_ANCHOR_MS + (60 + dayN) * DAY_MS, ep = pinEpoch(abs, r.K), di = pinDayIndex(abs, r.K);
  const prog = (h, m) => { const loc = locate(r.items, ep, abs + (h * 60 + m) * 60000 + 30000); let k = loc.index; while (k > 0 && r.items[k].type !== "programa") k--; return r.items[k].id; };
  ok(prog(7, 30).startsWith("pin_am_") && prog(12, 20).startsWith("pin_n1_") && prog(14, 20).startsWith("pin_nt_") && prog(16, 30).startsWith("pin_k4_") && prog(21, 10).startsWith("pin_n9_"), `reloj día ${di + 1}: los 5 fijados suenan en su hora`);
}
const ex = expandChannel(compactChannel(r.items)); ok(ex.length === r.items.length && Math.abs(cycleLength(ex) - r.K * DAY_SEC) < 0.05, `formato compacto: ${ex.length} tramos, ${Math.round(JSON.stringify(compactChannel(r.items)).length / 1024)} KB`);
// Pegados: uno termina a las 4 y el otro fijado empieza a las 4 → nada en medio
const touch = [{ id: "a", title: "A", from: "15:00", to: "16:00", tolMin: 0, lines: [line("a", min(60))] }, { id: "b", title: "B", from: "16:00", to: "17:00", tolMin: 0, lines: [line("a", min(60))] }];
const rt = buildPinnedCycle(library, { ...plan, pins: touch }), dayT = rt.days[0].rows, ia = dayT.findIndex((x) => x.pin === "a");
ok(dayT[ia + 1].pin === "b" && Math.abs(dayT[ia + 1].start - dayT[ia].end) < 1, "un fijado termina a las 4 y el siguiente empieza a las 4: no se mete nada en medio");
// Sin fijados / sin parrilla / sin anuncios
ok(buildPinnedCycle(library, { ...plan, pins: [] }) === null, "sin fijados → null (se usa el ciclo de siempre)");
ok(!!buildPinnedCycle(library, { ...plan, order: [] }).error, "sin parrilla → error claro");
ok(/anuncio/.test(buildPinnedCycle(lib, plan).error || ""), "sin anuncios y con huecos → error claro (no corta programas)");
// Sin margen: se rellena con anuncios y el fijado sale EXACTO
const exact = buildPinnedCycle(library, { ...plan, pins: pins.map((p) => ({ ...p, tolMin: 0 })) });
ok(exact.days.every((day) => day.rows.filter((x) => x.kind === "pin").every((x) => Math.abs(x.delta) < 1)), "margen 0: todos los fijados salen exactos a su hora (con anuncios de relleno)");
// Fijado más largo que su franja: empuja al siguiente pero el día igual cierra a las 24 h
const long = [{ id: "L", title: "Largo", from: "10:00", to: "11:00", tolMin: 0, lines: [line("a", min(150))] }, { id: "M", title: "Medio", from: "11:30", to: "12:00", tolMin: 0, lines: [line("a", min(30))] }];
const r3 = buildPinnedCycle(library, { ...plan, pins: long });
ok(Math.abs(cycleLength(r3.days[0].items) - DAY_SEC) < 0.01, "fijado que se pasa de su franja: el día igual cierra a las 24 h");
ok(r3.days[0].rows.find((x) => x.pin === "M").delta > 0, "el siguiente fijado sale tarde (lo avisa el panel)");
// ---- Relleno repartido: el tiempo que sobra se reparte en sesiones cortas, no en un bloque enorme ----
{
  const mkP = (id, dur) => ({ id, title: id, kind: "programa", cat: "Variedades", duration: dur, url: "x.mp4", active: true });
  const progs = [mkP("p1", min(24)), mkP("p2", min(24)), mkP("p3", min(24))], lib3 = [...progs, ...ads];
  const longestAds = (items) => { let cur = 0, mx = 0; for (const it of items) { if (it.type === "comercial") { cur += it.duration; mx = Math.max(mx, cur); } else cur = 0; } return mx; };
  for (const tol of [0, 5]) {
    const pl = planWithDefaults({ mode: "continuous", intervalValue: 10, intervalUnit: "m", breakCount: 2, order: progs.map((i) => i.id), slots: [],
      pins: [{ id: "n", title: "Noticiero", from: "10:00", to: "11:00", tolMin: tol, lines: [line("a", min(55))] }] });
    const rr = buildPinnedCycle(lib3, pl), day = rr.days[0], row = day.rows.find((x) => x.kind === "pin");
    ok(row.pad > min(10), `margen ${tol} min: hay ${Math.round(row.pad / 60)} min de relleno que repartir`);
    ok(longestAds(day.items) <= min(4), `margen ${tol} min: el bloque de anuncios más largo es de ${Math.round(longestAds(day.items))} s (máx. 240 s)`);
    ok(Math.abs(row.delta) <= tol * 60 + 1, `margen ${tol} min: el fijado sigue saliendo dentro de su margen (${Math.round(row.delta)} s)`);
    ok(Math.abs(cycleLength(day.items) - DAY_SEC) < 0.01, `margen ${tol} min: el día sigue durando 24 h`);
    // ningún programa cortado, aunque se haya partido para meter sesiones
    const sums = new Map(); let curId = null;
    for (const it of day.items) { if (it.type !== "programa") continue; if (!it.part || it.part === 1) curId = `${it.id}#${sums.size}`; sums.set(curId, (sums.get(curId) || 0) + it.duration); }
    const full = new Map([...progs, { id: "pin_n_a", duration: min(55) }].map((i) => [i.id, i.duration]));
    ok([...sums].every(([k, v]) => Math.abs(v - (full.get(k.split("#")[0]) ?? v)) < 0.01), `margen ${tol} min: ningún programa cortado ni con tiempo de más`);
    const partsOk = day.items.filter((it) => it.part).every((it) => it.part >= 1 && it.part <= it.parts);
    ok(partsOk, `margen ${tol} min: las partes de los programas partidos están bien numeradas`);
  }
  // distributePad suelto: conserva todo el contenido y el total
  const gap = [{ id: "g", type: "programa", duration: 1440, startAt: 0 }], padAds = Array.from({ length: 10 }, () => ({ id: "ad1", type: "comercial", duration: 150 }));
  const res = distributePad(gap, padAds, 120);
  ok(Math.abs(cycleLength(res) - (1440 + 1500)) < 0.01, "distributePad: suma exacta (programa + anuncios)");
  ok(res.filter((x) => x.type === "programa").reduce((a, x) => a + x.duration, 0) === 1440, "distributePad: el programa conserva todos sus segundos");
  ok(res.filter((x) => x.type === "programa").every((x, k, a) => k === 0 || Math.abs(a[k - 1].startAt + a[k - 1].duration - x.startAt) < 0.001), "distributePad: cada parte continúa donde terminó la anterior");
  ok(distributePad(gap, [], 120).length === 1 && distributePad([], padAds, 120).length === 10, "distributePad: sin anuncios o sin hueco no inventa nada");
}
console.log(fails ? `\n${fails} fallos` : "\nTodo bien"); process.exit(fails ? 1 : 0);
