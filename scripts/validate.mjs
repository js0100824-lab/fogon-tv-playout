// Validación sin dependencias: sintaxis de los módulos JS y archivos obligatorios.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const required = [
  "index.html", "admin/index.html", "player/index.html",
  "js/firebase-config.js", "js/firebase.js", "js/admin.js", "js/engine.js", "js/player.js", "scripts/test.mjs",
  "firestore.rules", "storage.rules", "firebase.json", "README.md", ".gitignore"
];
let failed = false;
for (const f of required) {
  if (!existsSync(f)) { console.error("Falta el archivo:", f); failed = true; }
}
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n.startsWith(".git")) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const f of walk(".").filter((p) => p.endsWith(".js") || p.endsWith(".mjs"))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { console.error("Error de sintaxis en", f, "\n", r.stderr); failed = true; }
}
const t = spawnSync(process.execPath, ["scripts/test.mjs"], { encoding: "utf8" });
if (t.status !== 0) { console.error(t.stdout, t.stderr); failed = true; }
if (failed) process.exit(1);
console.log("Validación correcta.");
