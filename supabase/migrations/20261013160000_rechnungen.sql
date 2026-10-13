-- ROOTS Rechnungen
-- Zugriff nur fuer drei Personen (rg_members). Eine Rechnung wird nur ueber
-- rg_finalize() endgueltig; die Funktion prueft XML und PDF selbst, unabhaengig
-- davon, was der Browser meldet. Endgueltige Rechnungen sind unveraenderlich.

create table if not exists public.rg_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  added_at timestamptz not null default now()
);

create or replace function public.rg_is_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.rg_members m where m.user_id = auth.uid());
$$;
revoke all on function public.rg_is_member() from public, anon;
grant execute on function public.rg_is_member() to authenticated;

create table if not exists public.rg_settings (
  id int primary key default 1 check (id = 1),
  seller jsonb not null default '{}'::jsonb,
  number_prefix text not null default '237-',
  number_last int not null default 0,
  number_step int not null default 17,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.rg_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rg_invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'final', 'cancelled')),
  data jsonb not null,
  customer_name text,
  issue_date date,
  tax_case text,
  net_cents bigint,
  tax_cents bigint,
  gross_cents bigint,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id),
  seller_snapshot jsonb,
  xml text,
  pdf_base64 text,
  xml_sha256 text,
  pdf_sha256 text,
  validation jsonb,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancel_reason text
);
create index if not exists rg_invoices_issue_idx on public.rg_invoices (issue_date desc);

alter table public.rg_members enable row level security;
alter table public.rg_settings enable row level security;
alter table public.rg_customers enable row level security;
alter table public.rg_invoices enable row level security;

drop policy if exists rg_members_read on public.rg_members;
create policy rg_members_read on public.rg_members for select to authenticated using (public.rg_is_member());

drop policy if exists rg_settings_rw on public.rg_settings;
create policy rg_settings_rw on public.rg_settings for all to authenticated using (public.rg_is_member()) with check (public.rg_is_member());

drop policy if exists rg_customers_rw on public.rg_customers;
create policy rg_customers_rw on public.rg_customers for all to authenticated using (public.rg_is_member()) with check (public.rg_is_member());

drop policy if exists rg_invoices_read on public.rg_invoices;
create policy rg_invoices_read on public.rg_invoices for select to authenticated using (public.rg_is_member());
drop policy if exists rg_invoices_insert on public.rg_invoices;
create policy rg_invoices_insert on public.rg_invoices for insert to authenticated with check (public.rg_is_member());
drop policy if exists rg_invoices_update on public.rg_invoices;
create policy rg_invoices_update on public.rg_invoices for update to authenticated using (public.rg_is_member()) with check (public.rg_is_member());
drop policy if exists rg_invoices_delete on public.rg_invoices;
create policy rg_invoices_delete on public.rg_invoices for delete to authenticated using (public.rg_is_member() and status = 'draft');

revoke all on public.rg_members, public.rg_settings, public.rg_customers, public.rg_invoices from anon;
grant select on public.rg_members to authenticated;
grant select, insert, update on public.rg_settings to authenticated;
grant select, insert, update, delete on public.rg_customers to authenticated;
grant select, insert, update, delete on public.rg_invoices to authenticated;

-- Waechter: Entwuerfe frei, alles andere nur ueber die Funktionen unten.
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
    new.created_by := auth.uid();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Endgueltige Rechnungen koennen nicht geloescht werden';
    end if;
    return old;
  end if;

  if old.status = 'draft' and new.status = 'draft' then
    if new.xml is not null or new.pdf_base64 is not null or new.finalized_at is not null or new.validation is not null then
      raise exception 'Entwuerfe tragen keine E-Rechnung';
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

drop trigger if exists rg_invoices_guard on public.rg_invoices;
create trigger rg_invoices_guard
  before insert or update or delete on public.rg_invoices
  for each row execute function public.rg_invoices_guard();

