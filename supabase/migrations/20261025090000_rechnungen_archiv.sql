-- Revisionssichere Ablage und Versionierung
--
-- rg_journal   Jede Aenderung an einer Rechnung (angelegt, Zwischenstand,
--              Nummer, endgueltig, storniert, Entwurf geloescht) als neue Zeile.
--              Nur anhaengen: Aendern, Loeschen und TRUNCATE sind gesperrt.
--              Jede Zeile traegt den SHA-256 der vorigen (Hash-Kette); wer eine
--              Zeile nachtraeglich veraendert, bricht die Kette ab dort.
-- rg_files     Anlagen (Bilder, Excel, Word, PDF) inhaltsadressiert ueber ihren
--              SHA-256. Unveraenderlich, doppelte Dateien liegen nur einmal da.
-- rg_verify    Prueft Kette, Hashes von PDF und XML und den Abgleich zwischen
--              Rechnung und Journal.
--
-- Ausserdem: Rechnungsbetrag 0,00 EUR ist zulaessig (nicht negativ).

/* ------------------------------------------------------------ Journal --- */

create table if not exists public.rg_journal (
  seq bigint generated always as identity primary key,
  invoice_id uuid not null,
  version int not null,
  event text not null check (event in ('baseline', 'created', 'saved', 'numbered', 'finalized', 'cancelled', 'deleted')),
  status text,
  number text,
  data jsonb,
  data_sha256 text,
  gross_cents bigint,
  xml_sha256 text,
  pdf_sha256 text,
  note text,
  actor uuid,
  actor_email text,
  at timestamptz not null,
  prev_hash text,
  hash text not null unique
);
create index if not exists rg_journal_invoice_idx on public.rg_journal (invoice_id, version);

