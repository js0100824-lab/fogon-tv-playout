# Fogón TV Playout

Canal de TV automatizado: biblioteca, parrilla, cortes comerciales, reproductor público sincronizado, personalización y estadísticas.

- Panel: `/admin/` · Reproductor público: `/player/`
- Todos ven lo mismo al mismo tiempo: la posición se calcula con la hora del servidor, a partir de la hora de inicio guardada al publicar por primera vez.
- Pruebas del motor: `npm test` (también corre en GitHub Actions).

## Uso
1. Biblioteca: agrega programas y comerciales con su enlace (YouTube o .mp4/.webm) y duración.
2. Control comercial: elige cada cuántos programas hay corte, cuántos comerciales, y cuáles están activos.
3. Programación: ordena los programas. Al terminar el ciclo vuelve a empezar.
4. Pulsa **Publicar emisión**. El reproductor se actualiza solo.
5. Personalización: nombre, color, logotipo y rótulo.

## Reglas
Después de actualizar, **vuelve a pegar `firestore.rules` en Firebase → Firestore → Reglas → Publicar** (se añadió la colección `stats`).

## Subir videos (Firebase Storage)
El panel sube archivos a Firebase Storage. Google exige el plan **Blaze** (pago por uso, con cuota gratuita mensual y tarjeta requerida) para activarlo:
1. Firebase → Storage → Comenzar (te pedirá cambiar a Blaze).
2. Pestaña Reglas de Storage: pega el contenido de `storage.rules` y Publicar.
Mientras tanto puedes usar enlaces (YouTube o .mp4 alojado en otro sitio).

## Límites
- Los navegadores bloquean el sonido automático: el espectador toca una vez para activarlo.
- La sincronización usa la hora del servidor (cabecera HTTP del propio sitio), no el reloj del dispositivo del espectador.
