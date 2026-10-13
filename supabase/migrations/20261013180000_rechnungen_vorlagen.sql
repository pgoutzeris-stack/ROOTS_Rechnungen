-- Rechnungsvorlagen in der Datenbank, pflegbar unter Einstellungen > Vorlagen.

create table if not exists public.rg_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort int not null default 0,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) default auth.uid()
);

alter table public.rg_templates enable row level security;
drop policy if exists rg_templates_rw on public.rg_templates;
create policy rg_templates_rw on public.rg_templates for all to authenticated
  using (public.rg_is_member()) with check (public.rg_is_member());
revoke all on public.rg_templates from anon;
grant select, insert, update, delete on public.rg_templates to authenticated;

insert into public.rg_templates (name, sort, data)
select * from (values
  ('Rechnung · Deutsch · 19 % USt', 1, '{"hint":"Beiersdorf, Lidl","lang":"de","tax_case":"S19","due_days":30,"lines":[{"label":"Beratungshonorar","detail":"Details siehe Anhang"},{"label":"Expenses","detail":""}],"annex":{"title":"Honorarsplit nach Workstream","text":"","rows":[]},"note":""}'::jsonb),
  ('Invoice · English · Reverse Charge EU', 2, '{"hint":"Danone","lang":"en","tax_case":"AE","due_days":30,"lines":[{"label":"Consulting Fees","detail":""},{"label":"Expenses","detail":""}],"annex":{"title":"","text":"","rows":[]},"note":""}'::jsonb),
  ('Rechnung · Drittland · § 3a UStG', 3, '{"hint":"DWA / BAUHAUS","lang":"de","tax_case":"O","due_days":30,"lines":[{"label":"Beratungshonorar","detail":"Details s. Anhang"},{"label":"Expenses","detail":""}],"annex":{"title":"Leistungsdetails","text":"","rows":[]},"note":""}'::jsonb)
) v(name, sort, data)
where not exists (select 1 from public.rg_templates);
