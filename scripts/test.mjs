import assert from "node:assert/strict";
import { parseDuration, fmtDuration, youtubeId, buildCycle, cycleLength, locate } from "../js/engine.js";

assert.equal(parseDuration("1:30"), 90);
assert.equal(parseDuration("1:00:05"), 3605);
assert.equal(parseDuration("45"), 45);
assert.ok(Number.isNaN(parseDuration("abc")));
assert.equal(fmtDuration(90), "1:30");
assert.equal(fmtDuration(3605), "1:00:05");
assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(youtubeId("https://x.com/a.mp4"), null);

const lib = [
  { id: "p1", kind: "programa", title: "P1", url: "https://x/p1.mp4", duration: 100 },
  { id: "p2", kind: "programa", title: "P2", url: "https://x/p2.mp4", duration: 200 },
  { id: "p3", kind: "programa", title: "P3", url: "https://x/p3.mp4", duration: 300 },
  { id: "c1", kind: "comercial", title: "C1", url: "https://x/c1.mp4", duration: 10, active: true },
  { id: "c2", kind: "comercial", title: "C2", url: "https://x/c2.mp4", duration: 20, active: true },
  { id: "c3", kind: "comercial", title: "C3", url: "https://x/c3.mp4", duration: 30, active: false }
];
const cyc = buildCycle(lib, { order: ["p1", "p2", "p3"], everyN: 1, breakCount: 2 });
assert.deepEqual(cyc.map((i) => i.id), ["p1", "c1", "c2", "p2", "c1", "c2", "p3", "c1", "c2"]);
assert.equal(cycleLength(cyc), 600 + 6 * 15);
assert.ok(!cyc.some((i) => i.id === "c3"));

const noAds = buildCycle(lib, { order: ["p1", "p2"], everyN: 0, breakCount: 2 });
assert.equal(noAds.length, 2);

const e = 1_000_000;
let l = locate(noAds, e, e + 50_000);
assert.equal(l.item.id, "p1"); assert.equal(l.offset, 50);
l = locate(noAds, e, e + 100_000);
assert.equal(l.item.id, "p2"); assert.equal(l.offset, 0);
l = locate(noAds, e, e + 300_000); // ciclo completo -> reinicia
assert.equal(l.item.id, "p1"); assert.equal(l.offset, 0);
l = locate(noAds, e, e - 10_000); // antes del epoch
assert.equal(l.item.id, "p2"); assert.equal(l.offset, 190);
assert.equal(locate([], e, e), null);
console.log("Pruebas del motor correctas.");
