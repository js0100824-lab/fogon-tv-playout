import assert from "node:assert/strict";
import {
  parseDuration, fmtDuration, youtubeId, buildCycle, cycleLength, locate, cutPoints, intervalSeconds,
  compactChannel, expandChannel, describeCuts, activeAds, itemLabel
} from "../js/engine.js";
import { estimateOffset } from "../js/clock.js";

let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok -", name); };

t("duraciones y enlaces", () => {
  assert.equal(parseDuration("1:30"), 90); assert.equal(parseDuration("1:00:05"), 3605); assert.equal(parseDuration("45"), 45);
  assert.ok(Number.isNaN(parseDuration("abc")));
  assert.equal(fmtDuration(90), "1:30"); assert.equal(fmtDuration(3605), "1:00:05");
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ"); assert.equal(youtubeId("https://x.com/a.mp4"), null);
});

const lib = [
  { id: "p1", kind: "programa", title: "P1", url: "https://x/p1.mp4", duration: 100 },
  { id: "p2", kind: "programa", title: "P2", url: "https://x/p2.mp4", duration: 200 },
  { id: "p3", kind: "programa", title: "P3", url: "https://x/p3.mp4", duration: 300 },
  { id: "c1", kind: "comercial", title: "C1", url: "https://x/c1.mp4", duration: 10, active: true },
  { id: "c2", kind: "comercial", title: "C2", url: "https://x/c2.mp4", duration: 20, active: true },
  { id: "c3", kind: "comercial", title: "C3", url: "https://x/c3.mp4", duration: 30, active: false }
];

t("modo «entre programas» sigue funcionando", () => {
  const cyc = buildCycle(lib, { order: ["p1", "p2", "p3"], mode: "programs", everyN: 1, breakCount: 2 });
  assert.deepEqual(cyc.map((i) => i.id), ["p1", "c1", "c2", "p2", "c1", "c2", "p3", "c1", "c2"]);
  assert.equal(cycleLength(cyc), 600 + 3 * 30);
  assert.ok(!cyc.some((i) => i.id === "c3"));
});

t("puntos de corte: video de 30 min cada 10 min", () => {
  assert.deepEqual(cutPoints(1800, { intervalValue: 10, intervalUnit: "m", minTailSec: 15 }), [600, 1200]);
  assert.deepEqual(cutPoints(1800, { intervalValue: 600, intervalUnit: "s", minTailSec: 15 }), [600, 1200]);
  assert.deepEqual(cutPoints(1800, { intervalValue: 20, intervalUnit: "s", minTailSec: 0 }).length, 89);
  assert.deepEqual(cutPoints(500, { intervalValue: 10, intervalUnit: "m", minTailSec: 15 }), []);
  assert.deepEqual(cutPoints(1210, { intervalValue: 10, intervalUnit: "m", minTailSec: 15 }), [600], "no corta si queda menos que el margen");
  assert.equal(intervalSeconds({ intervalValue: 1.5, intervalUnit: "m" }), 90);
  assert.equal(intervalSeconds({ intervalValue: 0, intervalUnit: "m" }), 0);
});

t("un programa de 30 min se parte en 3 tramos con anuncios en medio", () => {
  const L = [{ id: "m", kind: "programa", title: "Película", url: "https://x/m.mp4", duration: 1800 }, lib[3], lib[4]];
  const plan = { order: ["m"], mode: "time", intervalValue: 10, intervalUnit: "m", breakCount: 2, breakRepeat: 1, breakAtEnd: false };
  const cyc = buildCycle(L, plan);
  assert.deepEqual(cyc.map((i) => `${i.id}${i.startAt ? "@" + i.startAt : ""}`), ["m", "c1", "c2", "m@600", "c1", "c2", "m@1200"]);
  const progs = cyc.filter((i) => i.type === "programa");
  assert.deepEqual(progs.map((i) => i.duration), [600, 600, 600]);
  assert.equal(progs.reduce((a, i) => a + i.duration, 0), 1800, "los tramos suman el video completo");
  assert.equal(progs[1].part, 2); assert.equal(progs[1].parts, 3);
  assert.equal(itemLabel(progs[1]), "Película · parte 2 de 3");
  // con corte al final
  const c2 = buildCycle(L, { ...plan, breakAtEnd: true });
  assert.equal(c2.at(-1).type, "comercial"); assert.equal(c2.filter((i) => i.type === "comercial").length, 6);
});