create or replace function public.rg_journal_hash(j public.rg_journal)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(concat_ws('|',
    coalesce(j.prev_hash, ''), j.invoice_id::text, j.version::text, j.event,
    coalesce(j.status, ''), coalesce(j.number, ''), coalesce(j.data_sha256, ''),
    coalesce(j.gross_cents::text, ''), coalesce(j.xml_sha256, ''), coalesce(j.pdf_sha256, ''),
    coalesce(j.note, ''), coalesce(j.actor::text, ''),
    to_char(j.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.rg_journal_append(
  p_invoice uuid, p_event text, p_status text, p_number text, p_data jsonb,
  p_gross bigint, p_xml_sha text, p_pdf_sha text, p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.rg_journal;
begin
  -- Eine Kette fuer alle Rechnungen, deshalb hintereinander
  perform pg_advisory_xact_lock(hashtext('rg_journal'));
  j.invoice_id := p_invoice;
  j.version := coalesce((select max(version) from public.rg_journal where invoice_id = p_invoice), 0) + 1;
  j.event := p_event;
  j.status := p_status;
  j.number := p_number;
  j.data := p_data;
  j.data_sha256 := case when p_data is null then null else encode(extensions.digest(convert_to(p_data::text, 'UTF8'), 'sha256'), 'hex') end;
  j.gross_cents := p_gross;
  j.xml_sha256 := p_xml_sha;
  j.pdf_sha256 := p_pdf_sha;
  j.note := p_note;
  j.actor := auth.uid();
  j.actor_email := (select u.email from auth.users u where u.id = auth.uid());
  j.at := clock_timestamp();
  j.prev_hash := (select hash from public.rg_journal order by seq desc limit 1);
  j.hash := public.rg_journal_hash(j);
  insert into public.rg_journal (invoice_id, version, event, status, number, data, data_sha256, gross_cents, xml_sha256, pdf_sha256, note, actor, actor_email, at, prev_hash, hash)
  values (j.invoice_id, j.version, j.event, j.status, j.number, j.data, j.data_sha256, j.gross_cents, j.xml_sha256, j.pdf_sha256, j.note, j.actor, j.actor_email, j.at, j.prev_hash, j.hash);
end;
$$;
revoke all on function public.rg_journal_append(uuid, text, text, text, jsonb, bigint, text, text, text) from public, anon, authenticated;

-- Nur anhaengen
create or replace function public.rg_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Archiv ist unveraenderlich (%)', tg_table_name;
end;
$$;

drop trigger if exists rg_journal_lock on public.rg_journal;
create trigger rg_journal_lock before update or delete on public.rg_journal
  for each row execute function public.rg_append_only();
drop trigger if exists rg_journal_truncate on public.rg_journal;
create trigger rg_journal_truncate before truncate on public.rg_journal
  for each statement execute function public.rg_append_only();

alter table public.rg_journal enable row level security;
drop policy if exists rg_journal_read on public.rg_journal;
create policy rg_journal_read on public.rg_journal for select to authenticated using (public.rg_is_member());
revoke all on public.rg_journal from anon, authenticated;
grant select on public.rg_journal to authenticated;

-- Rechnungen selbst ebenfalls gegen TRUNCATE schuetzen
drop trigger if exists rg_invoices_truncate on public.rg_invoices;
create trigger rg_invoices_truncate before truncate on public.rg_invoices
  for each statement execute function public.rg_append_only();

/* ---------------------------------------- Journal aus den Rechnungen --- */

-- Zwischenstaende eines Entwurfs: hoechstens alle 5 Minuten je Person eine
-- Version, damit das Autospeichern das Journal nicht flutet. Der letzte Stand
-- landet spaetestens beim Endgueltig-Machen oder Loeschen im Journal.
create or replace function public.rg_invoices_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  last public.rg_journal;
begin
  if tg_op = 'INSERT' then
    perform public.rg_journal_append(new.id, 'created', new.status, new.number, new.data, new.gross_cents, null, null, null);
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.rg_journal_append(old.id, 'deleted', old.status, old.number, old.data, old.gross_cents, null, null, null);
    return null;
  end if;

  if old.status = 'draft' and new.status = 'final' then
    perform public.rg_journal_append(new.id, 'finalized', new.status, new.number, new.data, new.gross_cents, new.xml_sha256, new.pdf_sha256, null);
    return null;
  end if;

  if old.status = 'final' and new.status = 'cancelled' then
    perform public.rg_journal_append(new.id, 'cancelled', new.status, new.number, null, new.gross_cents, new.xml_sha256, new.pdf_sha256, new.cancel_reason);
    return null;
  end if;

  if old.number is null and new.number is not null then
    perform public.rg_journal_append(new.id, 'numbered', new.status, new.number, new.data, new.gross_cents, null, null, null);
    return null;
  end if;

  if new.data is distinct from old.data then
    select * into last from public.rg_journal where invoice_id = new.id order by version desc limit 1;
    if last.seq is null or last.event not in ('created', 'saved') or last.actor is distinct from auth.uid() or last.at < clock_timestamp() - interval '5 minutes' then
      perform public.rg_journal_append(new.id, 'saved', new.status, new.number, new.data, new.gross_cents, null, null, null);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists rg_invoices_journal on public.rg_invoices;
create trigger rg_invoices_journal
  after insert or update or delete on public.rg_invoices
  for each row execute function public.rg_invoices_journal();

-- Ausgangsstand aller vorhandenen Rechnungen
do $$
declare
  r record;
begin
  for r in select * from public.rg_invoices i
            where not exists (select 1 from public.rg_journal j where j.invoice_id = i.id)
            order by created_at loop
    perform public.rg_journal_append(r.id, 'baseline', r.status, r.number, r.data, r.gross_cents, r.xml_sha256, r.pdf_sha256, 'Bestand bei Einfuehrung des Journals');
  end loop;
end $$;

/* ------------------------------------------------------------ Dateien --- */

create table if not exists public.rg_files (
  sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  name text not null,
  mime text not null,
  size int not null,
  content bytea not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) default auth.uid()
);

drop trigger if exists rg_files_lock on public.rg_files;
create trigger rg_files_lock before update or delete on public.rg_files
  for each row execute function public.rg_append_only();
drop trigger if exists rg_files_truncate on public.rg_files;
create trigger rg_files_truncate before truncate on public.rg_files
  for each statement execute function public.rg_append_only();

alter table public.rg_files enable row level security;
drop policy if exists rg_files_read on public.rg_files;
create policy rg_files_read on public.rg_files for select to authenticated using (public.rg_is_member());
revoke all on public.rg_files from anon, authenticated;

create or replace function public.rg_file_put(p_name text, p_mime text, p_base64 text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  bytes bytea;
  sha text;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  if p_mime not in (
    'image/png', 'image/jpeg', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) then
    raise exception 'Dateityp nicht erlaubt';
  end if;
  begin
    bytes := decode(p_base64, 'base64');
  exception when others then
    raise exception 'Datei ist nicht lesbar';
  end;
  if octet_length(bytes) = 0 then raise exception 'Datei ist leer'; end if;
  if octet_length(bytes) > 5 * 1024 * 1024 then raise exception 'Datei groesser als 5 MB'; end if;
  sha := encode(extensions.digest(bytes, 'sha256'), 'hex');
  insert into public.rg_files (sha256, name, mime, size, content)
  values (sha, left(coalesce(nullif(trim(p_name), ''), 'Anlage'), 200), p_mime, octet_length(bytes), bytes)
  on conflict (sha256) do nothing;
  return sha;
end;
$$;
revoke all on function public.rg_file_put(text, text, text) from public, anon;
grant execute on function public.rg_file_put(text, text, text) to authenticated;

create or replace function public.rg_file_get(p_sha text)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  f public.rg_files;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;
  select * into f from public.rg_files where sha256 = p_sha;
  if not found then raise exception 'Datei nicht gefunden'; end if;
  return jsonb_build_object('sha256', f.sha256, 'name', f.name, 'mime', f.mime, 'size', f.size, 'base64', encode(f.content, 'base64'));
end;
$$;
revoke all on function public.rg_file_get(text) from public, anon;
grant execute on function public.rg_file_get(text) to authenticated;

/* ------------------------------------------------------------ Pruefen --- */

-- p_invoice null: ganze Kette. Sonst zusaetzlich PDF/XML und Abgleich dieser Rechnung.
create or replace function public.rg_verify(p_invoice uuid default null)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  j public.rg_journal;
  prev text := null;
  n int := 0;
  errs text[] := '{}';
  inv public.rg_invoices;
  fin public.rg_journal;
begin
  if not public.rg_is_member() then raise exception 'Kein Zugriff auf Rechnungen'; end if;

  for j in select * from public.rg_journal order by seq loop
    n := n + 1;
    if j.prev_hash is distinct from prev then
      errs := errs || format('Kette unterbrochen vor Eintrag %s', j.seq);
    end if;
    if j.hash <> public.rg_journal_hash(j) then
      errs := errs || format('Eintrag %s wurde veraendert', j.seq);
    end if;
    if j.data is not null and j.data_sha256 is distinct from encode(extensions.digest(convert_to(j.data::text, 'UTF8'), 'sha256'), 'hex') then
      errs := errs || format('Inhalt von Eintrag %s wurde veraendert', j.seq);
    end if;
    prev := j.hash;
  end loop;

  if p_invoice is not null then
    select * into inv from public.rg_invoices where id = p_invoice;
    if found and inv.status <> 'draft' then
      if inv.pdf_sha256 is distinct from encode(extensions.digest(decode(inv.pdf_base64, 'base64'), 'sha256'), 'hex') then
        errs := errs || 'PDF weicht vom gespeicherten Hash ab'::text;
      end if;
      if inv.xml_sha256 is distinct from encode(extensions.digest(convert_to(inv.xml, 'UTF8'), 'sha256'), 'hex') then
        errs := errs || 'XML weicht vom gespeicherten Hash ab'::text;
      end if;
      select * into fin from public.rg_journal
       where invoice_id = p_invoice and event in ('finalized', 'baseline') and pdf_sha256 is not null
       order by version limit 1;
      if fin.seq is null then
        errs := errs || 'Kein Journaleintrag zur endgueltigen Rechnung'::text;
      elsif fin.pdf_sha256 is distinct from inv.pdf_sha256 or fin.xml_sha256 is distinct from inv.xml_sha256 or fin.number is distinct from inv.number then
        errs := errs || 'Rechnung weicht vom Journal ab'::text;
      end if;
    end if;
  end if;

  return jsonb_build_object('ok', cardinality(errs) = 0, 'entries', n, 'errors', to_jsonb(errs), 'last_hash', prev, 'checked_at', now());
end;
$$;
revoke all on function public.rg_verify(uuid) from public, anon;
grant execute on function public.rg_verify(uuid) to authenticated;

/* ------------------------------------------------- Betrag 0 zulassen --- */

do $$
declare
  src text;
begin
  select pg_get_functiondef('public.rg_check_xml(text, jsonb, text)'::regprocedure) into src;
  if position('grand <= 0' in src) > 0 then
    src := replace(src, 'if grand is null or grand <= 0 then errs := errs || ''Rechnungsbetrag ist null''::text; end if;',
                         'if grand is null or grand < 0 then errs := errs || ''Rechnungsbetrag ist negativ''::text; end if;');
    execute src;
  end if;
end $$;