-- Eigene, serverseitige Pruefung des E-Rechnungs-XML. Liefert die Liste der
-- Verstoesse; leer heisst bestanden.
create or replace function public.rg_check_xml(p_xml text, p_data jsonb, p_number text)
returns text[]
language plpgsql stable
set search_path = ''
as $$
declare
  ns text[] := array[
    array['rsm', 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100'],
    array['ram', 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100'],
    array['udt', 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100']
  ];
  x xml;
  errs text[] := '{}';
  v text;
  cat text;
  rate numeric;
  line_sum numeric;
  line_total numeric;
  basis numeric;
  tax numeric;
  grand numeric;
  due numeric;
  data_net bigint;
  expected_cat text := case p_data->>'tax_case' when 'S19' then 'S' when 'AE' then 'AE' when 'O' then 'O' end;

begin
  begin
    x := p_xml::xml;
  exception when others then
    return array['XML ist nicht wohlgeformt'];
  end;

  v := (xpath('/rsm:CrossIndustryInvoice/rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID/text()', x, ns))[1]::text;
  if v is distinct from 'urn:cen.eu:en16931:2017' then errs := errs || 'Profil ist nicht EN 16931 (BT-24)'::text; end if;

  v := (xpath('/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:ID/text()', x, ns))[1]::text;
  if v is distinct from p_number then errs := errs || 'Rechnungsnummer im XML weicht ab (BT-1)'::text; end if;

  v := (xpath('/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:TypeCode/text()', x, ns))[1]::text;
  if v is distinct from '380' then errs := errs || 'Dokumentart ist nicht 380 (BT-3)'::text; end if;

  v := (xpath('/rsm:CrossIndustryInvoice/rsm:ExchangedDocument/ram:IssueDateTime/udt:DateTimeString/text()', x, ns))[1]::text;
  if v is null or v !~ '^\d{8}$' then errs := errs || 'Rechnungsdatum fehlt (BT-2)'::text; end if;

  v := (xpath('//ram:ApplicableHeaderTradeSettlement/ram:InvoiceCurrencyCode/text()', x, ns))[1]::text;
  if v is distinct from 'EUR' then errs := errs || 'Waehrung ist nicht EUR (BT-5)'::text; end if;

  if coalesce((xpath('//ram:SellerTradeParty/ram:Name/text()', x, ns))[1]::text, '') = '' then errs := errs || 'Verkaeufer fehlt (BT-27)'::text; end if;
  if coalesce((xpath('//ram:BuyerTradeParty/ram:Name/text()', x, ns))[1]::text, '') = '' then errs := errs || 'Kaeufer fehlt (BT-44)'::text; end if;
  if coalesce((xpath('//ram:BuyerTradeParty/ram:PostalTradeAddress/ram:CountryID/text()', x, ns))[1]::text, '') !~ '^[A-Z]{2}$' then errs := errs || 'Land des Kaeufers fehlt (BT-55)'::text; end if;
  if coalesce((xpath('//ram:BuyerTradeParty/ram:PostalTradeAddress/ram:CityName/text()', x, ns))[1]::text, '') = '' then errs := errs || 'Ort des Kaeufers fehlt (BT-52)'::text; end if;
  if coalesce((xpath('//ram:SpecifiedTradeSettlementPaymentMeans/ram:PayeePartyCreditorFinancialAccount/ram:IBANID/text()', x, ns))[1]::text, '') !~ '^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$' then errs := errs || 'IBAN fehlt (BT-84)'::text; end if;
  if coalesce((xpath('//ram:BillingSpecifiedPeriod/ram:StartDateTime/udt:DateTimeString/text()', x, ns))[1]::text, '') = ''
     or coalesce((xpath('//ram:BillingSpecifiedPeriod/ram:EndDateTime/udt:DateTimeString/text()', x, ns))[1]::text, '') = '' then
    errs := errs || 'Leistungszeitraum fehlt (BT-73/74)'::text;
  end if;
  if coalesce((xpath('//ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime/udt:DateTimeString/text()', x, ns))[1]::text, '') = '' then errs := errs || 'Faelligkeit fehlt (BT-9)'::text; end if;
  if not exists (select 1 from unnest(xpath('//ram:SellerTradeParty/ram:SpecifiedTaxRegistration/ram:ID/@schemeID', x, ns)) s where s::text in ('VA', 'FC')) then
    errs := errs || 'Steuernummer oder USt-IdNr. des Verkaeufers fehlt (BR-CO-26)'::text;
  end if;

  -- Steuerkategorie und Summen
  if (select count(*) from unnest(xpath('//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax', x, ns))) <> 1 then
    errs := errs || 'Genau eine Steueraufschluesselung erwartet (BG-23)'::text;
  end if;
  cat := (xpath('//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/ram:CategoryCode/text()', x, ns))[1]::text;
  if expected_cat is null or cat is distinct from expected_cat then errs := errs || 'Steuerkategorie passt nicht zum Steuerfall (BT-118)'::text; end if;
  rate := nullif((xpath('//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/ram:RateApplicablePercent/text()', x, ns))[1]::text, '')::numeric;
  if cat = 'S' and rate is distinct from 19 then errs := errs || 'Steuersatz ist nicht 19 % (BT-119)'::text; end if;
  if cat = 'AE' then
    if rate is distinct from 0 then errs := errs || 'Reverse Charge mit Steuersatz ungleich 0 (BR-AE-05)'::text; end if;
    if not exists (select 1 from unnest(xpath('//ram:SellerTradeParty/ram:SpecifiedTaxRegistration/ram:ID[@schemeID="VA"]/text()', x, ns)) s where s::text <> '') then
      errs := errs || 'Reverse Charge ohne USt-IdNr. von ROOTS (§ 14a UStG, BR-AE-02)'::text;
    end if;
    if not exists (select 1 from unnest(xpath('//ram:BuyerTradeParty/ram:SpecifiedTaxRegistration/ram:ID[@schemeID="VA"]/text()', x, ns)) s where s::text <> '') then
      errs := errs || 'Reverse Charge ohne USt-IdNr. des Kunden (§ 14a UStG, BR-AE-02)'::text;
    end if;
  end if;
  if cat in ('AE', 'O') and coalesce((xpath('//ram:ApplicableHeaderTradeSettlement/ram:ApplicableTradeTax/ram:ExemptionReason/text()', x, ns))[1]::text, '') = '' then
    errs := errs || 'Befreiungsgrund fehlt (BR-AE-10 / BR-O-10)'::text;
  end if;

  select coalesce(sum(t::text::numeric), 0) into line_sum
    from unnest(xpath('//ram:IncludedSupplyChainTradeLineItem/ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeSettlementLineMonetarySummation/ram:LineTotalAmount/text()', x, ns)) t;
  line_total := (xpath('//ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:LineTotalAmount/text()', x, ns))[1]::text::numeric;
  basis := (xpath('//ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:TaxBasisTotalAmount/text()', x, ns))[1]::text::numeric;
  tax := coalesce((xpath('//ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:TaxTotalAmount/text()', x, ns))[1]::text::numeric, 0);
  grand := (xpath('//ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:GrandTotalAmount/text()', x, ns))[1]::text::numeric;
  due := (xpath('//ram:SpecifiedTradeSettlementHeaderMonetarySummation/ram:DuePayableAmount/text()', x, ns))[1]::text::numeric;

  if line_total is distinct from line_sum then errs := errs || 'Summe der Positionen stimmt nicht (BR-CO-10)'::text; end if;
  if basis is distinct from line_total then errs := errs || 'Steuerbasis stimmt nicht (BR-CO-13)'::text; end if;
  if tax is distinct from round(basis * coalesce(rate, 0) / 100, 2) then errs := errs || 'Steuerbetrag stimmt nicht (BR-CO-17)'::text; end if;
  if grand is distinct from basis + tax then errs := errs || 'Bruttobetrag stimmt nicht (BR-CO-15)'::text; end if;
  if due is distinct from grand then errs := errs || 'Zahlbetrag stimmt nicht (BR-CO-16)'::text; end if;
  if grand is null or grand <= 0 then errs := errs || 'Rechnungsbetrag ist null'::text; end if;

  select coalesce(sum((l->>'amount_cents')::bigint), -1) into data_net from jsonb_array_elements(coalesce(p_data->'lines', '[]'::jsonb)) l;
  if line_total is null or data_net <> round(line_total * 100) then errs := errs || 'XML weicht von den gespeicherten Positionen ab'::text; end if;

  return errs;
exception when others then
  return errs || ('XML nicht auswertbar: ' || sqlerrm);
end;
$$;

-- Endgueltig machen. Nur hier entsteht eine Rechnung, die rausgehen darf.
create or replace function public.rg_finalize(p_id uuid, p_xml text, p_pdf_base64 text, p_validation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.rg_invoices;
  s public.rg_settings;
  errs text[];
  pdf bytea;
  num_tail int;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;

  select * into inv from public.rg_invoices where id = p_id for update;
  if not found then raise exception 'Rechnung nicht gefunden'; end if;
  if inv.status <> 'draft' then raise exception 'Rechnung ist bereits endgueltig'; end if;

  if coalesce(p_validation->>'schematron', '') <> 'passed' then raise exception 'Schematron EN 16931 nicht bestanden'; end if;
  if coalesce(p_validation->>'xsd', '') <> 'passed' then raise exception 'XSD Factur-X EN 16931 nicht bestanden'; end if;
  if coalesce(p_validation->>'roundtrip', '') <> 'passed' then raise exception 'XML im PDF nicht wiedergefunden'; end if;

  errs := public.rg_check_xml(p_xml, inv.data, inv.number);
  if cardinality(errs) > 0 then
    raise exception 'E-Rechnung abgelehnt: %', array_to_string(errs, '; ');
  end if;

  begin
    pdf := decode(p_pdf_base64, 'base64');
  exception when others then
    raise exception 'PDF ist nicht lesbar';
  end;
  if substring(pdf from 1 for 5) <> convert_to('%PDF-', 'UTF8') then raise exception 'Keine PDF-Datei'; end if;
  if position(convert_to('factur-x.xml', 'UTF8') in pdf) = 0 then raise exception 'PDF enthaelt kein factur-x.xml'; end if;
  if position(convert_to('/AFRelationship /Data', 'UTF8') in pdf) = 0 then raise exception 'XML ist nicht als Rechnungsdaten verknuepft'; end if;
  if position(convert_to('pdfaid:part>3<', 'UTF8') in pdf) = 0 then raise exception 'PDF ist nicht als PDF/A-3 gekennzeichnet'; end if;
  if position(convert_to('ConformanceLevel>EN 16931<', 'UTF8') in pdf) = 0 then raise exception 'Factur-X-Profil ist nicht EN 16931'; end if;
  if position(convert_to('/OutputIntents', 'UTF8') in pdf) = 0 then raise exception 'PDF/A-OutputIntent fehlt'; end if;
  if octet_length(pdf) > 8 * 1024 * 1024 then raise exception 'PDF groesser als 8 MB'; end if;

  select * into s from public.rg_settings where id = 1;

  perform set_config('rg.via', 'finalize', true);
  update public.rg_invoices set
    status = 'final',
    xml = p_xml,
    pdf_base64 = p_pdf_base64,
    xml_sha256 = encode(extensions.digest(convert_to(p_xml, 'UTF8'), 'sha256'), 'hex'),
    pdf_sha256 = encode(extensions.digest(pdf, 'sha256'), 'hex'),
    validation = p_validation || jsonb_build_object('server', 'passed', 'server_checked_at', now()),
    seller_snapshot = s.seller,
    finalized_at = now(),
    finalized_by = auth.uid()
  where id = p_id;
  perform set_config('rg.via', '', true);

  num_tail := nullif(substring(inv.number from '(\d+)$'), '')::int;
  if num_tail is not null and s.number_prefix is not null and inv.number like s.number_prefix || '%' and num_tail > s.number_last then
    update public.rg_settings set number_last = num_tail where id = 1;
  end if;

  return jsonb_build_object('id', p_id, 'status', 'final');
end;
$$;
revoke all on function public.rg_finalize(uuid, text, text, jsonb) from public, anon;
grant execute on function public.rg_finalize(uuid, text, text, jsonb) to authenticated;

create or replace function public.rg_cancel(p_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Grund fuer die Stornierung fehlt'; end if;
  perform set_config('rg.via', 'cancel', true);
  update public.rg_invoices set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = left(p_reason, 500)
   where id = p_id and status = 'final';
  perform set_config('rg.via', '', true);
  if not found then raise exception 'Nur endgueltige Rechnungen koennen storniert werden'; end if;
  return jsonb_build_object('id', p_id, 'status', 'cancelled');
end;
$$;
revoke all on function public.rg_cancel(uuid, text) from public, anon;
grant execute on function public.rg_cancel(uuid, text) to authenticated;

revoke all on function public.rg_check_xml(text, jsonb, text) from public, anon;
grant execute on function public.rg_check_xml(text, jsonb, text) to authenticated;

-- Startdaten: drei Personen, Stammdaten aus den Vorlagen vom 12.10.2026
insert into public.rg_members (user_id, email)
select id, email from auth.users
 where lower(email) in ('pgoutzeris@roots-consultants.com', 'mstankovic@roots-consultants.com', 'rerbler@roots-consultants.com')
on conflict (user_id) do nothing;

-- Stammdaten (Firma, Bank, Steuernummer) wurden beim Einrichten am 13.10.2026
-- direkt in public.rg_settings gesetzt und stehen bewusst nicht im Repo.
insert into public.rg_settings (id, number_prefix, number_last, number_step)
values (1, '237-', 4394, 17)
on conflict (id) do nothing;