t("tanda repetida: A,B,C se repite 3 veces en cada corte", () => {
  const ads = ["a", "b", "c", "d"].map((x, i) => ({ id: x, kind: "comercial", title: x, url: "https://x/" + x, duration: 5 + i }));
  const L = [{ id: "m", kind: "programa", title: "M", url: "https://x/m.mp4", duration: 100 }, ...ads];
  const cyc = buildCycle(L, { order: ["m"], mode: "time", intervalValue: 50, intervalUnit: "s", breakCount: 3, breakRepeat: 3, breakAtEnd: false, minTailSec: 5 });
  assert.deepEqual(cyc.map((i) => i.id).join(""), "m" + "abcabcabc" + "m");
  const c2 = buildCycle(L, { order: ["m"], mode: "time", intervalValue: 30, intervalUnit: "s", breakCount: 2, breakRepeat: 1, breakAtEnd: true, minTailSec: 5 });
  // la rotación continúa entre cortes: ab, cd, ab, cd
  assert.deepEqual(c2.filter((i) => i.type === "comercial").map((i) => i.id).join(""), "abcdabcd");
});

t("orden manual de anuncios y anuncios inactivos", () => {
  const ads = activeAds(lib, { adOrder: ["c2", "c1"] });
  assert.deepEqual(ads.map((a) => a.id), ["c2", "c1"]);
  const none = buildCycle(lib.filter((i) => i.kind !== "comercial"), { order: ["p1"], mode: "time", intervalValue: 10, intervalUnit: "s", breakCount: 2 });
  assert.equal(none.length, 1, "sin anuncios no hay cortes, el programa queda completo");
  assert.equal(none[0].duration, 100);
});

t("después de los anuncios el programa continúa donde se quedó", () => {
  const L = [{ id: "m", kind: "programa", title: "M", url: "https://x/m.mp4", duration: 120 }, lib[3]];
  const cyc = buildCycle(L, { order: ["m"], mode: "time", intervalValue: 60, intervalUnit: "s", breakCount: 1, breakAtEnd: false, minTailSec: 5 });
  // tramos: m 0-60 | c1 (10 s) | m 60-120
  const e = 1_000_000;
  let l = locate(cyc, e, e + 59_000); assert.equal(l.item.id, "m"); assert.equal(l.filePos, 59);
  l = locate(cyc, e, e + 62_000); assert.equal(l.item.id, "c1"); assert.equal(l.offset, 2);
  l = locate(cyc, e, e + 70_000); assert.equal(l.item.id, "m"); assert.equal(l.filePos, 60, "reanuda en el segundo 60 del archivo");
  l = locate(cyc, e, e + 100_000); assert.equal(l.filePos, 90);
  l = locate(cyc, e, e + 130_000); assert.equal(l.item.id, "m"); assert.equal(l.filePos, 0, "ciclo completo -> reinicia");
  l = locate(cyc, e, e - 10_000); assert.equal(l.item.id, "m"); assert.equal(l.filePos, 110);
  assert.equal(locate([], e, e), null);
});

t("formato compacto: ida y vuelta y tamaño razonable", () => {
  const L = [{ id: "m", kind: "programa", title: "Película", url: "https://res.cloudinary.com/demo/video/upload/v1/pelicula.mp4", duration: 3600 }, lib[3], lib[4]];
  const cyc = buildCycle(L, { order: ["m"], mode: "time", intervalValue: 20, intervalUnit: "s", breakCount: 2, breakRepeat: 3, breakAtEnd: true, minTailSec: 5 });
  assert.ok(cyc.length > 1000, "muchos tramos: " + cyc.length);
  const back = expandChannel(compactChannel(cyc));
  assert.deepEqual(back.map((i) => [i.id, i.type, i.startAt, i.duration]), cyc.map((i) => [i.id, i.type, i.startAt, i.duration]));
  const bytes = JSON.stringify(compactChannel(cyc)).length;
  assert.ok(bytes < 400_000, "cabe en un documento de Firestore (1 MB): " + bytes + " bytes");
  assert.deepEqual(expandChannel({ items: [{ id: "x" }] }), [{ id: "x" }], "acepta el formato antiguo");
});

t("resumen de cortes para el panel", () => {
  const L = [{ id: "m", kind: "programa", title: "M", url: "https://x/m.mp4", duration: 1800 }];
  const d = describeCuts(L, { order: ["m"], mode: "time", intervalValue: 10, intervalUnit: "m", breakAtEnd: true });
  assert.deepEqual(d[0].cuts, [600, 1200]); assert.equal(d[0].end, true);
});

t("reloj del servidor: la mejor muestra es la de menor redondeo", () => {
  // servidor real = local + 5000 ms. La cabecera redondea hacia abajo (f = 0..999 ms).
  const real = 5000;
  const mk = (localMs, f) => ({ localMs, serverMs: localMs + real - f });
  const est = estimateOffset([mk(1e6, 700), mk(1e6 + 300, 120), mk(1e6 + 900, 950), mk(1e6 + 1500, 410)]);
  assert.ok(est <= real && real - est < 150, "error < 150 ms, fue " + (real - est));
  assert.equal(estimateOffset([]), null);
});

console.log(`${n} pruebas del motor correctas.`);
