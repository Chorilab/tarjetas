-- Ejecuta este script UNA vez en Supabase → SQL Editor.
-- La tabla guarda versiones numeradas de la base de datos YA CIFRADA.
-- El rol anónimo solo puede LEER y AGREGAR versiones; no puede modificar ni borrar.

create table if not exists public.vault (
  rev        integer primary key check (rev > 0),
  data       jsonb   not null check (octet_length(data::text) < 2000000),
  created_at timestamptz not null default now()
);

alter table public.vault enable row level security;

drop policy if exists "leer versiones"   on public.vault;
drop policy if exists "agregar versiones" on public.vault;

create policy "leer versiones"    on public.vault for select to anon using (true);
create policy "agregar versiones" on public.vault for insert to anon with check (true);

revoke update, delete, truncate on public.vault from anon;
grant select, insert on public.vault to anon;
