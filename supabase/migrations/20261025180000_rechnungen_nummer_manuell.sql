-- Rechnungsnummer manuell: rg_reserve_number nimmt optional eine Wunschnummer.
-- Ohne Wunsch wie bisher aus dem Nummernkreis. Mit Wunsch prueft der Server
-- Format und Eindeutigkeit; der Kreis rueckt nur weiter, wenn die Wunschnummer
-- genau die naechste Nummer des Kreises ist.

drop function if exists public.rg_reserve_number(uuid);

create or replace function public.rg_reserve_number(p_invoice uuid, p_manual text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.rg_invoices;
  tpl public.rg_templates;
  seq public.rg_sequences;
  n bigint;
  num text;
  manual text := nullif(trim(coalesce(p_manual, '')), '');
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  select * into inv from public.rg_invoices where id = p_invoice for update;
  if not found then raise exception 'Rechnung nicht gefunden'; end if;
  if inv.status <> 'draft' then raise exception 'Rechnung ist bereits endgueltig'; end if;
  if inv.number is not null then return inv.number; end if;

  select * into tpl from public.rg_templates where id::text = inv.data->>'template';
  if found then
    select * into seq from public.rg_sequences where id::text = tpl.data->>'sequence_id' for update;
  end if;

  if manual is not null then
    if manual !~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,39}$' then
      raise exception 'Rechnungsnummer ungueltig: nur Buchstaben, Ziffern, Punkt, Schraegstrich, Unterstrich und Bindestrich';
    end if;
    if exists (select 1 from public.rg_invoices where number = manual) then
      raise exception 'Rechnungsnummer % ist bereits vergeben', manual;
    end if;
    num := manual;
    if seq.id is not null and seq.next_number is not null and num = seq.prefix || seq.next_number then
      update public.rg_sequences set next_number = seq.next_number + seq.step where id = seq.id;
    end if;
  else
    if tpl.id is null then raise exception 'Vorlage der Rechnung nicht gefunden'; end if;
    if seq.id is null then raise exception 'Vorlage % hat keinen Nummernkreis', tpl.name; end if;
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
  end if;

  perform set_config('rg.via', 'reserve', true);
  update public.rg_invoices set number = num where id = p_invoice;
  perform set_config('rg.via', '', true);
  return num;
end;
$$;
revoke all on function public.rg_reserve_number(uuid, text) from public, anon;
grant execute on function public.rg_reserve_number(uuid, text) to authenticated;
