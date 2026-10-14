-- Nummernkreise: Rechnungsnummer erst beim Erstellen, aus einem freigegebenen Kreis.
--
-- Entwuerfe tragen keine Nummer mehr. rg_reserve_number() vergibt sie unmittelbar
-- vor dem Erzeugen von XML und PDF, gesperrt gegen gleichzeitige Vergabe. Ein Kreis
-- muss einmal freigegeben werden (Startnummer, Schrittweite), bevor er Nummern
-- vergibt. Jede Aenderung hebt die Freigabe wieder auf.

create table if not exists public.rg_sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  prefix text not null default '',
  next_number bigint,
  step int not null default 1 check (step >= 1),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.rg_sequences enable row level security;
drop policy if exists rg_sequences_read on public.rg_sequences;
create policy rg_sequences_read on public.rg_sequences for select to authenticated using (public.rg_is_member());
revoke all on public.rg_sequences from anon, authenticated;
grant select on public.rg_sequences to authenticated;

-- Entwuerfe ohne Nummer erlauben
alter table public.rg_invoices alter column number drop not null;

-- Startkreis nach Richards System, noch nicht freigegeben
insert into public.rg_sequences (name, prefix, next_number, step)
select 'ROOTS', '237-', null, 17
where not exists (select 1 from public.rg_sequences);

update public.rg_templates t
   set data = t.data || jsonb_build_object('sequence_id', (select id from public.rg_sequences order by updated_at limit 1))
 where coalesce(t.data->>'sequence_id', '') = '';

-- Waechter erweitern: Nummer nur ueber rg_reserve_number, Entwurf mit Nummer nicht loeschbar
create or replace function public.rg_invoices_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  via text := coalesce(current_setting('rg.via', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.xml is not null or new.pdf_base64 is not null or new.finalized_at is not null then
      raise exception 'Neue Rechnungen beginnen als Entwurf';
    end if;
    if new.number is not null then
      raise exception 'Die Rechnungsnummer wird erst beim Erstellen vergeben';
    end if;
    new.created_by := auth.uid();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Endgueltige Rechnungen koennen nicht geloescht werden';
    end if;
    if old.number is not null and via <> 'release' then
      raise exception 'Entwurf hat bereits eine Rechnungsnummer und kann nicht geloescht werden';
    end if;
    return old;
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if new.xml is not null or new.pdf_base64 is not null or new.finalized_at is not null or new.validation is not null then
      raise exception 'Entwuerfe tragen keine E-Rechnung';
    end if;
    if new.number is distinct from old.number and via <> 'reserve' then
      raise exception 'Die Rechnungsnummer wird nur beim Erstellen vergeben';
    end if;
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
  end if;

  if old.status = 'draft' and new.status = 'final' and via = 'finalize' then
    return new;
  end if;

  if old.status = 'final' and new.status = 'cancelled' and via = 'cancel' then
    return new;
  end if;

  raise exception 'Endgueltige Rechnungen sind unveraenderlich';
end;
$$;

-- Bestehende Entwuerfe geben ihre vorab vergebene Nummer frei
select set_config('rg.via', 'reserve', true);
update public.rg_invoices set number = null where status = 'draft';
select set_config('rg.via', '', true);

-- Kreis anlegen oder aendern; jede Aenderung hebt die Freigabe auf
create or replace function public.rg_sequence_save(p_id uuid, p_name text, p_prefix text, p_next bigint, p_step int)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  rec public.rg_sequences;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Name des Nummernkreises fehlt'; end if;
  if p_step is null or p_step < 1 then raise exception 'Schrittweite muss mindestens 1 sein'; end if;
  if p_next is not null and p_next < 0 then raise exception 'Startnummer ungueltig'; end if;
  if p_id is null then
    insert into public.rg_sequences (name, prefix, next_number, step, updated_by)
    values (left(trim(p_name), 80), left(coalesce(p_prefix, ''), 20), p_next, p_step, auth.uid())
    returning * into rec;
  else
    update public.rg_sequences s
       set name = left(trim(p_name), 80), prefix = left(coalesce(p_prefix, ''), 20), next_number = p_next, step = p_step,
           confirmed_at = case when s.prefix is distinct from left(coalesce(p_prefix, ''), 20) or s.next_number is distinct from p_next or s.step is distinct from p_step then null else s.confirmed_at end,
           confirmed_by = case when s.prefix is distinct from left(coalesce(p_prefix, ''), 20) or s.next_number is distinct from p_next or s.step is distinct from p_step then null else s.confirmed_by end,
           updated_at = now(), updated_by = auth.uid()
     where s.id = p_id
    returning * into rec;
    if not found then raise exception 'Nummernkreis nicht gefunden'; end if;
  end if;
  return to_jsonb(rec);
end;
$$;

-- Freigabe: Startnummer muss gesetzt und noch frei sein
create or replace function public.rg_sequence_confirm(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  rec public.rg_sequences;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  select * into rec from public.rg_sequences where id = p_id for update;
  if not found then raise exception 'Nummernkreis nicht gefunden'; end if;
  if rec.next_number is null then raise exception 'Erste Rechnungsnummer fehlt'; end if;
  if exists (select 1 from public.rg_invoices where number = rec.prefix || rec.next_number) then
    raise exception 'Rechnungsnummer % ist bereits vergeben', rec.prefix || rec.next_number;
  end if;
  update public.rg_sequences set confirmed_at = now(), confirmed_by = auth.uid() where id = p_id returning * into rec;
  return to_jsonb(rec);
end;
$$;

-- Nummer fuer einen Entwurf vergeben (einmalig, gesperrt gegen gleichzeitige Vergabe)
create or replace function public.rg_reserve_number(p_invoice uuid)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  inv public.rg_invoices;
  tpl public.rg_templates;
  seq public.rg_sequences;
  n bigint;
  num text;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  select * into inv from public.rg_invoices where id = p_invoice for update;
  if not found then raise exception 'Rechnung nicht gefunden'; end if;
  if inv.status <> 'draft' then raise exception 'Rechnung ist bereits endgueltig'; end if;
  if inv.number is not null then return inv.number; end if;

  select * into tpl from public.rg_templates where id::text = inv.data->>'template';
  if not found then raise exception 'Vorlage der Rechnung nicht gefunden'; end if;
  select * into seq from public.rg_sequences where id::text = tpl.data->>'sequence_id' for update;
  if not found then raise exception 'Vorlage % hat keinen Nummernkreis', tpl.name; end if;
  if seq.confirmed_at is null or seq.next_number is null then
    raise exception 'Nummernkreis % ist noch nicht freigegeben', seq.name;
  end if;

  n := seq.next_number;
  num := seq.prefix || n;
  while exists (select 1 from public.rg_invoices where number = num) loop
    n := n + seq.step;
    num := seq.prefix || n;
  end loop;

  update public.rg_sequences set next_number = n + seq.step where id = seq.id;
  perform set_config('rg.via', 'reserve', true);
  update public.rg_invoices set number = num where id = p_invoice;
  perform set_config('rg.via', '', true);
  return num;
end;
$$;

revoke all on function public.rg_sequence_save(uuid, text, text, bigint, int) from public, anon;
revoke all on function public.rg_sequence_confirm(uuid) from public, anon;
revoke all on function public.rg_reserve_number(uuid) from public, anon;
grant execute on function public.rg_sequence_save(uuid, text, text, bigint, int) to authenticated;
grant execute on function public.rg_sequence_confirm(uuid) to authenticated;
grant execute on function public.rg_reserve_number(uuid) to authenticated;
