-- Nummernkreis je Kunde: rg_invoices.data.sequence_id geht vor dem Kreis der Vorlage.
CREATE OR REPLACE FUNCTION public.rg_reserve_number(p_invoice uuid, p_manual text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Eigener Nummernkreis des Kunden geht vor dem Kreis der Vorlage.
  if coalesce(inv.data->>'sequence_id', '') <> '' then
    select * into seq from public.rg_sequences where id::text = inv.data->>'sequence_id' for update;
  elsif tpl.id is not null then
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
    if tpl.id is null and seq.id is null then raise exception 'Vorlage der Rechnung nicht gefunden'; end if;
    if seq.id is null then raise exception 'Kein Nummernkreis fuer Vorlage %', tpl.name; end if;
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
$function$;
