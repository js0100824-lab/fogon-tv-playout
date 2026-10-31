// Pruebas de los programas fijados: node scripts/test-pins.mjs
import { buildPinnedCycle, planWithDefaults, locate, cycleLength, pinDays, pinEpoch, pinDayIndex, DAY_SEC, DAY_MS, PIN_ANCHOR_MS, compactChannel, expandChannel } from "../js/engine.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("  ✗", m); } else console.log("  ✓", m); };
const min = (n) => n * 60;
const mk = (id, dur) => ({ id, title: id, kind: "programa", cat: "x", duration: dur, url: "x.mp4", active: true });
const lib = []; for (let i = 0; i < 14; i++) lib.push(mk(`p${i}`, min(22 + (i * 7) % 40)));
const ads = [1, 2, 3].map((n) => ({ id: `ad${n}`, title: `ad${n}`, kind: "comercial", url: "a.mp4", duration: 20 + n * 5, active: true }));
const library = [...lib, ...ads];
const line = (id, dur) => ({ id, url: `https://x/${id}.mp4`, duration: dur, title: id });
const pins = [
  { id: "am", title: "Matutino", from: "07:00", to: "09:00", tolMin: 5, lines: [line("a", min(95)), line("b", min(110)), line("c", min(100))] },
  { id: "nt", title: "Noticiero 2PM", from: "14:00", to: "15:00", tolMin: 5, lines: [line("a", min(50)), line("b", min(55))] },
  { id: "n9", title: "Noticiero 9PM", from: "21:00", to: "22:00", tolMin: 0, lines: [line("a", min(58))] }
];
const plan = planWithDefaults({ mode: "continuous", intervalValue: 10, intervalUnit: "m", breakCount: 2, order: lib.map((i) => i.id), pins });
const t0 = Date.now(); const r = buildPinnedCycle(library, plan); const ms = Date.now() - t0;
console.log(`Construido en ${ms} ms`);
ok(!r.error, "sin error");
ok(r.K === 6, `rotación de 6 días (mcm de 3,2,1) → ${r.K}`);
ok(pinDays(pins) === 6, "pinDays = 6");
for (let d = 0; d < r.K; d++) {
  const day = r.days[d], tot = cycleLength(day.items);
  ok(Math.abs(tot - DAY_SEC) < 0.01, `día ${d + 1}: dura exactamente 24 h (${tot})`);
  for (const p of pins) {
    const row = day.rows.find((x) => x.kind === "pin" && x.pin === p.id);
    const f = +p.from.slice(0, 2) * 3600, tol = p.tolMin * 60;
    ok(row && row.delta <= 0.001 && row.delta >= -tol - 1, `día ${d + 1} · ${p.title}: sale ${Math.round(row?.delta)} s respecto a su hora (tolerancia ${p.tolMin} min)`);
    ok(row && row.lineNo === (d % p.lines.length) + 1, `día ${d + 1} · ${p.title}: línea ${row?.lineNo}`);
  }
  ok(day.rows.every((x, k, a) => k === 0 || x.start >= a[k - 1].end - 0.01), `día ${d + 1}: filas sin solaparse`);
}
// El fijado nunca se mueve: en un cambio de parrilla sigue en su hora
const plan2 = { ...plan, order: [...plan.order].reverse().slice(3) };
const r2 = buildPinnedCycle(library, plan2);
ok(r2.days.every((day) => ["am", "nt", "n9"].every((id) => { const row = day.rows.find((x) => x.pin === id); const p = pins.find((q) => q.id === id); const f = +p.from.slice(0, 2) * 3600; return row.delta <= 0.001 && row.delta >= -p.tolMin * 60 - 1; })), "con otra parrilla los fijados siguen en su hora");
// El reloj: a la hora fija suena el fijado
const now0 = pinEpoch(PIN_ANCHOR_MS + 3 * DAY_MS + 5 * 3600e3, r.K);
for (const dayN of [0, 1, 2, 3, 4, 5]) {
  const abs = PIN_ANCHOR_MS + (60 + dayN) * DAY_MS, ep = pinEpoch(abs, r.K), di = pinDayIndex(abs, r.K);
  const at = (h, m) => locate(r.items, ep, abs + (h * 60 + m) * 60000 + 30000);
  const prog = (loc) => { let k = loc.index; while (k > 0 && r.items[k].type !== "programa") k--; return { item: r.items[k] }; };   // si suena un anuncio dentro del fijado, cuenta el programa al que pertenece
  const a = prog(at(7, 30)), b = prog(at(14, 20)), c = prog(at(21, 10));
  ok(a.item.id.startsWith("pin_am_") && b.item.id.startsWith("pin_nt_") && c.item.id.startsWith("pin_n9_"), `reloj día ${di + 1}: 7:30 → ${a.item.id}, 14:20 → ${b.item.id}, 21:10 → ${c.item.id}`);
}
// Se guarda y se lee igual
const ex = expandChannel(compactChannel(r.items)); ok(ex.length === r.items.length && Math.abs(cycleLength(ex) - r.K * DAY_SEC) < 0.05, `formato compacto: ${ex.length} tramos, ${Math.round(JSON.stringify(compactChannel(r.items)).length / 1024)} KB`);
// Sin fijados / sin parrilla
ok(buildPinnedCycle(library, { ...plan, pins: [] }) === null, "sin fijados → null (se usa el ciclo de siempre)");
ok(!!buildPinnedCycle(library, { ...plan, order: [] }).error, "sin parrilla → error claro");
// Un fijado más largo que su franja empuja al siguiente pero el día sigue cerrando a las 24 h
const long = [{ id: "L", title: "Largo", from: "10:00", to: "11:00", tolMin: 0, lines: [line("a", min(150))] }, { id: "M", title: "Medio", from: "11:30", to: "12:00", tolMin: 0, lines: [line("a", min(30))] }];
const r3 = buildPinnedCycle(library, { ...plan, pins: long });
ok(Math.abs(cycleLength(r3.days[0].items) - DAY_SEC) < 0.01, "fijado que se pasa de su franja: el día igual cierra a las 24 h");
ok(r3.days[0].rows.find((x) => x.pin === "M").delta > 0, "el siguiente fijado sale tarde (lo avisa el panel)");
console.log(fails ? `\n${fails} fallos` : "\nTodo bien"); process.exit(fails ? 1 : 0);
