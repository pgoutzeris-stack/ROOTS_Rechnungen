/**
 * ROOTS Rechnungen - Oberflaeche.
 *
 * Laeuft nur im Intranet (tokenlos, alle Daten ueber den Broker, Aktion
 * "rechnungen"). Ablauf einer Rechnung:
 *   Entwurf  ->  Pruefen (Pflichtangaben, Schematron, XSD, PDF/A + XML)
 *            ->  Endgueltig (Server prueft erneut, danach unveraenderlich)
 * Nur endgueltige Rechnungen lassen sich als E-Rechnung herunterladen.
 */
(function () {
  "use strict";

  const E = window.RootsEInvoice;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const VALIDATOR_URL = "https://erechnungsvalidator.service-bw.de/";

  const state = {
    user: null,
    settings: null,
    invoices: [],
    customers: [],
    templates: [],
    view: "list",
    filter: "all",
    edit: null,        // Entwurf im Editor
    check: null,       // Ergebnis der letzten Pruefung { fingerprint, steps, xml, pdfB64 }
    busy: false,
  };

  /* --------------------------------------------------------------- Broker --- */

  async function api(op, payload = {}) {
    const request = window.RootsUserBridge?.request;
    if (!request) throw new Error("Die Intranet-Brücke ist nicht geladen.");
    try {
      return await request("rechnungen", { op, ...payload }, 120000);
    } catch (e) {
      throw new Error(translate(e?.message || String(e)));
    }
  }

  function translate(raw) {
    if (/Kein Zugriff/i.test(raw)) return "Kein Zugriff auf Rechnungen.";
    if (/duplicate key|rg_invoices_number_key/i.test(raw)) return "Diese Rechnungsnummer ist bereits vergeben.";
    if (/unveraenderlich/i.test(raw)) return "Endgültige Rechnungen sind unveränderlich.";
    if (/veraltet|Identit/i.test(raw)) return "Die Sitzung des Intranets ist veraltet. Intranet neu laden.";
    if (/Failed to fetch|NetworkError/i.test(raw)) return "Supabase ist nicht erreichbar.";
    return raw;
  }

  /* --------------------------------------------------------------- Helfer --- */

  const today = () => new Date().toISOString().slice(0, 10);
  function addDays(iso, n) {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function lastMonth() {
    const d = new Date();
    const start = new Date(Date.UTC(d.getFullYear(), d.getMonth() - 1, 1));
    const end = new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0));
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  }
  const fmtDate = (iso) => E.fmtDate(String(iso || "").slice(0, 10), "de");
  const money = (c) => E.money(c || 0, "de");

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    $("#toast-container").appendChild(el);
    setTimeout(() => el.classList.add("out"), 3600);
    setTimeout(() => el.remove(), 4000);
  }

  function setBusy(on, label) {
    state.busy = on;
    const b = $("#busy");
    b.classList.toggle("hidden", !on);
    $("#busy-label").textContent = label || "";
  }

  function nextNumber() {
    const s = state.settings || {};
    const prefix = s.number_prefix || "";
    let last = Number(s.number_last) || 0;
    state.invoices.forEach((i) => {
      if (!String(i.number).startsWith(prefix)) return;
      const n = Number(String(i.number).slice(prefix.length));
      if (Number.isFinite(n) && n > last) last = n;
    });
    return prefix + (last + (Number(s.number_step) || 1));
  }

  function download(bytes, name, type) {
    const blob = new Blob([bytes], { type });
    if (window.RootsUserBridge?.downloadBlob) window.RootsUserBridge.downloadBlob(blob, name);
    else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  }

  function openExternal(url) {
    if (document.documentElement.classList.contains("in-iframe")) {
      window.parent.postMessage({ type: "roots-open-url", url }, "https://pgoutzeris-stack.github.io");
    } else window.open(url, "_blank", "noopener,noreferrer");
  }

  const safeName = (s) => String(s || "").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "").slice(0, 40);

  /* --------------------------------------------------------- PDF-Assets --- */

  let assetsPromise = null;
  function pdfAssets() {
    if (!assetsPromise) {
      const get = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(p + " fehlt"); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));
      assetsPromise = Promise.all([get("assets/pdf/inter-400.ttf"), get("assets/pdf/inter-700.ttf"), get("assets/pdf/roots-logo.jpg"), get("assets/pdf/srgb.icc")])
        .then(([regular, bold, logo, icc]) => ({ regular, bold, logo, icc }))
        .catch((e) => { assetsPromise = null; throw e; });
    }
    return assetsPromise;
  }

  /* ----------------------------------------------------------------- Boot --- */

  async function boot() {
    const request = window.RootsUserBridge?.request;
    if (!request || !window.RootsUserBridge?.TOKENLESS_EMBED) {
      gate("Rechnungen läuft im ROOTS Intranet.");
      return;
    }
    let context = null;
    for (let i = 0; i < 8 && !context; i++) {
      try {
        context = await request("user-context", {}, 20000);
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!context?.user?.id) return gate("Das Intranet hat keine Anmeldung übergeben.");
    state.user = context.user;
    try {
      const res = await api("context");
      if (!res.member) return gate("Kein Zugriff auf Rechnungen.");
      state.settings = res.settings;
    } catch (e) {
      return gate(e.message);
    }
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#user-line").textContent = state.user.email;
    await refresh();
    // Pruefmodule im Hintergrund vorwaermen
    setTimeout(() => { window.RootsSchematron.load().catch(() => {}); window.RootsFacturX.load().catch(() => {}); }, 800);
  }

  function gate(msg) {
    $("#app").classList.add("hidden");
    $("#gate").classList.remove("hidden");
    $("#gate-msg").textContent = msg;
  }

  async function refresh() {
    const [inv, cust, tpl] = await Promise.all([api("list"), api("customers"), api("templates")]);
    state.invoices = inv.invoices || [];
    state.customers = cust.customers || [];
    state.templates = tpl.templates || [];
    render();
  }

  /* --------------------------------------------------------------- Render --- */

  function render() {
    $$(".dash-nav-item.nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === state.view));
    const inList = ["list", "edit", "detail"].includes(state.view);
    $$(".filter-pill").forEach((p) => p.classList.toggle("active", inList && p.dataset.filter === state.filter));
    $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== state.view));
    if (state.view === "list") renderList();
    if (state.view === "customers") renderCustomers();
    if (state.view === "settings") renderSettings();
    if (state.view === "edit") renderEditor();
    if (state.view === "detail") renderDetail();
    renderVatBanner();
  }

  function renderVatBanner() {
    const missing = !E.vatOk(state.settings?.seller?.vat_id);
    $("#vat-banner").classList.toggle("hidden", !missing || state.view === "settings");
  }

  function statusTag(inv) {
    if (inv.status === "final") return `<span class="tag tag-ok"><i class="fa-solid fa-shield-halved"></i> E-Rechnung · EN 16931</span>`;
    if (inv.status === "cancelled") return `<span class="tag tag-bad"><i class="fa-solid fa-circle-xmark"></i> Storniert</span>`;
    return `<span class="tag tag-draft"><i class="fa-regular fa-file-lines"></i> Entwurf</span>`;
  }

  function renderList() {
    const rows = state.invoices.filter((i) => state.filter === "all" || i.status === state.filter);
    const counts = { all: state.invoices.length, draft: 0, final: 0, cancelled: 0 };
    state.invoices.forEach((i) => counts[i.status]++);
    $$(".filter-pill").forEach((p) => {
      p.querySelector(".count").textContent = counts[p.dataset.filter] || 0;
    });
    const body = $("#invoice-rows");
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7" class="empty">Keine Rechnungen</td></tr>`;
      return;
    }
    body.innerHTML = rows.map((i) => `
      <tr data-id="${esc(i.id)}" class="row-${esc(i.status)}">
        <td class="mono">${esc(i.number)}</td>
        <td>${esc(fmtDate(i.issue_date))}</td>
        <td><div class="cell-main">${esc(i.customer_name || "")}</div><div class="cell-sub">${esc(i.project || "")}</div></td>
        <td>${esc(E.TAX_CASES[i.tax_case]?.label || "")}</td>
        <td class="num">${esc(money(i.gross_cents))}</td>
        <td>${statusTag(i)}</td>
        <td class="row-actions">
          ${i.status !== "draft" ? `<button class="icon-btn" data-act="pdf" title="PDF (Factur-X)"><i class="fa-solid fa-file-pdf"></i></button>` : ""}
          <button class="icon-btn" data-act="copy" title="Als Vorlage kopieren"><i class="fa-solid fa-copy"></i></button>
        </td>
      </tr>`).join("");
  }

  /* -------------------------------------------------------------- Editor --- */

  function blankInvoice(tplId, customer) {
    const row = state.templates.find((t) => t.id === tplId) || state.templates[0] || { data: {} };
    const tpl = { lang: "de", tax_case: "S19", due_days: 30, lines: [{ label: "", detail: "" }], annex: { title: "", text: "", rows: [] }, note: "", ...row.data };
    const [ps, pe] = lastMonth();
    const issue = today();
    const c = customer?.data || {};
    return {
      id: null,
      number: nextNumber(),
      template: row.id || null,
      lang: c.lang || tpl.lang,
      tax_case: c.tax_case || tpl.tax_case,
      issue_date: issue,
      due_date: addDays(issue, Number(tpl.due_days) || 30),
      period_start: ps,
      period_end: pe,
      project: "",
      po: "",
      cost_center: "",
      buyer_reference: c.buyer_reference || "",
      ordered_by: c.contact || "",
      note: tpl.note || "",
      buyer: customer ? { name: customer.name, street: c.street || "", street2: c.street2 || "", zip: c.zip || "", city: c.city || "", country: c.country || "DE", vat_id: c.vat_id || "", email: c.email || "", contact: "" } : { name: "", street: "", street2: "", zip: "", city: "", country: "DE", vat_id: "", email: "", contact: "" },
      lines: tpl.lines.map((l) => ({ label: l.label, detail: l.detail || "", amount: "" })),
      annex: JSON.parse(JSON.stringify({ title: "", text: "", rows: [], ...(tpl.annex || {}) })),
      customer_id: customer?.id || null,
    };
  }

  function logoHtml(c, cls = "cust-logo") {
    const src = window.RootsUI.safeLogo(c?.data?.logo);
    return `<div class="${cls}">${src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : `<span class="monogram">${esc(window.RootsUI.monogram(c?.name))}</span>`}</div>`;
  }

  function customerSpecs(c) {
    const d = c.data || {};
    const country = window.RootsInvoicePdf.countryName(d.country, "de") || d.country || "";
    return [
      [d.city, country].filter(Boolean).join(" · "),
      [E.TAX_CASES[d.tax_case]?.label, d.lang === "en" ? "English" : "Deutsch"].filter(Boolean).join(" · "),
      d.vat_id ? `<span class="mono">${esc(d.vat_id)}</span>` : "",
    ].filter(Boolean).map((x) => `<span class="cust-spec">${x.startsWith("<span") ? x : esc(x)}</span>`).join("");
  }

  const newFlow = { customer: null };

  function openNew() {
    newFlow.customer = undefined;
    renderNewStep();
    $("#tpl-dialog").classList.add("open");
  }

  function renderNewStep() {
    const box = $("#new-step");
    if (newFlow.customer === undefined) {
      box.innerHTML = `
        <div class="modal-headline"><h2>Neue Rechnung</h2><button class="icon-btn" data-act="close-dialog" title="Schließen"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="cust-grid" style="grid-template-columns:repeat(${Math.min(state.customers.length + 1, 5)},minmax(0,1fr))">
          ${state.customers.map((c) => `
            <button class="cust-tile" data-pick-customer="${esc(c.id)}">
              ${logoHtml(c)}
              <span class="cust-name">${esc(c.name)}</span>
              ${customerSpecs(c)}
            </button>`).join("")}
          <button class="cust-tile cust-new" data-pick-customer="">
            <div class="cust-logo"><i class="fa-solid fa-plus"></i></div>
            <span class="cust-name">Neuer Kunde</span>
          </button>
        </div>`;
      return;
    }
    const c = newFlow.customer;
    const taxCase = c?.data?.tax_case;
    box.innerHTML = `
      <div class="modal-headline">
        <button class="btn-ghost sm" data-act="new-back"><i class="fa-solid fa-arrow-left"></i> Kunden</button>
        <h2>${c ? esc(c.name) : "Neuer Kunde"}</h2>
        <button class="icon-btn" data-act="close-dialog" title="Schließen"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tpl-grid" id="tpl-list">
        ${state.templates.map((t) => `
          <button class="tpl-card" data-tplid="${esc(t.id)}">
            <span><span class="tpl-name">${esc(t.name)}</span><span class="tpl-meta">${esc(E.TAX_CASES[t.data?.tax_case]?.label || "")} · ${t.data?.lang === "en" ? "English" : "Deutsch"} · ${esc(t.data?.due_days ?? 30)} Tage</span></span>
            ${taxCase && t.data?.tax_case === taxCase ? `<span class="tag tag-std">Passt zum Kunden</span>` : ""}
          </button>`).join("") || `<p class="cell-sub">Keine Vorlagen</p>`}
      </div>`;
  }

  let editorSnapshot = null;

  function startEditor(inv) {
    editorSnapshot = inv.id ? JSON.stringify(normalized(inv)) : null;
    state.edit = inv;
    state.check = null;
    state.view = "edit";
    render();
  }

  function fieldVal(path) {
    return path.split(".").reduce((o, k) => (o == null ? "" : o[k]), state.edit) ?? "";
  }

  function input(path, label, opts = {}) {
    const v = fieldVal(path);
    const type = opts.type || "text";
    const cls = opts.wide ? "field wide" : "field";
    if (opts.options) {
      return `<label class="${cls}"><span class="flabel">${esc(label)}</span><select data-path="${path}">${opts.options.map(([k, t]) => `<option value="${esc(k)}" ${String(v) === k ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
    }
    if (opts.type === "date") {
      return `<label class="${cls}"><span class="flabel">${esc(label)}</span><input type="text" inputmode="numeric" data-path="${path}" data-date="1" value="${esc(window.RootsUI.isoToDe(v))}" placeholder="TT.MM.JJJJ"></label>`;
    }
    if (opts.area) return `<label class="${cls}"><span class="flabel">${esc(label)}</span><textarea data-path="${path}" rows="${opts.rows || 4}">${esc(v)}</textarea></label>`;
    return `<label class="${cls}"><span class="flabel">${esc(label)}</span><input type="${type}" data-path="${path}" value="${esc(v)}" ${opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : ""} ${opts.mono ? 'class="mono"' : ""}></label>`;
  }

  function renderEditor() {
    const inv = state.edit;
    if (!inv) return;
    const tcOpts = Object.entries(E.TAX_CASES).map(([k, t]) => [k, t.label]);
    const countryOpts = Object.entries(window.RootsInvoicePdf.COUNTRIES).map(([k, n]) => [k, `${n[0]} (${k})`]);
    if (inv.buyer.country && !window.RootsInvoicePdf.COUNTRIES[inv.buyer.country]) countryOpts.push([inv.buyer.country, inv.buyer.country]);
    $("#editor").innerHTML = `
      <div class="page-head">
        <button class="btn-ghost" data-act="back"><i class="fa-solid fa-arrow-left"></i> Rechnungen</button>
        <h2>${inv.id ? "Rechnung " + esc(inv.number) : "Neue Rechnung"}</h2>
        <span id="edit-state"></span>
        <div class="head-actions">
          ${inv.id ? `<button class="btn-danger-ghost" data-act="delete-draft" title="Entwurf löschen"><i class="fa-solid fa-trash-can"></i></button>` : ""}
          <button class="btn-secondary" data-act="preview"><i class="fa-solid fa-download"></i> Entwurf</button>
          <button class="btn-secondary" data-act="save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
          <button class="btn-secondary" data-act="check"><i class="fa-solid fa-shield-halved"></i> Prüfen</button>
          <button class="btn-primary" data-act="finalize" id="btn-finalize"><i class="fa-solid fa-lock"></i> Endgültig erstellen</button>
        </div>
      </div>
      <div class="editor-split">
        <div class="editor-form">
          <section class="card check-card">
            <div class="card-head">
              <h3><i class="fa-solid fa-shield-halved"></i> E-Rechnung</h3>
              <div class="std-tags">
                <span class="tag tag-std">EN 16931</span>
                <span class="tag tag-std">Factur-X 1.09 · ZUGFeRD</span>
                <span class="tag tag-std">PDF/A-3</span>
              </div>
            </div>
            <ol class="checks" id="checks"></ol>
            <ul class="issues" id="issues"></ul>
          </section>
          <section class="card">
            <h3><i class="fa-solid fa-file-invoice"></i> Rechnung</h3>
            <div class="fields">
              ${input("number", "Rechnungsnummer", { mono: true })}
              ${input("tax_case", "Steuerfall", { options: tcOpts })}
              ${input("lang", "Sprache", { options: [["de", "Deutsch"], ["en", "English"]] })}
              ${input("issue_date", "Rechnungsdatum", { type: "date" })}
              ${input("period_start", "Leistung von", { type: "date" })}
              ${input("period_end", "Leistung bis", { type: "date" })}
              ${input("due_date", "Fällig am", { type: "date" })}
              ${input("project", "Projekt", { wide: true })}
              ${input("po", "Bestellnummer")}
              ${input("buyer_reference", "Käuferreferenz")}
              ${input("cost_center", "Kostenstelle")}
              ${input("ordered_by", inv.lang === "en" ? "Ordered by" : "Kontakt")}
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <h3><i class="fa-solid fa-building"></i> Kunde</h3>
              <div class="card-actions">
                <select id="pick-customer"><option value="">Aus Kundenliste</option>${state.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select>
                <button class="btn-ghost sm" data-act="save-customer"><i class="fa-solid fa-user-plus"></i> Als Kunde speichern</button>
              </div>
            </div>
            <div class="buyer-head">
              ${logoHtml({ name: inv.buyer.name, data: { logo: inv.buyer_logo ?? (state.customers.find((c) => c.id === inv.customer_id)?.data?.logo || "") } }, "cust-logo sm")}
              <button class="btn-ghost sm" data-act="pick-logo"><i class="fa-solid fa-image"></i> Logo</button>
              ${inv.buyer_logo ? `<button class="btn-ghost sm" data-act="drop-logo"><i class="fa-solid fa-xmark"></i></button>` : ""}
              <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden>
            </div>
            <div class="fields">
              ${input("buyer.name", "Firma", { wide: true })}
              ${input("buyer.street", "Straße / Postfach", { wide: true })}
              ${input("buyer.street2", "Adresszusatz", { wide: true })}
              ${input("buyer.zip", "PLZ")}
              ${input("buyer.city", "Ort")}
              ${input("buyer.country", "Land", { options: countryOpts })}
              ${input("buyer.vat_id", "USt-IdNr. Kunde", { mono: true })}
              ${input("buyer.email", "Rechnungs-E-Mail", { wide: true })}
            </div>
          </section>

          <section class="card">
            <div class="card-head"><h3><i class="fa-solid fa-list"></i> Positionen</h3><button class="btn-ghost sm" data-act="add-line"><i class="fa-solid fa-plus"></i> Position</button></div>
            <div class="lines">
              ${inv.lines.map((l, i) => `
                <div class="line-row">
                  <input data-path="lines.${i}.label" value="${esc(l.label)}" placeholder="Bezeichnung">
                  <input data-path="lines.${i}.detail" value="${esc(l.detail || "")}" placeholder="Zusatz">
                  <input data-path="lines.${i}.amount" value="${esc(l.amount)}" placeholder="0,00" class="num">
                  <button class="icon-btn" data-act="del-line" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
                </div>`).join("")}
            </div>
            <div class="totals" id="totals"></div>
          </section>

          <section class="card">
            <div class="card-head"><h3><i class="fa-solid fa-paperclip"></i> Anlage</h3><button class="btn-ghost sm" data-act="add-annex-row"><i class="fa-solid fa-plus"></i> Zeile</button></div>
            <div class="fields">
              ${input("annex.title", "Titel", { wide: true })}
              ${input("annex.text", "Text", { wide: true, area: true, rows: 5 })}
            </div>
            <div class="lines">
              ${(inv.annex.rows || []).map((r, i) => `
                <div class="line-row annex-row">
                  <input data-path="annex.rows.${i}.label" value="${esc(r.label)}" placeholder="Bezeichnung">
                  <input data-path="annex.rows.${i}.amount" value="${esc(r.amount || "")}" placeholder="Betrag" class="num">
                  <label class="chk"><input type="checkbox" data-path="annex.rows.${i}.bold" ${r.bold ? "checked" : ""}> fett</label>
                  <button class="icon-btn" data-act="del-annex-row" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
                </div>`).join("")}
            </div>
          </section>
        </div>
        <div class="preview-pane">
          <div class="preview-head"><span><i class="fa-regular fa-file-pdf"></i> Vorschau</span><span id="preview-info"></span></div>
          <div class="preview-pages" id="preview-pages"></div>
        </div>
      </div>`;
    window.RootsUI.enhance($("#editor"));
    $("#logo-file").addEventListener("change", async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try { state.edit.buyer_logo = await window.RootsUI.logoFromFile(f); renderEditor(); } catch (err) { toast(err.message, "err"); }
    });
    updateLive();
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const box = $("#preview-pages");
      if (!box || !state.edit) return;
      try {
        const pdf = await window.RootsInvoicePdf.render(normalized(state.edit), state.settings.seller || {}, await pdfAssets(), { final: false });
        const pages = await window.RootsUI.renderPdf(pdf, box);
        if (pages) $("#preview-info").textContent = pages === 1 ? "1 Seite" : `${pages} Seiten`;
      } catch (e) {
        $("#preview-info").textContent = e.message;
      }
    }, 350);
  }

  /** Alles, was sich bei jeder Eingabe aendert: Summen, Vorpruefung, Ampel, Vorschau. */
  function updateLive() {
    const inv = state.edit;
    if (!inv) return;
    schedulePreview();
    const t = E.totals(inv);
    const tc = E.TAX_CASES[inv.tax_case];
    $("#totals").innerHTML = tc && tc.category === "S"
      ? `<div><span>Netto</span><b>${money(t.net)}</b></div><div><span>19 % USt</span><b>${money(t.tax)}</b></div><div class="grand"><span>Brutto</span><b>${money(t.gross)}</b></div>`
      : `<div class="grand"><span>Rechnungsbetrag</span><b>${money(t.gross)}</b></div><div class="tax-note">${esc(tc ? tc[inv.lang === "en" ? "en" : "de"] : "")}</div>`;

    const issues = E.precheck(inv, state.settings.seller || {});
    if (state.invoices.some((i) => i.number === inv.number && i.id !== inv.id)) issues.unshift({ level: "error", rule: "BR-02", field: "number", text: "Rechnungsnummer ist bereits vergeben." });
    const fp = fingerprint();
    const check = state.check && state.check.fingerprint === fp ? state.check : null;
    const errors = issues.filter((m) => m.level === "error");

    const step = (ok, label, detail) => `<li class="${ok === true ? "ok" : ok === false ? "bad" : "open"}"><i class="${ok === true ? "fa-solid fa-circle-check" : ok === false ? "fa-solid fa-circle-xmark" : "fa-regular fa-circle"}"></i><span>${esc(label)}</span>${detail ? `<em>${esc(detail)}</em>` : ""}</li>`;
    $("#checks").innerHTML =
      step(errors.length ? false : true, "Pflichtangaben § 14 UStG", errors.length ? `${errors.length} offen` : "") +
      step(check ? check.schematron.passed : null, "Schematron EN 16931", check ? (check.schematron.passed ? "" : `${check.schematron.errors.length} Verstöße`) : "") +
      step(check ? check.fx?.xsd === "passed" : null, "XSD Factur-X EN 16931", "") +
      step(check ? check.fx?.roundtrip === "passed" : null, "PDF/A-3 mit factur-x.xml", "") +
      step(null, "Serverprüfung", "beim Erstellen");

    const schem = check && !check.schematron.passed ? check.schematron.errors.map((e) => ({ level: "error", rule: e.id, text: e.text })) : [];
    const xsdErr = check && check.fx && check.fx.xsd !== "passed" ? [{ level: "error", rule: "XSD", text: check.fx.xsd_error || "XSD nicht bestanden" }] : [];
    const all = [...issues, ...schem, ...xsdErr];
    $("#issues").innerHTML = all.map((m) => `<li class="${m.level}"><b>${esc(m.rule)}</b> ${esc(m.text)}</li>`).join("");

    const ready = !!check && check.passed && !errors.length;
    $("#btn-finalize").disabled = !ready || state.busy;
    $("#edit-state").innerHTML = ready
      ? `<span class="tag tag-ok"><i class="fa-solid fa-shield-halved"></i> Geprüft · bereit</span>`
      : `<span class="tag tag-draft"><i class="fa-regular fa-file-lines"></i> Entwurf · nicht versendbar</span>`;

    $$("[data-path]").forEach((el) => {
      const p = el.dataset.path;
      const hit = issues.some((m) => m.level === "error" && (m.field === p || (m.field === "period" && (p === "period_start" || p === "period_end"))));
      el.classList.toggle("invalid", hit);
      el._csFill?.();
    });
  }

  function fingerprint() {
    return JSON.stringify([normalized(state.edit), state.settings.seller]);
  }

  function normalized(inv) {
    const t = E.totals(inv);
    return {
      ...inv,
      number: String(inv.number || "").trim(),
      buyer: { ...inv.buyer, country: String(inv.buyer.country || "").toUpperCase(), vat_id: String(inv.buyer.vat_id || "").replace(/\s+/g, "").toUpperCase() },
      lines: inv.lines.map((l, i) => ({ ...l, amount_cents: Number.isFinite(t.lines[i]) ? t.lines[i] : null })),
    };
  }

  function setPath(path, value) {
    const keys = path.split(".");
    let o = state.edit;
    keys.slice(0, -1).forEach((k) => { o = o[k]; });
    o[keys[keys.length - 1]] = value;
  }

  async function saveDraft(quiet) {
    const inv = normalized(state.edit);
    if (!inv.number) throw new Error("Rechnungsnummer fehlt.");
    const t = E.totals(inv);
    const res = await api("save", {
      id: inv.id,
      row: {
        number: inv.number,
        data: { ...inv, id: undefined },
        customer_name: inv.buyer.name || null,
        issue_date: inv.issue_date || null,
        tax_case: inv.tax_case,
        net_cents: t.net, tax_cents: t.tax, gross_cents: t.gross,
      },
    });
    state.edit.id = res.id;
    const idx = state.invoices.findIndex((i) => i.id === res.id);
    const listRow = { id: res.id, number: inv.number, status: "draft", customer_name: inv.buyer.name, issue_date: inv.issue_date, tax_case: inv.tax_case, gross_cents: t.gross, project: inv.project };
    if (idx >= 0) state.invoices[idx] = { ...state.invoices[idx], ...listRow };
    else state.invoices.unshift(listRow);
    editorSnapshot = JSON.stringify(normalized(state.edit));
    if (!quiet) toast("Entwurf gespeichert");
  }

  async function runCheck() {
    const inv = normalized(state.edit);
    const seller = state.settings.seller || {};
    const pre = E.precheck(inv, seller).filter((m) => m.level === "error");
    if (pre.length) {
      state.check = null;
      updateLive();
      toast("Pflichtangaben fehlen", "err");
      return null;
    }
    setBusy(true, "Schematron EN 16931");
    try {
      await saveDraft(true);
      const fp = fingerprint();
      const xml = E.buildXml(inv, seller);
      const schematron = await window.RootsSchematron.validate(xml);
      let fx = null;
      if (schematron.passed) {
        setBusy(true, "PDF wird erzeugt");
        const pdf = await window.RootsInvoicePdf.render(inv, seller, await pdfAssets(), { final: true });
        fx = await window.RootsFacturX.build(pdf, xml, inv.lang === "en" ? "en-GB" : "de-DE", (s) => setBusy(true, s));
      }
      const passed = schematron.passed && fx?.xsd === "passed" && fx?.roundtrip === "passed";
      state.check = { fingerprint: fp, schematron, fx, xml, passed };
      toast(passed ? "E-Rechnung gültig" : "Prüfung nicht bestanden", passed ? "ok" : "err");
      return state.check;
    } finally {
      setBusy(false);
      updateLive();
    }
  }

  async function finalize() {
    const inv = state.edit;
    if (!state.check || state.check.fingerprint !== fingerprint() || !state.check.passed) {
      toast("Erst prüfen", "err");
      return;
    }
    const ok = await confirmDialog(`Rechnung ${inv.number} endgültig erstellen?`, "Danach ist sie unveränderlich. Korrekturen nur noch über Storno.", "Endgültig erstellen");
    if (!ok) return;
    setBusy(true, "Serverprüfung");
    try {
      const c = state.check;
      await api("finalize", {
        id: inv.id,
        xml: c.xml,
        pdf: c.fx.pdf,
        validation: {
          precheck: "passed",
          schematron: "passed",
          schematron_version: c.schematron.version,
          schematron_warnings: c.schematron.warnings.map((w) => w.id),
          xsd: c.fx.xsd,
          roundtrip: c.fx.roundtrip,
          lib: c.fx.lib,
          checked_at: new Date().toISOString(),
        },
      });
      toast(`Rechnung ${inv.number} erstellt`, "ok");
      const id = inv.id;
      state.edit = null;
      state.check = null;
      state.view = "list";
      await refresh();
      openDetail(id);
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function previewDraft() {
    const inv = normalized(state.edit);
    setBusy(true, "Entwurf wird erzeugt");
    try {
      const pdf = await window.RootsInvoicePdf.render(inv, state.settings.seller || {}, await pdfAssets(), { final: false });
      download(pdf, `ENTWURF_${safeName(inv.number)}_${safeName(inv.buyer.name)}.pdf`, "application/pdf");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------------------------------------- Detail --- */

  let detail = null;

  async function openDetail(id) {
    setBusy(true, "Rechnung wird geladen");
    try {
      detail = (await api("get", { id })).invoice;
      state.view = detail.status === "draft" ? "edit" : "detail";
      if (detail.status === "draft") {
        state.edit = { ...detail.data, id: detail.id, number: detail.number };
        editorSnapshot = JSON.stringify(normalized(state.edit));
        state.check = null;
      }
      render();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  function renderDetail() {
    const d = detail;
    if (!d) return;
    const v = d.validation || {};
    const t = { net: d.net_cents, tax: d.tax_cents, gross: d.gross_cents };
    const row = (k, val) => `<div class="kv"><span>${esc(k)}</span><b>${val}</b></div>`;
    const ok = (s) => (s === "passed" ? `<span class="tag tag-ok sm"><i class="fa-solid fa-check"></i> bestanden</span>` : `<span class="tag tag-bad sm">${esc(s || "offen")}</span>`);
    $("#detail").innerHTML = `
      <div class="page-head">
        <button class="btn-ghost" data-act="back"><i class="fa-solid fa-arrow-left"></i> Rechnungen</button>
        <h2>Rechnung ${esc(d.number)}</h2>
        ${statusTag(d)}
      </div>
      <div class="editor-grid">
        <div class="editor-form">
          <section class="card">
            <h3>${esc(d.customer_name || "")}</h3>
            ${row("Projekt", esc(d.data?.project || ""))}
            ${row("Rechnungsdatum", esc(fmtDate(d.issue_date)))}
            ${row("Leistungszeitraum", `${esc(fmtDate(d.data?.period_start))} bis ${esc(fmtDate(d.data?.period_end))}`)}
            ${row("Fällig", esc(fmtDate(d.data?.due_date)))}
            ${row("Bestellung", esc(d.data?.po || ""))}
            ${row("Steuerfall", esc(E.TAX_CASES[d.tax_case]?.label || ""))}
            ${row("Netto", esc(money(t.net)))}
            ${row("Umsatzsteuer", esc(money(t.tax)))}
            ${row("Brutto", esc(money(t.gross)))}
            ${d.status === "cancelled" ? row("Storniert", `${esc(fmtDate(d.cancelled_at))} · ${esc(d.cancel_reason || "")}`) : ""}
          </section>
          <section class="card">
            <h3><i class="fa-solid fa-clipboard-check"></i> Prüfprotokoll</h3>
            ${row("Pflichtangaben", ok(v.precheck))}
            ${row(`Schematron (${esc(v.schematron_version || "EN 16931")})`, ok(v.schematron))}
            ${row("XSD Factur-X EN 16931", ok(v.xsd))}
            ${row("PDF/A-3 · factur-x.xml eingebettet", ok(v.roundtrip))}
            ${row("Serverprüfung", ok(v.server))}
            ${row("Erstellt", esc(new Date(d.finalized_at).toLocaleString("de-DE")))}
            ${row("SHA-256 PDF", `<code>${esc(d.pdf_sha256 || "")}</code>`)}
            ${row("SHA-256 XML", `<code>${esc(d.xml_sha256 || "")}</code>`)}
          </section>
        </div>
        <aside class="editor-side">
          <section class="card sticky">
            <h3><i class="fa-solid fa-shield-halved"></i> E-Rechnung</h3>
            <div class="std-tags">
              <span class="tag tag-std">EN 16931</span>
              <span class="tag tag-std">Factur-X 1.09 · ZUGFeRD</span>
              <span class="tag tag-std">PDF/A-3</span>
            </div>
            <div class="side-actions">
              <button class="btn-primary" data-act="dl-pdf"><i class="fa-solid fa-file-pdf"></i> PDF mit E-Rechnung</button>
              <button class="btn-secondary" data-act="dl-xml"><i class="fa-solid fa-code"></i> XML (CII)</button>
              <button class="btn-secondary" data-act="validator"><i class="fa-solid fa-arrow-up-right-from-square"></i> Externer Validator BW</button>
              <button class="btn-secondary" data-act="copy-detail"><i class="fa-solid fa-copy"></i> Als Vorlage kopieren</button>
              ${d.status === "final" ? `<button class="btn-danger-ghost" data-act="cancel"><i class="fa-solid fa-circle-xmark"></i> Stornieren</button>` : ""}
            </div>
          </section>
        </aside>
      </div>`;
  }

  async function downloadPdf(id, number, customer) {
    setBusy(true, "PDF wird geladen");
    try {
      const res = await api("pdf", { id });
      const bytes = window.RootsFacturX.base64ToBytes(res.pdf);
      download(bytes, `Rechnung_${safeName(number)}_${safeName(customer)}.pdf`, "application/pdf");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  function copyAsTemplate(data) {
    const inv = JSON.parse(JSON.stringify(data));
    const [ps, pe] = lastMonth();
    inv.id = null;
    inv.number = nextNumber();
    inv.issue_date = today();
    inv.due_date = addDays(inv.issue_date, 30);
    inv.period_start = ps;
    inv.period_end = pe;
    inv.lines = (inv.lines || []).map((l) => ({ label: l.label, detail: l.detail || "", amount: "" }));
    startEditor(inv);
  }

  /* ------------------------------------------------------------- Kunden --- */

  function renderCustomers() {
    $("#customer-rows").innerHTML = state.customers.length
      ? state.customers.map((c) => {
          const d = c.data || {};
          return `<tr data-cid="${esc(c.id)}">
            <td><div class="cell-with-logo">${logoHtml(c, "cust-logo xs")}<div><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc([d.street, `${d.zip || ""} ${d.city || ""}`.trim(), d.country].filter(Boolean).join(", "))}</div></div></div></td>
            <td class="mono">${esc(d.vat_id || "")}</td>
            <td>${esc(E.TAX_CASES[d.tax_case]?.label || "")}</td>
            <td>${esc(d.email || "")}</td>
            <td class="row-actions">
              <button class="icon-btn" data-act="new-for" title="Neue Rechnung"><i class="fa-solid fa-plus"></i></button>
              <button class="icon-btn" data-act="edit-customer" title="Bearbeiten"><i class="fa-solid fa-pen"></i></button>
            </td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="5" class="empty">Keine Kunden</td></tr>`;
  }

  function customerDialog(c) {
    const d = c?.data || {};
    const f = (k, label, v, extra = "") => `<label class="field"><span class="flabel">${esc(label)}</span><input name="${k}" value="${esc(v || "")}" ${extra}></label>`;
    $("#cust-form").innerHTML = `
      <input type="hidden" name="id" value="${esc(c?.id || "")}">
      <div class="fields">
        <label class="field wide"><span class="flabel">Firma</span><input name="name" value="${esc(c?.name || "")}" required></label>
        <label class="field wide"><span class="flabel">Straße / Postfach</span><input name="street" value="${esc(d.street || "")}"></label>
        <label class="field wide"><span class="flabel">Adresszusatz</span><input name="street2" value="${esc(d.street2 || "")}"></label>
        ${f("zip", "PLZ", d.zip)}
        ${f("city", "Ort", d.city)}
        ${f("country", "Land (ISO)", d.country || "DE", 'maxlength="2"')}
        ${f("vat_id", "USt-IdNr.", d.vat_id)}
        <label class="field"><span class="flabel">Steuerfall</span><select name="tax_case">${Object.entries(E.TAX_CASES).map(([k, t]) => `<option value="${k}" ${d.tax_case === k ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label>
        <label class="field"><span class="flabel">Sprache</span><select name="lang"><option value="de" ${d.lang !== "en" ? "selected" : ""}>Deutsch</option><option value="en" ${d.lang === "en" ? "selected" : ""}>English</option></select></label>
        ${f("email", "Rechnungs-E-Mail", d.email)}
        ${f("contact", "Kontakt", d.contact)}
        ${f("buyer_reference", "Käuferreferenz", d.buyer_reference)}
      </div>`;
    $("#cust-form").insertAdjacentHTML("afterbegin", `
      <div class="buyer-head">
        <div id="cust-logo-prev">${logoHtml(c || { name: "" }, "cust-logo sm")}</div>
        <input type="hidden" name="logo" value="${esc(window.RootsUI.safeLogo(d.logo))}">
        <button type="button" class="btn-ghost sm" id="cust-logo-btn"><i class="fa-solid fa-image"></i> Logo</button>
        <input type="file" id="cust-logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden>
      </div>`);
    $("#cust-logo-btn").onclick = () => $("#cust-logo-file").click();
    $("#cust-logo-file").onchange = async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const url = await window.RootsUI.logoFromFile(f);
        $("#cust-form [name=logo]").value = url;
        $("#cust-logo-prev").innerHTML = logoHtml({ name: $("#cust-form [name=name]").value, data: { logo: url } }, "cust-logo sm");
      } catch (err) { toast(err.message, "err"); }
    };
    window.RootsUI.enhance($("#cust-form"));
    $("#cust-delete").classList.toggle("hidden", !c?.id);
    $("#cust-dialog").classList.add("open");
  }

  async function saveCustomer(form) {
    const fd = Object.fromEntries(new FormData(form).entries());
    const { id, name, ...data } = fd;
    data.country = String(data.country || "").toUpperCase();
    data.vat_id = String(data.vat_id || "").replace(/\s+/g, "").toUpperCase();
    await api("customer_save", { id: id || null, name, data });
    $("#cust-dialog").classList.remove("open");
    state.customers = (await api("customers")).customers || [];
    render();
    toast("Kunde gespeichert");
  }

  /* --------------------------------------------------------- Stammdaten --- */

  const SELLER_FIELDS = [
    ["name", "Firma"], ["street", "Straße"], ["zip", "PLZ"], ["city", "Ort"], ["country", "Land (ISO)"],
    ["vat_id", "USt-IdNr."], ["tax_number", "Steuernummer"], ["register", "Handelsregister"], ["court", "Registergericht"],
    ["ceo", "Geschäftsführer"], ["bank", "Bank"], ["iban", "IBAN"], ["bic", "BIC"], ["email", "E-Mail"], ["web", "Website"],
  ];

  function renderSettings() {
    const s = state.settings || {};
    const seller = s.seller || {};
    $("#settings-form").innerHTML = `
      <section class="card">
        <h3><i class="fa-solid fa-landmark"></i> Rechnungssteller</h3>
        <div class="fields">
          ${SELLER_FIELDS.map(([k, label]) => `<label class="field ${k === "name" ? "wide" : ""}"><span class="flabel">${esc(label)}</span><input name="seller.${k}" value="${esc(seller[k] || "")}" class="${["vat_id", "iban", "bic", "tax_number"].includes(k) ? "mono" : ""} ${k === "vat_id" && !E.vatOk(seller.vat_id) ? "invalid" : ""}"></label>`).join("")}
        </div>
        ${!E.vatOk(seller.vat_id) ? `<p class="warn-line"><i class="fa-solid fa-triangle-exclamation"></i> USt-IdNr. fehlt · Reverse-Charge-Rechnungen sind gesperrt (§ 14a UStG)</p>` : ""}
        ${seller.iban && !E.ibanOk(seller.iban) ? `<p class="warn-line"><i class="fa-solid fa-triangle-exclamation"></i> IBAN-Prüfziffer falsch</p>` : ""}
      </section>
      <section class="card">
        <h3><i class="fa-solid fa-hashtag"></i> Nummernkreis</h3>
        <div class="fields">
          <label class="field"><span class="flabel">Präfix</span><input name="number_prefix" value="${esc(s.number_prefix || "")}" class="mono"></label>
          <label class="field"><span class="flabel">Letzte Nummer</span><input name="number_last" inputmode="numeric" value="${esc(s.number_last || 0)}" class="mono"></label>
          <label class="field"><span class="flabel">Schrittweite</span><input name="number_step" inputmode="numeric" value="${esc(s.number_step || 1)}" class="mono"></label>
          <label class="field"><span class="flabel">Nächste Nummer</span><input value="${esc(nextNumber())}" class="mono" disabled></label>
        </div>
      </section>
      <div class="form-actions"><button class="btn-primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Stammdaten speichern</button></div>`;
    renderTemplates();
  }

  function renderTemplates() {
    if (!$("#tpl-settings")) return;
    const t = state.tplEdit;
    const tcOpts = Object.entries(E.TAX_CASES).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join("");
    if (!t) {
      $("#tpl-settings").innerHTML = `
        <div class="card-head"><h3><i class="fa-solid fa-layer-group"></i> Vorlagen</h3><button class="btn-ghost sm" data-act="tpl-new"><i class="fa-solid fa-plus"></i> Vorlage</button></div>
        <div class="tpl-grid">${state.templates.map((x) => `
          <button class="tpl-card" data-act="tpl-edit" data-id="${esc(x.id)}">
            <span class="tpl-name">${esc(x.name)}</span>
            <span class="tpl-meta">${esc(E.TAX_CASES[x.data?.tax_case]?.label || "")} · ${x.data?.lang === "en" ? "English" : "Deutsch"} · ${esc(x.data?.due_days || 30)} Tage</span>
          </button>`).join("")}</div>`;
      return;
    }
    const d = t.data;
    $("#tpl-settings").innerHTML = `
      <div class="card-head"><h3><i class="fa-solid fa-layer-group"></i> Vorlage bearbeiten</h3></div>
      <div class="fields" id="tpl-form">
        <label class="field wide"><span class="flabel">Name</span><input data-tpl="name" value="${esc(t.name)}"></label>
        <label class="field"><span class="flabel">Kurzinfo</span><input data-tpl="data.hint" value="${esc(d.hint || "")}"></label>
        <label class="field"><span class="flabel">Sprache</span><select data-tpl="data.lang"><option value="de">Deutsch</option><option value="en">English</option></select></label>
        <label class="field"><span class="flabel">Steuerfall</span><select data-tpl="data.tax_case">${tcOpts}</select></label>
        <label class="field"><span class="flabel">Zahlungsziel (Tage)</span><input inputmode="numeric" data-tpl="data.due_days" value="${esc(d.due_days ?? 30)}"></label>
        <label class="field"><span class="flabel">Reihenfolge</span><input inputmode="numeric" data-tpl="sort" value="${esc(t.sort ?? 0)}"></label>
        <label class="field wide"><span class="flabel">Anlage · Titel</span><input data-tpl="data.annex.title" value="${esc(d.annex?.title || "")}"></label>
        <label class="field wide"><span class="flabel">Anlage · Text</span><textarea rows="3" data-tpl="data.annex.text">${esc(d.annex?.text || "")}</textarea></label>
        <label class="field wide"><span class="flabel">Hinweis im XML</span><input data-tpl="data.note" value="${esc(d.note || "")}"></label>
      </div>
      <div class="card-head" style="margin-top:16px"><h3><i class="fa-solid fa-list"></i> Standardpositionen</h3><button class="btn-ghost sm" data-act="tpl-add-line"><i class="fa-solid fa-plus"></i> Position</button></div>
      <div class="lines">${(d.lines || []).map((l, i) => `
        <div class="line-row tpl-line">
          <input data-tpl-line="${i}.label" value="${esc(l.label)}" placeholder="Bezeichnung">
          <input data-tpl-line="${i}.detail" value="${esc(l.detail || "")}" placeholder="Zusatz">
          <button class="icon-btn" data-act="tpl-del-line" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
        </div>`).join("")}</div>
      <div class="modal-actions">
        ${t.id ? `<button class="btn-danger-ghost" data-act="tpl-delete" style="margin-right:auto">Löschen</button>` : ""}
        <button class="btn-secondary" data-act="tpl-cancel">Abbrechen</button>
        <button class="btn-primary" data-act="tpl-save"><i class="fa-solid fa-floppy-disk"></i> Vorlage speichern</button>
      </div>`;
    $('[data-tpl="data.lang"]').value = d.lang || "de";
    $('[data-tpl="data.tax_case"]').value = d.tax_case || "S19";
    window.RootsUI.enhance($("#tpl-settings"));
  }

  /** Formularwerte der Vorlage in state.tplEdit uebernehmen. */
  function readTpl() {
    const t = state.tplEdit;
    if (!t) return;
    $$("#tpl-settings [data-tpl]").forEach((el) => {
      const keys = el.dataset.tpl.split(".");
      let o = t;
      keys.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; });
      const k = keys[keys.length - 1];
      o[k] = el.inputMode === "numeric" ? Number(el.value) || 0 : el.value;
    });
    $$("[data-tpl-line]").forEach((el) => {
      const [i, k] = el.dataset.tplLine.split(".");
      t.data.lines[Number(i)][k] = el.value;
    });
  }

  async function saveSettings(form) {
    const fd = new FormData(form);
    const seller = {};
    SELLER_FIELDS.forEach(([k]) => { seller[k] = String(fd.get("seller." + k) || "").trim(); });
    seller.country = seller.country.toUpperCase();
    seller.vat_id = seller.vat_id.replace(/\s+/g, "").toUpperCase();
    if (seller.iban && !E.ibanOk(seller.iban)) return toast("IBAN-Prüfziffer falsch", "err");
    if (seller.vat_id && !E.vatOk(seller.vat_id)) return toast("USt-IdNr. hat kein gültiges Format", "err");
    const res = await api("settings_save", {
      settings: {
        seller,
        number_prefix: String(fd.get("number_prefix") || ""),
        number_last: Number(fd.get("number_last")) || 0,
        number_step: Math.max(1, Number(fd.get("number_step")) || 1),
      },
    });
    state.settings = res.settings;
    render();
    toast("Stammdaten gespeichert");
  }

  /* ------------------------------------------------------------- Dialoge --- */

  function confirmDialog(title, text, okLabel, withReason) {
    return new Promise((resolve) => {
      const dlg = $("#confirm-dialog");
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text;
      $("#confirm-ok").textContent = okLabel;
      const reason = $("#confirm-reason");
      reason.classList.toggle("hidden", !withReason);
      reason.value = "";
      dlg.classList.add("open");
      const done = (val) => {
        dlg.classList.remove("open");
        $("#confirm-ok").onclick = null;
        $("#confirm-cancel").onclick = null;
        resolve(val);
      };
      $("#confirm-ok").onclick = () => {
        if (withReason && !reason.value.trim()) { reason.classList.add("invalid"); return; }
        done(withReason ? reason.value.trim() : true);
      };
      $("#confirm-cancel").onclick = () => done(false);
    });
  }

  /* --------------------------------------------------------------- Events --- */

  function wire() {
    document.addEventListener("click", async (e) => {
      const tab = e.target.closest(".nav-tab");
      if (tab) {
        if (state.view === "edit" && !(await leaveEditor())) return;
        state.view = tab.dataset.view;
        return render();
      }
      const pill = e.target.closest(".filter-pill");
      if (pill) {
        if (state.view === "edit" && !(await leaveEditor())) return;
        state.filter = pill.dataset.filter;
        state.view = "list"; state.edit = null;
        return render();
      }

      const pick = e.target.closest("[data-pick-customer]");
      if (pick) {
        newFlow.customer = state.customers.find((c) => c.id === pick.dataset.pickCustomer) || null;
        return renderNewStep();
      }
      const tpl = e.target.closest("#tpl-list .tpl-card");
      if (tpl) {
        $("#tpl-dialog").classList.remove("open");
        if (state.view === "edit" && !(await leaveEditor())) return;
        return startEditor(blankInvoice(tpl.dataset.tplid, newFlow.customer || null));
      }

      const btn = e.target.closest("[data-act]");
      const tr = e.target.closest("tr[data-id]");
      if (!btn && tr) return openDetail(tr.dataset.id);
      const ctr = e.target.closest("tr[data-cid]");
      if (!btn && ctr) return customerDialog(state.customers.find((c) => c.id === ctr.dataset.cid));
      if (!btn) return;
      const act = btn.dataset.act;
      try {
        switch (act) {
          case "new": return openNew();
          case "new-back": newFlow.customer = undefined; return renderNewStep();
          case "pick-logo": return $("#logo-file").click();
          case "drop-logo": state.edit.buyer_logo = ""; return renderEditor();
          case "close-dialog": return btn.closest(".modal-overlay").classList.remove("open");
          case "back":
            if (state.view === "edit" && !(await leaveEditor())) return;
            state.view = "list"; state.edit = null; detail = null; return render();
          case "add-line": state.edit.lines.push({ label: "", detail: "", amount: "" }); return renderEditor();
          case "del-line": state.edit.lines.splice(Number(btn.dataset.i), 1); return renderEditor();
          case "add-annex-row": (state.edit.annex.rows = state.edit.annex.rows || []).push({ label: "", amount: "", bold: false }); return renderEditor();
          case "del-annex-row": state.edit.annex.rows.splice(Number(btn.dataset.i), 1); return renderEditor();
          case "save": setBusy(true, "Speichern"); try { await saveDraft(); } finally { setBusy(false); } return updateLive();
          case "preview": return previewDraft();
          case "check": return void (await runCheck());
          case "finalize": return finalize();
          case "delete-draft":
            if (!(await confirmDialog(`Entwurf ${state.edit.number} löschen?`, "", "Löschen"))) return;
            await api("delete", { id: state.edit.id });
            state.edit = null; state.view = "list"; await refresh(); return toast("Entwurf gelöscht");
          case "save-customer": {
            const b = state.edit.buyer;
            if (!b.name) return toast("Firma fehlt", "err");
            const existing = state.customers.find((c) => c.id === state.edit.customer_id) || state.customers.find((c) => c.name === b.name);
            await api("customer_save", { id: existing?.id || null, name: b.name, data: { logo: state.edit.buyer_logo ?? existing?.data?.logo ?? "", street: b.street, street2: b.street2, zip: b.zip, city: b.city, country: b.country, vat_id: b.vat_id, email: b.email, tax_case: state.edit.tax_case, lang: state.edit.lang, contact: state.edit.ordered_by, buyer_reference: state.edit.buyer_reference } });
            state.customers = (await api("customers")).customers || [];
            return toast("Kunde gespeichert");
          }
          case "pdf": {
            const row = state.invoices.find((i) => i.id === tr.dataset.id);
            return downloadPdf(row.id, row.number, row.customer_name);
          }
          case "copy": {
            const full = (await api("get", { id: tr.dataset.id })).invoice;
            return copyAsTemplate(full.data);
          }
          case "copy-detail": return copyAsTemplate(detail.data);
          case "dl-pdf": return downloadPdf(detail.id, detail.number, detail.customer_name);
          case "dl-xml": return download(new TextEncoder().encode(detail.xml), `${safeName(detail.number)}_factur-x.xml`, "application/xml");
          case "validator": return openExternal(VALIDATOR_URL);
          case "cancel": {
            const reason = await confirmDialog(`Rechnung ${detail.number} stornieren?`, "Die Rechnung bleibt gespeichert und wird als storniert markiert. Eine Gutschrift an den Kunden ist separat zu erstellen.", "Stornieren", true);
            if (!reason) return;
            await api("cancel", { id: detail.id, reason });
            await refresh();
            return openDetail(detail.id);
          }
          case "new-for": {
            const c = state.customers.find((x) => x.id === ctr.dataset.cid);
            const t = state.templates.find((x) => x.data?.tax_case === c?.data?.tax_case) || state.templates[0];
            return startEditor(blankInvoice(t?.id, c));
          }
          case "edit-customer": return customerDialog(state.customers.find((c) => c.id === ctr.dataset.cid));
          case "new-customer": return customerDialog(null);
          case "tpl-edit": state.tplEdit = JSON.parse(JSON.stringify(state.templates.find((t) => t.id === btn.dataset.id))); return renderSettings();
          case "tpl-new": state.tplEdit = { id: null, name: "Neue Vorlage", sort: state.templates.length + 1, data: { hint: "", lang: "de", tax_case: "S19", due_days: 30, lines: [{ label: "Beratungshonorar", detail: "" }, { label: "Expenses", detail: "" }], annex: { title: "", text: "", rows: [] }, note: "" } }; return renderSettings();
          case "tpl-cancel": state.tplEdit = null; return renderSettings();
          case "tpl-add-line": readTpl(); state.tplEdit.data.lines.push({ label: "", detail: "" }); return renderSettings();
          case "tpl-del-line": readTpl(); state.tplEdit.data.lines.splice(Number(btn.dataset.i), 1); return renderSettings();
          case "tpl-save": {
            readTpl();
            const t = state.tplEdit;
            if (!t.name.trim()) return toast("Name fehlt", "err");
            await api("template_save", { id: t.id, name: t.name, sort: t.sort, data: t.data });
            state.templates = (await api("templates")).templates || [];
            state.tplEdit = null; renderSettings(); return toast("Vorlage gespeichert");
          }
          case "tpl-delete": {
            if (!(await confirmDialog(`Vorlage „${state.tplEdit.name}“ löschen?`, "", "Löschen"))) return;
            await api("template_delete", { id: state.tplEdit.id });
            state.templates = (await api("templates")).templates || [];
            state.tplEdit = null; return renderSettings();
          }
          case "delete-customer": {
            const id = $("#cust-form [name=id]").value;
            if (!id || !(await confirmDialog("Kunden löschen?", "", "Löschen"))) return;
            await api("customer_delete", { id });
            $("#cust-dialog").classList.remove("open");
            state.customers = (await api("customers")).customers || [];
            return render();
          }
        }
      } catch (err) {
        setBusy(false);
        toast(err.message, "err");
      }
    });

    document.addEventListener("input", (e) => {
      const el = e.target.closest("[data-path]");
      if (!el || !state.edit) return;
      setPath(el.dataset.path, el.type === "checkbox" ? el.checked : el.dataset.date ? window.RootsUI.deToIso(el.value) : el.value);
      updateLive();
    });
    document.addEventListener("change", (e) => {
      if (e.target.id === "pick-customer" && e.target.value) {
        const c = state.customers.find((x) => x.id === e.target.value);
        const d = c?.data || {};
        Object.assign(state.edit.buyer, { name: c.name, street: d.street || "", street2: d.street2 || "", zip: d.zip || "", city: d.city || "", country: d.country || "DE", vat_id: d.vat_id || "", email: d.email || "" });
        if (d.tax_case) state.edit.tax_case = d.tax_case;
        if (d.lang) state.edit.lang = d.lang;
        if (d.contact) state.edit.ordered_by = d.contact;
        if (d.buyer_reference) state.edit.buyer_reference = d.buyer_reference;
        state.edit.customer_id = c.id;
        state.edit.buyer_logo = d.logo || "";
        return renderEditor();
      }
      const el = e.target.closest("select[data-path]");
      if (el && state.edit && (el.dataset.path === "lang" || el.dataset.path === "tax_case")) renderEditor();
    });

    $("#cust-form").addEventListener("submit", (e) => { e.preventDefault(); saveCustomer(e.target).catch((err) => toast(err.message, "err")); });
    $("#settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(e.target).catch((err) => toast(err.message, "err")); });
  }

  async function leaveEditor() {
    if (!state.edit) return true;
    const dirty = !state.edit.id || JSON.stringify(normalized(state.edit)) !== editorSnapshot;
    if (!dirty) return true;
    return confirmDialog("Änderungen verwerfen?", "", "Verwerfen");
  }
  document.addEventListener("DOMContentLoaded", () => {
    wire();
    boot();
  });
})();
