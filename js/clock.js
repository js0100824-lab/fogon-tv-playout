// Reloj del servidor: todos los dispositivos (panel, vista previa y espectadores) calculan
// "qué toca ahora" con la misma hora, sin depender de que su reloj esté bien puesto.
// Se obtiene de la cabecera HTTP "Date" del propio sitio (GitHub Pages). Esa cabecera viene
// redondeada hacia abajo al segundo, así que se toman varias muestras y se queda la mejor.
let offsetMs = 0, synced = false, syncing = null;

export const serverNow = () => Date.now() + offsetMs;
export const clockInfo = () => ({ synced, offsetMs });

export function estimateOffset(samples) {
  // cada muestra: serverMs (de la cabecera, ya sumada la edad) y localMs (punto medio de la petición)
  // serverReal = serverMs + f, con f entre 0 y 1000 ms  =>  (serverMs - localMs) = offset - f
  // El máximo de las muestras es la que tiene el menor f, la más cercana al offset real.
  if (!samples.length) return null;
  return Math.max(...samples.map((s) => s.serverMs - s.localMs));
}

async function sample(url) {
  const w0 = Date.now(), p0 = performance.now();
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}_c=${Math.random().toString(36).slice(2)}`, { method: "HEAD", cache: "no-store" });
  const p1 = performance.now();
  const d = res.headers.get("date");
  if (!d) return null;
  const age = Number(res.headers.get("age")) || 0;
  const serverMs = Date.parse(d) + age * 1000;
  if (!Number.isFinite(serverMs)) return null;
  return { serverMs, localMs: w0 + (p1 - p0) / 2 };
}

export function syncClock(count = 7) {
  if (syncing) return syncing;
  syncing = (async () => {
    const url = new URL("./clock.js", import.meta.url).href;
    const got = [];
    for (let i = 0; i < count; i++) {
      try { const s = await sample(url); if (s) got.push(s); } catch { /* se ignora */ }
      await new Promise((r) => setTimeout(r, 90 + Math.random() * 260));   // fases distintas dentro del segundo
    }
    const est = estimateOffset(got);
    if (est !== null) { offsetMs = est; synced = true; }
    return synced;
  })().finally(() => { syncing = null; });
  return syncing;
}

// Primera sincronización con tope de espera; luego se repite cada 10 minutos.
export async function startClock(maxWaitMs = 4000) {
  await Promise.race([syncClock(), new Promise((r) => setTimeout(r, maxWaitMs))]);
  setInterval(() => syncClock(5), 10 * 60 * 1000);
}
