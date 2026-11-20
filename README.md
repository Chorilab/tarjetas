# CHORILAB · Tarjetas de regalo

Web estática para GitHub Pages. Los datos se cifran en el navegador (AES-GCM 256) y se guardan en Supabase.

## Archivos
`index.html`, `styles.css`, `app.js`, `config.js`, `supabase.sql`, `.nojekyll`, `README.md`

## Puesta en marcha
1. Crea un proyecto gratis en https://supabase.com.
2. En **SQL Editor** pega y ejecuta `supabase.sql`.
3. En **Project Settings → API** copia la *Project URL* y la clave *anon / publishable*.
4. Pégalas en `config.js`.
5. En GitHub crea un repositorio (puede ser público) y sube todos los archivos a la raíz.
6. **Settings → Pages → Deploy from a branch → main / (root)**. Espera un minuto: tu web queda en `https://USUARIO.github.io/REPOSITORIO/`.
7. Abre la web: la primera vez te pide crear el administrador (usuario y clave de mínimo 8 caracteres). Luego inicia sesión y crea clientes.

## Mantenimiento
- Cada guardado crea una versión nueva (`rev`). Para limpiar, en SQL Editor: `delete from public.vault where rev < (select max(rev) from public.vault) - 200;`
- Para volver atrás: borra en la tabla las versiones malas más recientes (desde Table Editor).
- Descarga la copia cifrada desde Ajustes con frecuencia.
- Supabase gratis pausa proyectos tras 1 semana sin uso; entra al panel para reactivarlo.
