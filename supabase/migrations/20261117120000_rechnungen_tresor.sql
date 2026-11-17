-- Tresor: unabhaengige Sicherung aller Rechnungen.
-- Eigenes Schema, nicht ueber die API erreichbar, nur anfuegen.
-- Jede Aenderung an rg_invoices (anlegen, aendern, finalisieren, stornieren,
-- loeschen) legt eine vollstaendige Kopie der Zeile samt PDF und XML ab.

create schema if not exists rg_vault;
revoke all on schema rg_vault from public, anon, authenticated;

create table if not exists rg_vault.invoices (
  seq bigint generated always as identity primary key,
  at timestamptz not null default now(),
  op text not null check (op in ('INSERT', 'UPDATE', 'DELETE', 'BACKFILL')),
  invoice_id uuid not null,
  number text,
  status text,
  actor uuid,
  row_data jsonb not null,
  row_sha256 text not null
);
create index if not exists rg_vault_invoices_id_idx on rg_vault.invoices (invoice_id, seq desc);
create index if not exists rg_vault_invoices_number_idx on rg_vault.invoices (number);
revoke all on rg_vault.invoices from public, anon, authenticated;

create or replace function rg_vault.append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Tresor ist unveraenderlich';
end $$;

drop trigger if exists rg_vault_invoices_lock on rg_vault.invoices;
create trigger rg_vault_invoices_lock before update or delete on rg_vault.invoices
  for each row execute function rg_vault.append_only();
drop trigger if exists rg_vault_invoices_truncate on rg_vault.invoices;
create trigger rg_vault_invoices_truncate before truncate on rg_vault.invoices
  for each statement execute function rg_vault.append_only();

create or replace function rg_vault.capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.rg_invoices;
  j jsonb;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  -- Unveraenderte Zeilen (z. B. reines updated_at) nicht doppelt sichern.
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at' - 'updated_by') = (to_jsonb(old) - 'updated_at' - 'updated_by') then
    return null;
  end if;
  -- Entwuerfe speichern laufend automatisch: hoechstens alle 10 Minuten sichern,
  -- ausser Status oder Nummer aendern sich.
  if tg_op = 'UPDATE' and new.status = 'draft' and old.status = 'draft' and new.number is not distinct from old.number
     and exists (select 1 from rg_vault.invoices v where v.invoice_id = new.id and v.at > now() - interval '10 minutes') then
    return null;
  end if;
  j := to_jsonb(r);
  insert into rg_vault.invoices (op, invoice_id, number, status, actor, row_data, row_sha256)
  values (tg_op, r.id, r.number, r.status, auth.uid(), j, encode(extensions.digest(convert_to(j::text, 'UTF8'), 'sha256'), 'hex'));
  return null;
end $$;

revoke all on function rg_vault.capture() from public, anon, authenticated;

drop trigger if exists rg_invoices_vault on public.rg_invoices;
create trigger rg_invoices_vault after insert or update or delete on public.rg_invoices
  for each row execute function rg_vault.capture();

-- Bestand einmalig sichern.
insert into rg_vault.invoices (op, invoice_id, number, status, actor, row_data, row_sha256)
select 'BACKFILL', i.id, i.number, i.status, null, to_jsonb(i),
       encode(extensions.digest(convert_to(to_jsonb(i)::text, 'UTF8'), 'sha256'), 'hex')
from public.rg_invoices i
where not exists (select 1 from rg_vault.invoices v where v.invoice_id = i.id);
