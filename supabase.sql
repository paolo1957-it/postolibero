-- PostoLibero: tabella delle segnalazioni condivise.
-- Esegui questo script in Supabase → SQL Editor → New query → Run.

create table if not exists public.segnalazioni (
  id          bigint generated always as identity primary key,
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  stato       text not null check (stato in ('libero', 'occupato')),
  created_at  timestamptz not null default now()
);

create index if not exists segnalazioni_recenti
  on public.segnalazioni (created_at desc, lat, lon);

alter table public.segnalazioni enable row level security;

-- Chiunque può leggere le segnalazioni recenti (ultime 2 ore)
drop policy if exists "lettura recenti" on public.segnalazioni;
create policy "lettura recenti" on public.segnalazioni
  for select to anon
  using (created_at > now() - interval '2 hours');

-- Chiunque può inserire, ma solo con l'ora del server (niente date inventate)
drop policy if exists "inserimento" on public.segnalazioni;
create policy "inserimento" on public.segnalazioni
  for insert to anon
  with check (created_at between now() - interval '1 minute' and now() + interval '1 minute');

-- Permessi per l'app (solo lettura e inserimento)
grant select, insert on public.segnalazioni to anon;

-- Nessuna modifica o cancellazione dal client.

-- Pulizia facoltativa: cancella le segnalazioni più vecchie di 1 giorno.
-- Attiva l'estensione pg_cron (Database → Extensions) e poi esegui:
-- select cron.schedule('pulizia-segnalazioni', '0 * * * *',
--   $$delete from public.segnalazioni where created_at < now() - interval '1 day'$$);
