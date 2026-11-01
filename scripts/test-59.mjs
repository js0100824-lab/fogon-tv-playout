// Fin en :59 = hora siguiente en punto. node scripts/test-59.mjs
import { pinWindow, normalizeSlots, endMinOf } from "../js/engine.js";
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("  ✗", m); } else console.log("  ✓", m); };
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
ok(endMinOf(179) === 180 && endMinOf(180) === 180 && endMinOf(1439) === 1440, "endMinOf: 2:59 → 3:00, 3:00 igual, 23:59 → 24:00");
ok(pinWindow({ from: "01:00", to: "02:59" }).t === 180, "fijado «hasta 2:59» termina a las 3:00");
ok(pinWindow({ from: "22:00", to: "23:59" }).t === 1440, "fijado «hasta 11:59 PM» llega a medianoche");
ok(pinWindow({ from: "14:00", to: "15:00" }).t === 900, "fijado «hasta 3:00» sigue igual");
const n = normalizeSlots([{ from: "06:00", to: "09:59", cat: "A" }, { from: "10:00", to: "13:59", cat: "B" }], 360, toMin);
ok(n.slots[0].end - n.slots[0].start === 240 && n.slots[1].end - n.slots[1].start === 240 && n.slots[0].end === n.slots[1].start, "franjas 6:00–9:59 y 10:00–13:59: 4 h cada una, sin hueco entre ellas");
console.log(fails ? `\n${fails} fallos` : "\nTodo bien"); process.exit(fails ? 1 : 0);
