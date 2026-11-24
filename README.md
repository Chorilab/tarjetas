# CHORILAB · Tarjetas de regalo + Caja (POS)

Web estática para GitHub Pages. Los datos se cifran en el navegador (AES-GCM 256) y se guardan en Supabase.

## Archivos
`index.html`, `styles.css`, `app.js`, `config.js`, `supabase.sql`, `.nojekyll`, `README.md`

## Qué incluye
- **Caja (POS)**: toca productos para armar el pedido, cobra en mostrador (efectivo con cálculo de cambio, o transferencia) o con la tarjeta de regalo del cliente (el cliente confirma con su clave). Ticket imprimible.
  Si el pedido supera el saldo de la tarjeta, la tarjeta cubre lo que tenga y el resto se completa en efectivo o transferencia (pago combinado). El ticket muestra ambos pagos.
- **Menú**: el administrador lo edita (nombre, descripción, precio, categoría, visible/oculto). Los clientes lo ven en su pestaña "Menú" y se actualiza solo (cada 15 s o con ↻ Actualizar). Los productos agotados se marcan.
- **Inventario**: stock por producto (opcional), alerta de stock bajo, entradas, mermas y conteos con historial. Las ventas descuentan stock y se devuelve al rechazar o anular.
- **Clientes**: búsqueda, orden por saldo o última visita, ficha con totales, ticket promedio, notas internas y edición.
- **Resumen**: ventas del día, ticket promedio, más vendidos y alertas de inventario.

## Puesta en marcha
1. Crea un proyecto gratis en https://supabase.com.
2. En **SQL Editor** pega y ejecuta `supabase.sql`.
3. En **Project Settings → API** copia la *Project URL* y la clave *anon / publishable*.
4. Pégalas en `config.js`.
5. En GitHub crea un repositorio (puede ser público) y sube todos los archivos a la raíz.
6. **Settings → Pages → Deploy from a branch → main / (root)**. Espera un minuto: tu web queda en `https://USUARIO.github.io/REPOSITORIO/`.
7. Abre la web: la primera vez te pide crear el administrador (usuario y clave de mínimo 8 caracteres). Luego inicia sesión y crea clientes.

## Actualizar una instalación existente
Reemplaza solo `app.js` y `styles.css` (y este README). No hay que tocar Supabase ni `supabase.sql`: los datos viejos se completan solos con los campos nuevos (stock, descripción, visible).

## Mantenimiento
- Cada guardado crea una versión nueva (`rev`). Para limpiar, en SQL Editor: `delete from public.vault where rev < (select max(rev) from public.vault) - 200;`
- Para volver atrás: borra en la tabla las versiones malas más recientes (desde Table Editor).
- Descarga la copia cifrada desde Ajustes con frecuencia.
- Supabase gratis pausa proyectos tras 1 semana sin uso; entra al panel para reactivarlo.
