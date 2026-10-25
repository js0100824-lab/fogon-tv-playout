# Fogón TV Playout

Canal de TV automatizado: biblioteca, parrilla, cortes comerciales, reproductor público sincronizado, personalización y estadísticas.

- Panel: `/admin/` · Reproductor público: `/player/`
- Todos ven lo mismo al mismo tiempo: la posición se calcula con el reloj, a partir de la hora de inicio guardada al publicar por primera vez.
- Pruebas del motor: `npm test` (también corre en GitHub Actions).

## Uso
1. Biblioteca: agrega programas y comerciales con su enlace (YouTube o .mp4/.webm) y duración.
2. Control comercial: elige cada cuántos programas hay corte, cuántos comerciales, y cuáles están activos.
3. Programación: ordena los programas. Al terminar el ciclo vuelve a empezar.
4. Pulsa **Publicar emisión**. El reproductor se actualiza solo.
5. Personalización: nombre, color, logotipo y rótulo.

## Reglas
Después de actualizar, **vuelve a pegar `firestore.rules` en Firebase → Firestore → Reglas → Publicar** (se añadió la colección `stats`).

## Límites
- Los videos se enlazan por URL; subir archivos a Firebase Storage exige el plan de pago.
- Los navegadores bloquean el sonido automático: el espectador toca una vez para activarlo.
- La sincronización depende del reloj del dispositivo del espectador.
