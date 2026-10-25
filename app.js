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
  const RT = window.RootsRich;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));


  const state = {
    user: null,
    settings: null,
    invoices: [],
    customers: [],
    templates: [],
    sequences: [],
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

  /** Nummernkreis der Vorlage einer Rechnung. */
  function sequenceOf(inv) {
    const tpl = state.templates.find((t) => t.id === inv?.template);
    return state.sequences.find((q) => q.id === tpl?.data?.sequence_id) || null;
  }

  /** Naechste freie Nummer eines Kreises, wie rg_reserve_number sie vergeben wuerde. */
  function previewNumber(seq) {
    if (!seq || seq.next_number == null) return "";
    let n = Number(seq.next_number);
    const used = new Set(state.invoices.map((i) => i.number).filter(Boolean));
    while (used.has(seq.prefix + n)) n += Number(seq.step) || 1;
    return seq.prefix + n;
  }

  async function refreshSequences() {
    try { state.sequences = (await api("sequences")).sequences || []; renderVatBanner(); } catch (_) { /* naechster Versuch beim Laden */ }
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

  /* ------------------------------------------------------ Anlage-Dateien --- */

  /** sha256 -> Bytes. Bilder und angehaengte Dateien liegen inhaltsadressiert in rg_files. */
  const files = new Map();
  const fileUrls = new Map();

  function fileUrl(sha) {
    if (!fileUrls.has(sha) && files.has(sha)) fileUrls.set(sha, URL.createObjectURL(new Blob([files.get(sha)])));
    return fileUrls.get(sha) || "";
  }

  async function putFile(name, mime, bytes) {
    const local = await window.RootsAnnex.sha256(bytes);
    if (!files.has(local)) {
      const res = await api("file_put", { name, mime, base64: window.RootsFacturX.bytesToBase64(bytes) });
      if (res.sha256 !== local) throw new Error("Die Datei kam verändert beim Server an.");
      files.set(local, bytes);
    }
    return local;
  }

  function annexShas(inv) {
    const a = inv?.annex || {};
    return [...(a.images || []), ...(a.files || [])].map((x) => x && x.sha).filter(Boolean);
  }

  /** Fehlende Anlagen nachladen und gegen ihren Hash pruefen. */
  async function ensureFiles(inv) {
    const missing = [...new Set(annexShas(inv))].filter((sha) => !files.has(sha));
    await Promise.all(missing.map(async (sha) => {
      const res = await api("file_get", { sha });
      const bytes = window.RootsFacturX.base64ToBytes(res.base64);
      if ((await window.RootsAnnex.sha256(bytes)) !== sha) throw new Error(`Anlage ${res.name || ""} ist beschädigt.`);
      files.set(sha, bytes);
    }));
  }

  const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fileIcon = (name) => (/\.xls[xm]?$/i.test(name) ? "fa-file-excel" : /\.docx?$/i.test(name) ? "fa-file-word" : /\.pdf$/i.test(name) ? "fa-file-pdf" : /\.(png|jpe?g)$/i.test(name) ? "fa-file-image" : "fa-file");

  async function importAnnex(file) {
    if (!state.edit) return;
    const AX = window.RootsAnnex;
    const k = AX.kind(file);
    if (k.type === "old" || k.type === "unknown") return toast(k.hint, "err");
    let mode = "shot";
    if (k.type !== "image") {
      mode = await showDialog({
        icon: "fa-crop-simple", tone: "ok",
        title: "Ausschnitt als Bild übernehmen?",
        html: `<div class="import-file"><i class="fa-regular ${fileIcon(file.name)}"></i><span>${esc(file.name)}</span><small>${esc(fileSize(file.size))}</small></div>`,
        actions: [{ label: "Abbrechen", value: null }, { label: "Nur Datei anhängen", value: "file" }, { label: "Ausschnitt wählen", value: "shot", primary: true }],
      });
    }
    if (!mode) return;
    const a = state.edit.annex;
    a.on = true;
    if (mode === "file") {
      if (file.size > 5 * 1024 * 1024) return toast("Datei größer als 5 MB", "err");
      setBusy(true, "Datei wird gespeichert");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sha = await putFile(file.name, k.mime, bytes);
        (a.files = a.files || []).push({ sha, name: file.name, mime: k.mime, size: bytes.length });
      } finally {
        setBusy(false);
      }
    } else {
      const shots = await AX.capture(file);
      if (!shots || !shots.length) return;
      setBusy(true, shots.length > 1 ? `${shots.length} Bilder werden gespeichert` : "Ausschnitt wird gespeichert");
      try {
        // Quelldatei mit ablegen, damit sich der Ausschnitt spaeter belegen laesst
        let source = null;
        if (k.type !== "image" && file.size <= 5 * 1024 * 1024) {
          source = await putFile(file.name, k.mime, new Uint8Array(await file.arrayBuffer())).catch(() => null);
        }
        for (const shot of shots) {
          const sha = await putFile(`${file.name.replace(/\.[^.]+$/, "")}_Ausschnitt.png`, shot.mime, shot.bytes);
          (a.images = a.images || []).push({ sha, w: shot.w, h: shot.h, label: shot.label, caption: "", source_sha: source });
        }
      } finally {
        setBusy(false);
      }
    }
    renderEditor();
    commitHistory();
    scheduleAutosave();
  }

  function attachmentsOf(inv) {
    const used = new Set();
    return (inv.annex?.files || []).map((f) => {
      let name = f.name || "Anlage";
      for (let i = 2; used.has(name.toLowerCase()); i++) name = f.name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
      used.add(name.toLowerCase());
      const bytes = files.get(f.sha);
      if (!bytes) throw new Error(`Anlage ${f.name} fehlt.`);
      return { name, bytes, mime: f.mime, description: f.name };
    });
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
    const [inv, cust, tpl, seqs] = await Promise.all([api("list"), api("customers"), api("templates"), api("sequences")]);
    state.sequences = seqs.sequences || [];
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
    $(".dash-main-content").classList.toggle("designer-mode", state.view === "designer");
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
    const open = state.sequences.filter((q) => !q.confirmed_at && state.templates.some((t) => t.data?.sequence_id === q.id));
    const b = $("#seq-banner");
    if (b) {
      b.classList.toggle("hidden", !open.length || state.view === "settings" || state.view === "designer");
      $("#seq-banner-text").textContent = open.length ? `Nummernkreis ${open.map((q) => "„" + q.name + "“").join(", ")} nicht freigegeben · Rechnungen können noch nicht erstellt werden` : "";
    }
  }

  function statusTag(inv) {
    if (inv.status === "final") return `<span class="tag tag-ok"><i class="fa-solid fa-circle-check"></i> E-Rechnung</span>`;
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
        <td class="mono">${i.number ? esc(i.number) : '<span class="cell-sub">–</span>'}</td>
        <td>${esc(fmtDate(i.issue_date))}</td>
        <td><div class="cell-main">${esc(i.customer_name || "")}</div><div class="cell-sub">${esc(i.project || "")}</div></td>
        <td>${esc(E.TAX_CASES[i.tax_case]?.label || "")}</td>
        <td class="num">${esc(money(i.gross_cents))}</td>
        <td>${statusTag(i)}</td>
        <td class="row-actions">
          ${i.status !== "draft" ? `<button class="icon-btn" data-act="pdf" title="PDF (Factur-X)"><i class="fa-solid fa-file-pdf"></i></button>` : ""}
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
      number: null,
      template: row.id || null,
      lang: tpl.lang,
      tax_case: tpl.tax_case,
      issue_date: issue,
      due_date: addDays(issue, Number(tpl.due_days) || 30),
      period_start: ps,
      period_end: pe,
      project: "",
      po: "",
      cost_center: "",
      buyer_reference: "",
      ordered_by: c.contact || "",
      note: tpl.note || "",
      buyer: customer ? { name: customer.name, street: c.street || "", street2: c.street2 || "", zip: c.zip || "", city: c.city || "", country: c.country || "DE", vat_id: c.vat_id || "", vat_print: c.vat_print || "", hide_country: !!c.hide_country, email: c.email || "", contact: "" } : { name: "", street: "", street2: "", zip: "", city: "", country: "DE", vat_id: "", email: "", contact: "" },
      lines: tpl.lines.map((l) => ({ label: l.label, detail: "", html: RT.sanitize(RT.fromLine(l)), amount: "" })),
      annex: JSON.parse(JSON.stringify({ title: "", text: "", rows: [], ...(tpl.annex || {}), on: false })),
      layout: tpl.layout && tpl.layout.elements?.length ? JSON.parse(JSON.stringify(tpl.layout)) : undefined,
      customer_id: customer?.id || null,
    };
  }

  /** Name in der Oberflaeche; auf der Rechnung steht immer die Firma. */
  const custLabel = (c) => String(c?.data?.display_name || "").trim() || c?.name || "";

  function logoHtml(c, cls = "cust-logo") {
    const src = window.RootsUI.safeLogo(c?.data?.logo);
    return `<div class="${cls}">${src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : `<span class="monogram">${esc(window.RootsUI.monogram(custLabel(c)))}</span>`}</div>`;
  }

  function customerSpecs(c) {
    const d = c.data || {};
    const country = window.RootsInvoicePdf.countryName(d.country, "de") || d.country || "";
    return [
      [d.city, country].filter(Boolean).join(" · "),
      customerTemplate(c)?.name || "",
      d.vat_id ? `<span class="mono">${esc(d.vat_id)}</span>` : "",
    ].filter(Boolean).map((x) => `<span class="cust-spec">${x.startsWith("<span") ? x : esc(x)}</span>`).join("");
  }

  const newFlow = { customer: null };

  /** Hinterlegte Vorlage des Kunden, sonst die erste mit passendem Steuerfall. */
  function customerTemplate(c) {
    const d = c?.data || {};
    return state.templates.find((t) => t.id === d.template_id) || state.templates.find((t) => t.data?.tax_case === d.tax_case) || null;
  }

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
              <span class="cust-name">${esc(custLabel(c))}</span>
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
        <h2>${c ? esc(custLabel(c)) : "Neuer Kunde"}</h2>
        <button class="icon-btn" data-act="close-dialog" title="Schließen"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tpl-grid" id="tpl-list">
        ${state.templates.map((t) => `
          <button class="tpl-card" data-tplid="${esc(t.id)}">
            <span><span class="tpl-name">${esc(t.name)}</span><span class="tpl-meta">${esc(E.TAX_CASES[t.data?.tax_case]?.label || "")} · ${t.data?.lang === "en" ? "English" : "Deutsch"} · ${esc(t.data?.due_days ?? 30)} Tage</span></span>
            ${taxCase && t.data?.tax_case === taxCase ? `<span class="tag tag-std">Passt zum Steuerfall</span>` : ""}
          </button>`).join("") || `<p class="cell-sub">Keine Vorlagen</p>`}
      </div>`;
  }

  let editorSnapshot = null;

  function startEditor(inv) {
    editorSnapshot = inv.id ? JSON.stringify(normalized(inv)) : null;
    state.edit = inv;
    state.check = null;
    state.showErrors = false;
    state.view = "edit";
    resetHistory();
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

  /** Anlage aktiv: ausdruecklich gesetzt oder (alte Entwuerfe) sobald Inhalt da ist. */
  function annexOn(inv) {
    const a = inv.annex || {};
    if (typeof a.on === "boolean") return a.on;
    return !!(String(a.text || "").trim() || (a.rows || []).length || (a.images || []).length || (a.files || []).length);
  }
  const annexHtml = (a) => (typeof a?.html === "string" ? a.html : RT.esc(a?.text || "").replace(/\n/g, "<br>"));
  const rtBar = () => `
            <div class="rt-bar" role="toolbar" aria-label="Formatierung">
              <button type="button" data-rt="bold" title="Fett (⌘B)"><i class="fa-solid fa-bold"></i></button>
              <button type="button" data-rt="italic" title="Kursiv (⌘I)"><i class="fa-solid fa-italic"></i></button>
              <button type="button" data-rt="underline" title="Unterstrichen (⌘U)"><i class="fa-solid fa-underline"></i></button>
              <hr>
              <button type="button" data-rt="insertUnorderedList" title="Aufzählung"><i class="fa-solid fa-list-ul"></i></button>
              <button type="button" data-rt="insertOrderedList" title="Nummerierung"><i class="fa-solid fa-list-ol"></i></button>
              <hr>
              <button type="button" data-rt="removeFormat" title="Formatierung entfernen"><i class="fa-solid fa-text-slash"></i></button>
            </div>`;

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
          <span id="save-state" class="save-state"></span>
          <button class="icon-btn hist-btn" id="btn-undo" data-act="undo" title="Rückgängig (⌘Z)"><i class="fa-solid fa-rotate-left"></i></button>
          <button class="icon-btn hist-btn" id="btn-redo" data-act="redo" title="Wiederholen (⇧⌘Z)"><i class="fa-solid fa-rotate-right"></i></button>
          ${inv.id ? `<button class="icon-btn hist-btn" data-act="journal" title="Verlauf"><i class="fa-solid fa-clock-rotate-left"></i></button>` : ""}
          ${inv.id && !inv.number ? `<button class="btn-danger-ghost" data-act="delete-draft" title="Entwurf löschen"><i class="fa-solid fa-trash-can"></i></button>` : ""}
          <button class="btn-secondary" data-act="preview"><i class="fa-solid fa-download"></i> Entwurf</button>
          <button class="btn-secondary" data-act="save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
          <button class="btn-primary" data-act="finalize" id="btn-finalize"><i class="fa-solid fa-file-circle-check"></i> Rechnung erstellen</button>
        </div>
      </div>
      <div class="editor-split">
        <div class="editor-form">
          <section class="card">
            <h3><i class="fa-solid fa-file-invoice"></i> Rechnung</h3>
            <div class="fields">
              <label class="field"><span class="flabel">Rechnungsnummer</span><input value="${esc(inv.number || "")}" placeholder="Wird beim Erstellen vergeben" class="mono" disabled></label>
              ${input("tax_case", "Steuerfall", { options: tcOpts })}
              ${input("lang", "Sprache", { options: [["de", "Deutsch"], ["en", "English"]] })}
              ${input("issue_date", "Rechnungsdatum", { type: "date" })}
              ${input("period_start", "Leistung von", { type: "date" })}
              ${input("period_end", "Leistung bis", { type: "date" })}
              ${input("due_date", "Fällig am", { type: "date" })}
              ${input("project", "Projekt", { wide: true })}
              ${input("po", "Bestellnummer")}
              ${input("cost_center", "Kostenstelle")}
              ${input("ordered_by", inv.lang === "en" ? "Ordered by" : "Kontakt")}
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <h3><i class="fa-solid fa-building"></i> Kunde</h3>
              <div class="card-actions">
                <select id="pick-customer"><option value="">Aus Kundenliste</option>${state.customers.map((c) => `<option value="${esc(c.id)}">${esc(custLabel(c))}</option>`).join("")}</select>
                <button class="btn-ghost sm" data-act="save-customer"><i class="fa-solid fa-user-plus"></i> Als Kunde speichern</button>
              </div>
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
            ${rtBar()}
            <div class="lines">
              ${inv.lines.map((l, i) => `
                <div class="line-row rich-row">
                  <div class="rt" contenteditable="true" spellcheck="true" data-rich="lines.${i}" data-placeholder="Position">${RT.sanitize(RT.fromLine(l))}</div>
                  <input data-path="lines.${i}.amount" value="${esc(l.amount)}" placeholder="0,00" class="num">
                  <button class="icon-btn" data-act="del-line" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
                </div>`).join("")}
            </div>
            <div class="totals" id="totals"></div>
          </section>

          <section class="card annex-card" id="annex-card">
            <div class="card-head">
              <label class="switch-head"><input type="checkbox" data-path="annex.on" ${annexOn(inv) ? "checked" : ""}><span class="switch"></span><h3><i class="fa-solid fa-paperclip"></i> Anlage</h3></label>
              <div class="card-actions ${annexOn(inv) ? "" : "hidden"}">
                <button class="btn-ghost sm" data-act="annex-import"><i class="fa-solid fa-file-import"></i> Excel, Word, PDF</button>
                <button class="btn-ghost sm" data-act="add-annex-row"><i class="fa-solid fa-plus"></i> Zeile</button>
              </div>
              <input type="file" id="annex-file" accept=".xlsx,.xlsm,.docx,.pdf,.png,.jpg,.jpeg" hidden>
            </div>
            <div class="annex-body ${annexOn(inv) ? "" : "hidden"}">
            <div class="fields">
              ${input("annex.title", "Titel", { wide: true })}
              <div class="field wide"><span class="flabel">Text</span>${rtBar()}<div class="rt rt-area" contenteditable="true" spellcheck="true" data-rich="annex" data-placeholder="Text der Anlage">${RT.sanitize(annexHtml(inv.annex))}</div></div>
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
            ${(inv.annex.images || []).length ? `<div class="annex-shots">${inv.annex.images.map((im, i, all) => `
              <div class="annex-shot">
                <div class="shot-thumb">${fileUrl(im.sha) ? `<img src="${fileUrl(im.sha)}" alt="">` : `<span class="spinner"></span>`}</div>
                <div class="shot-meta">
                  <span class="shot-src" title="${esc(im.label)}">${esc(im.label)}</span>
                  <input data-path="annex.images.${i}.caption" value="${esc(im.caption || "")}" placeholder="Bildunterschrift">
                </div>
                <div class="shot-actions">
                  <button class="icon-btn" data-act="annex-img-move" data-i="${i}" data-d="-1" title="Nach oben" ${i === 0 ? "disabled" : ""}><i class="fa-solid fa-arrow-up"></i></button>
                  <button class="icon-btn" data-act="annex-img-move" data-i="${i}" data-d="1" title="Nach unten" ${i === all.length - 1 ? "disabled" : ""}><i class="fa-solid fa-arrow-down"></i></button>
                  <button class="icon-btn" data-act="annex-img-del" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
                </div>
              </div>`).join("")}</div>` : ""}
            ${(inv.annex.files || []).length ? `<div class="annex-files">${inv.annex.files.map((f, i) => `
              <div class="annex-file">
                <i class="fa-regular ${fileIcon(f.name)}"></i>
                <span>${esc(f.name)}</span>
                <small>${esc(fileSize(f.size || 0))} · im PDF eingebettet</small>
                <button class="icon-btn" data-act="annex-file-del" data-i="${i}" title="Entfernen"><i class="fa-solid fa-trash-can"></i></button>
              </div>`).join("")}</div>` : ""}
            </div>
            <div class="annex-drop"><i class="fa-solid fa-file-import"></i> Datei hier ablegen</div>
          </section>
        </div>
        <div class="preview-pane">
          <div class="preview-head"><span><i class="fa-regular fa-file-pdf"></i> Vorschau</span><span id="preview-info"></span></div>
          <div class="preview-pages" id="preview-pages"></div>
        </div>
      </div>`;
    window.RootsUI.enhance($("#editor"));
    updateLive();
  }

  /** Pflichtangaben plus doppelte Rechnungsnummer. */
  function collectIssues(inv) {
    return E.precheck(normalized(inv), state.settings.seller || {}).filter((m) => m.field !== "number");
  }

  /** Feldpfad -> Bereich im PDF. */
  function regionKey(path) {
    const p = String(path || "");
    if (p.startsWith("buyer.")) return "buyer";
    if (p === "period_start" || p === "period_end") return "period";
    if (p === "tax_case" || p === "lang") return "totals";
    let m = /^lines\.(\d+)\./.exec(p);
    if (m) return `lines.${m[1]}`;
    m = /^annex\.rows\.(\d+)\./.exec(p);
    if (m) return `annex.rows.${m[1]}`;
    return p;
  }
  let pendingFocus = null;

  /* ------------------------------------------------ Autospeichern, Verlauf --- */

  const hist = { past: [], future: [], last: null, timer: null };
  function resetHistory() {
    hist.past = [];
    hist.future = [];
    hist.last = JSON.stringify(state.edit);
    updateHistoryButtons();
  }
  function commitHistory() {
    clearTimeout(hist.timer);
    if (!state.edit) return;
    const cur = JSON.stringify({ ...state.edit, id: undefined });
    const last = hist.last && JSON.stringify({ ...JSON.parse(hist.last), id: undefined });
    if (cur !== last) {
      if (hist.last) hist.past.push(hist.last);
      if (hist.past.length > 100) hist.past.shift();
      hist.future = [];
    }
    hist.last = JSON.stringify(state.edit);
    updateHistoryButtons();
  }
  function scheduleHistory() {
    clearTimeout(hist.timer);
    hist.timer = setTimeout(commitHistory, 600);
  }
  function stepHistory(dir) {
    commitHistory();
    const from = dir < 0 ? hist.past : hist.future;
    const to = dir < 0 ? hist.future : hist.past;
    if (!from.length) return;
    to.push(hist.last);
    hist.last = from.pop();
    const id = state.edit.id;
    state.edit = JSON.parse(hist.last);
    state.edit.id = id;
    renderEditor();
    updateHistoryButtons();
    scheduleAutosave();
  }
  function updateHistoryButtons() {
    const u = $("#btn-undo"), r = $("#btn-redo");
    if (u) u.disabled = !hist.past.length && JSON.stringify(state.edit) === hist.last;
    if (r) r.disabled = !hist.future.length;
  }

  let autosaveTimer = null;
  let saveChain = Promise.resolve();
  function setSaveState(text, kind = "") {
    const el = $("#save-state");
    if (el) { el.textContent = text; el.className = "save-state " + kind; }
  }
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);

    autosaveTimer = setTimeout(autosave, 1200);
  }
  function autosave() {
    if (!state.edit) return;
    saveChain = saveChain.then(async () => {
      if (!state.edit) return;
      setSaveState("Speichert …");
      try {
        await saveDraft(true);
        setSaveState("");
      } catch (e) {
        setSaveState("Nicht gespeichert: " + e.message, "err");
      }
    });
    return saveChain;
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const box = $("#preview-pages");
      if (!box || !state.edit) return;
      try {
        const regions = {};
        const pdf = await window.RootsInvoicePdf.render(normalized(state.edit), state.settings.seller || {}, await pdfAssets(), { final: false, preview: true, regions, files });
        const pages = await window.RootsUI.renderPdf(pdf, box);
        if (pages) {
          state.regions = regions;
          $("#preview-info").textContent = pages === 1 ? "1 Seite" : `${pages} Seiten`;
          const active = document.activeElement?.closest?.("[data-path]");
          const key = pendingFocus || (active ? regionKey(active.dataset.path) : null);
          if (key && regions[key]) window.RootsUI.highlight(box, regions[key]);
          else window.RootsUI.release(box);
          pendingFocus = null;
        }
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

    const issues = state.showErrors ? collectIssues(inv) : [];
    $("#edit-state").innerHTML = `<span class="tag tag-draft"><i class="fa-regular fa-file-lines"></i> Entwurf</span>`;

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

  /** Alle Speichervorgaenge laufen hintereinander, sonst legen zwei gleichzeitige den Entwurf doppelt an. */
  let saveQueue = Promise.resolve();
  function saveDraft(quiet) {
    const run = saveQueue.then(() => saveDraftNow(quiet));
    saveQueue = run.catch(() => {});
    return run;
  }

  async function saveDraftNow(quiet) {
    if (!state.edit) return;
    const inv = normalized(state.edit);
    const t = E.totals(inv);
    const res = await api("save", {
      id: inv.id,
      row: {
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

  const issueList = (items) => `<ul class="result-list">${items.map((m) => `<li class="${m.level === "warn" ? "warn" : "error"}">${esc(m.text)}${m.rule ? `<small>${esc(m.rule)}</small>` : ""}</li>`).join("")}</ul>`;

  /**
   * Rechnung erstellen: Pflichtangaben, Schematron, XSD, PDF/A-3 mit XML und
   * zuletzt die Serverpruefung laufen am Stueck im Hintergrund. Nur wenn alles
   * besteht, entsteht eine endgueltige Rechnung; sonst erklaert ein Pop-up, was fehlt.
   */
  /** XML bauen, Schematron, PDF, XSD und Einbettung. Liefert { ok, xml, fx, schematron } oder { ok:false, items }. */
  async function buildAll(inv, seller) {
    try {
      await ensureFiles(inv);
      const attachments = attachmentsOf(inv);
      const xml = E.buildXml(inv, seller, attachments.map((a) => ({ name: a.name, mime: a.mime, b64: window.RootsFacturX.bytesToBase64(a.bytes) })));
      const schematron = await window.RootsSchematron.validate(xml);
      if (!schematron.passed) return { ok: false, items: schematron.errors.map((e) => ({ level: "error", rule: e.id, text: e.text })) };
      setBusy(true, "PDF wird erzeugt");
      const warnings = [];
      if (inv.layout?.elements?.length) {
        const missing = window.RootsLayout.required(inv.layout);
        if (missing.length) throw new Error("Layout der Vorlage unvollständig: " + missing.join(", "));
      }
      const pdf = await window.RootsInvoicePdf.render(inv, seller, await pdfAssets(), { final: true, warnings, files });
      if (warnings.length) throw new Error("Im PDF läuft Text über: " + [...new Set(warnings)].join(", "));
      const en = inv.lang === "en";
      const meta = {
        author: seller.name,
        title: `${en ? "Invoice" : "Rechnung"} ${inv.number} · ${inv.buyer.name}`,
        subject: `${en ? "Invoice" : "Rechnung"} ${inv.number} ${en ? "dated" : "vom"} ${E.fmtDate(inv.issue_date, "de")} · ${seller.name}`,
        keywords: `${en ? "Invoice" : "Rechnung"}, E-Rechnung, ZUGFeRD, Factur-X, EN 16931`,
      };
      const fx = await window.RootsFacturX.build(pdf, xml, en ? "en-GB" : "de-DE", () => setBusy(true, "PDF wird erzeugt"), meta, attachments);
      if (fx.xsd !== "passed") return { ok: false, items: [{ level: "error", rule: "XSD", text: fx.xsd_error || "XML entspricht nicht dem Schema" }] };
      if (fx.roundtrip !== "passed") return { ok: false, items: [{ level: "error", rule: "PDF/A-3", text: "Die Rechnungsdaten ließen sich nicht in das PDF einbetten." }] };
      return { ok: true, xml, fx, schematron };
    } catch (e) {
      return { ok: false, items: [{ level: "error", text: e.message }] };
    }
  }

  const invalidDialog = (items, lead) => showDialog({
    icon: "fa-circle-xmark", tone: "bad",
    title: "Keine gültige E-Rechnung",
    html: `<p>${esc(lead || "Die Rechnung wurde nicht erstellt.")}</p>${issueList(items)}`,
    actions: [{ label: "Zurück zur Rechnung", value: true, primary: true }],
  });

  async function finalize() {
    let inv = normalized(state.edit);
    const seller = state.settings.seller || {};
    const issues = collectIssues(state.edit);
    const errors = issues.filter((m) => m.level === "error");
    if (errors.length) {
      state.showErrors = true;
      updateLive();
      await showDialog({
        icon: "fa-triangle-exclamation", tone: "bad",
        title: "Angaben fehlen",
        html: issueList(errors),
        actions: [{ label: "Zurück zur Rechnung", value: true, primary: true }],
      });
      return;
    }

    const seq = sequenceOf(inv);
    if (!inv.number && (!seq || !seq.confirmed_at || seq.next_number == null)) {
      const go = await showDialog({
        icon: "fa-hashtag", tone: "bad",
        title: "Nummernkreis nicht freigegeben",
        html: `<p>${seq ? `Der Nummernkreis „${esc(seq.name)}“ dieser Vorlage braucht eine bestätigte Startnummer.` : "Die Vorlage hat keinen Nummernkreis."}</p>`,
        actions: [{ label: "Zurück", value: false }, { label: "Zu den Einstellungen", value: true, primary: true }],
      });
      if (go) { await saveDraft(true); state.view = "settings"; render(); }
      return;
    }

    // 1. Probelauf mit der voraussichtlichen Nummer: Fehler zeigen, bevor eine Nummer vergeben wird
    const preview = inv.number || previewNumber(seq);
    setBusy(true, "Rechnung wird geprüft");
    await saveDraft(true);
    let result = await buildAll({ ...inv, number: preview }, seller);
    setBusy(false);
    if (!result.ok) return void (await invalidDialog(result.items));

    const warns = issues.filter((m) => m.level === "warn");
    const go = await showDialog({
      icon: "fa-file-circle-check", tone: "ok",
      title: `Rechnung ${preview} erstellen?`,
      html: `<p>Danach ist sie unveränderlich. Korrekturen nur über Storno.</p>${warns.length ? issueList(warns) : ""}`,
      actions: [{ label: "Abbrechen", value: false }, { label: "Erstellen", value: true, primary: true }],
    });
    if (!go) return;

    // 2. Nummer verbindlich vergeben, endgueltig bauen
    setBusy(true, "Rechnungsnummer wird vergeben");
    try {
      if (!inv.number) {
        const res = await api("reserve", { id: state.edit.id });
        state.edit.number = res.number;
        inv = normalized(state.edit);
        refreshSequences();
      }
      if (inv.number !== preview) result = await buildAll(inv, seller);
    } catch (e) {
      result = { ok: false, items: [{ level: "error", text: e.message }] };
    }
    setBusy(false);
    if (!result.ok) return void (await invalidDialog(result.items, `Die Rechnung hat die Nummer ${inv.number || "–"} erhalten, wurde aber nicht erstellt.`));

    setBusy(true, "Rechnung wird erstellt");
    const id = state.edit.id;
    try {
      await api("finalize", {
        id,
        xml: result.xml,
        pdf: result.fx.pdf,
        validation: {
          precheck: "passed",
          schematron: "passed",
          schematron_version: result.schematron.version,
          schematron_warnings: result.schematron.warnings.map((w) => w.id),
          xsd: result.fx.xsd,
          roundtrip: result.fx.roundtrip,
          lib: result.fx.lib,
          checked_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      setBusy(false);
      await showDialog({
        icon: "fa-circle-xmark", tone: "bad",
        title: "Keine gültige E-Rechnung",
        html: `<p>Die Serverprüfung hat die Rechnung abgelehnt.</p>${issueList(String(e.message).replace(/^E-Rechnung abgelehnt:\s*/, "").split("; ").map((t) => ({ level: "error", text: t })))}`,
        actions: [{ label: "Zurück zur Rechnung", value: true, primary: true }],
      });
      return;
    }
    setBusy(false);
    state.edit = null;
    state.showErrors = false;
    state.view = "list";
    await refresh();
    await openDetail(id);
    const dl = await showDialog({
      icon: "fa-circle-check", tone: "ok",
      title: `Rechnung ${inv.number} erstellt`,
      html: `<p>${esc(inv.buyer.name)} · ${esc(money(E.totals(inv).gross))}</p>`,
      actions: [{ label: "Schließen", value: false }, { label: "PDF herunterladen", value: true, primary: true }],
    });
    if (dl) downloadPdf(id, inv.number, inv.buyer.name);
  }

  /** Allgemeines Pop-up. actions: [{label, value, primary}] */
  function showDialog({ icon, tone, title, html, actions }) {
    return new Promise((resolve) => {
      const dlg = $("#result-dialog");
      $("#result-icon").className = `result-icon ${tone || ""}`;
      $("#result-icon").innerHTML = `<i class="fa-solid ${icon || "fa-circle-info"}"></i>`;
      $("#result-title").textContent = title;
      $("#result-body").innerHTML = html || "";
      $("#result-actions").innerHTML = actions.map((a, i) => `<button class="${a.primary ? "btn-primary" : "btn-secondary"}" data-i="${i}">${esc(a.label)}</button>`).join("");
      $("#result-actions").onclick = (e) => {
        const b = e.target.closest("button[data-i]");
        if (!b) return;
        dlg.classList.remove("open");
        resolve(actions[Number(b.dataset.i)].value);
      };
      dlg.classList.add("open");
    });
  }

  async function previewDraft() {
    const inv = normalized(state.edit);
    setBusy(true, "Entwurf wird erzeugt");
    try {
      await ensureFiles(inv);
      const pdf = await window.RootsInvoicePdf.render(inv, state.settings.seller || {}, await pdfAssets(), { final: false, files });
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
        resetHistory();
      }
      render();
      if (detail.status === "draft" && annexShas(state.edit).some((sha) => !files.has(sha))) {
        ensureFiles(state.edit).then(() => { if (state.view === "edit") renderEditor(); }).catch((e) => toast(e.message, "err"));
      }
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
        </div>
        <aside class="editor-side">
          <section class="card sticky">
            <h3><i class="fa-solid fa-file-invoice"></i> E-Rechnung</h3>
            <div class="side-actions">
              <button class="btn-primary" data-act="dl-pdf"><i class="fa-solid fa-file-pdf"></i> PDF mit E-Rechnung</button>
              <button class="btn-secondary" data-act="dl-xml"><i class="fa-solid fa-code"></i> XML (CII)</button>
              <button class="btn-secondary" data-act="details"><i class="fa-solid fa-circle-info"></i> Details</button>
              <button class="btn-secondary" data-act="journal"><i class="fa-solid fa-clock-rotate-left"></i> Verlauf</button>
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

  /* ------------------------------------------------- Verlauf und Archiv --- */

  const EVENTS = {
    baseline: "Bestand", created: "Angelegt", saved: "Zwischenstand", numbered: "Nummer vergeben",
    finalized: "Endgültig erstellt", cancelled: "Storniert", deleted: "Gelöscht",
  };
  const stamp = (iso) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const who = (mail) => String(mail || "").split("@")[0];

  async function openJournal(id, isDraft) {
    if (!id) return;
    if (isDraft) await saveDraft(true).catch(() => {});
    setBusy(true, "Verlauf wird geladen");
    let entries;
    try {
      entries = (await api("journal", { id })).entries || [];
    } finally {
      setBusy(false);
    }
    const latest = entries.filter((e) => e.data_sha256).slice(-1)[0];
    const html = `<div class="journal">${entries.slice().reverse().map((e) => `
      <div class="jr jr-${esc(e.event)}">
        <span class="jr-v">V${e.version}</span>
        <div class="jr-main">
          <b>${esc(EVENTS[e.event] || e.event)}${e.number ? ` · <span class="mono">${esc(e.number)}</span>` : ""}</b>
          <span class="cell-sub">${esc(stamp(e.at))} · ${esc(who(e.actor_email))}${e.gross_cents != null ? ` · ${esc(money(e.gross_cents))}` : ""}${e.note ? ` · ${esc(e.note)}` : ""}</span>
        </div>
        <code class="jr-hash" title="SHA-256 ${esc(e.hash)}">${esc(e.hash.slice(0, 10))}</code>
        ${e.data_sha256 ? `<button class="icon-btn" data-jv="${e.seq}" title="Ansehen"><i class="fa-regular fa-eye"></i></button>` : `<span class="jr-pad"></span>`}
      </div>`).join("")}</div>`;
    const body = $("#result-body");
    const onClick = async (ev) => {
      const b = ev.target.closest("[data-jv]");
      if (!b) return;
      $("#result-dialog").classList.remove("open");
      body.removeEventListener("click", onClick);
      await openVersion(Number(b.dataset.jv), isDraft, latest && Number(b.dataset.jv) === latest.seq);
    };
    body.addEventListener("click", onClick);
    const act = await showDialog({
      icon: "fa-clock-rotate-left", tone: "ok",
      title: "Verlauf",
      html,
      actions: [{ label: "Integrität prüfen", value: "verify" }, { label: "Schließen", value: null, primary: true }],
    });
    body.removeEventListener("click", onClick);
    if (act === "verify") return verifyIntegrity(id);
  }

  async function openVersion(seq, isDraft, isLatest) {
    setBusy(true, "Version wird geladen");
    let e;
    try {
      e = (await api("journal_entry", { seq })).entry;
      await ensureFiles(e.data);
    } catch (err) {
      setBusy(false);
      return toast(err.message, "err");
    }
    const box = document.createElement("div");
    box.className = "modal-overlay open version-dialog";
    box.innerHTML = `
      <div class="modal-box version-box">
        <div class="version-head">
          <h2>V${e.version} · ${esc(EVENTS[e.event] || e.event)}</h2>
          <span class="cell-sub">${esc(stamp(e.at))} · ${esc(who(e.actor_email))}</span>
          <button class="icon-btn" data-close title="Schließen"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="version-pages preview-pages"></div>
        <div class="modal-actions">
          ${isDraft && !isLatest ? `<button class="btn-primary" data-restore><i class="fa-solid fa-rotate-left"></i> Diesen Stand wiederherstellen</button>` : ""}
          <button class="btn-secondary" data-close>Schließen</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.addEventListener("click", async (ev) => {
      if (ev.target === box || ev.target.closest("[data-close]")) return close();
      if (ev.target.closest("[data-restore]")) {
        close();
        if (!state.edit) return;
        const keep = { id: state.edit.id, number: state.edit.number };
        state.edit = { ...JSON.parse(JSON.stringify(e.data)), ...keep };
        renderEditor();
        commitHistory();
        await saveDraft(true);
        toast(`Stand V${e.version} wiederhergestellt`, "ok");
      }
    });
    try {
      const inv = { ...e.data, number: e.data.number || "" };
      const pdf = await window.RootsInvoicePdf.render(inv, state.settings.seller || {}, await pdfAssets(), { final: false, preview: true, files });
      await window.RootsUI.renderPdf(pdf, box.querySelector(".version-pages"));
    } catch (err) {
      box.querySelector(".version-pages").innerHTML = `<p class="cell-sub">${esc(err.message)}</p>`;
    } finally {
      setBusy(false);
    }
  }

  async function verifyIntegrity(id) {
    setBusy(true, "Archiv wird geprüft");
    let r;
    try {
      r = await api("verify", { id: id || null });
    } finally {
      setBusy(false);
    }
    const row = (k, val) => `<div class="kv"><span>${esc(k)}</span><b>${val}</b></div>`;
    return showDialog({
      icon: r.ok ? "fa-shield-halved" : "fa-triangle-exclamation", tone: r.ok ? "ok" : "bad",
      title: r.ok ? "Archiv unverändert" : "Archiv weicht ab",
      html: `${r.ok ? "" : issueList((r.errors || []).map((t) => ({ level: "error", text: t })))}
        ${row("Journaleinträge", esc(String(r.entries)))}
        ${row("Letzter Kettenhash", `<code>${esc(r.last_hash || "")}</code>`)}
        ${row("Geprüft", esc(stamp(r.checked_at)))}`,
      actions: [{ label: "Schließen", value: true, primary: true }],
    });
  }

  const csv = (rows) => rows.map((r) => r.map((v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(";")).join("\r\n");

  /** ZIP mit allen endgueltigen und stornierten Rechnungen (PDF + XML), Manifest mit Hashes und Journal. */
  async function exportArchive() {
    const list = state.invoices.filter((i) => i.status !== "draft");
    if (!list.length) return toast("Noch keine endgültigen Rechnungen");
    setBusy(true, "Archiv wird erstellt");
    try {
      await window.RootsAnnex.loadZip();
      const zip = new window.JSZip();
      const sha = window.RootsAnnex.sha256;
      const manifest = [["Rechnungsnummer", "Rechnungsdatum", "Kunde", "Brutto", "Status", "Erstellt", "Storniert", "Stornogrund", "Datei", "SHA-256 PDF", "SHA-256 XML"]];
      for (let n = 0; n < list.length; n++) {
        setBusy(true, `Archiv wird erstellt · ${n + 1} von ${list.length}`);
        const inv = (await api("get", { id: list[n].id })).invoice;
        const pdf = window.RootsFacturX.base64ToBytes((await api("pdf", { id: inv.id })).pdf);
        const xml = new TextEncoder().encode(inv.xml || "");
        if ((await sha(pdf)) !== inv.pdf_sha256 || (await sha(xml)) !== inv.xml_sha256) throw new Error(`Rechnung ${inv.number}: Hash stimmt nicht. Export abgebrochen.`);
        const base = `${String(inv.issue_date || "").slice(0, 4) || "ohne Datum"}/Rechnung_${safeName(inv.number)}_${safeName(inv.customer_name)}`;
        zip.file(`${base}.pdf`, pdf, { date: new Date(inv.finalized_at) });
        zip.file(`${base}_factur-x.xml`, xml, { date: new Date(inv.finalized_at) });
        manifest.push([inv.number, inv.issue_date, inv.customer_name, (inv.gross_cents / 100).toFixed(2).replace(".", ","), inv.status === "cancelled" ? "storniert" : "endgültig", inv.finalized_at, inv.cancelled_at || "", inv.cancel_reason || "", `${base}.pdf`, inv.pdf_sha256, inv.xml_sha256]);
      }
      setBusy(true, "Journal wird geprüft");
      const entries = (await api("journal_all")).entries || [];
      const check = await api("verify", {});
      zip.file("Rechnungen.csv", "\ufeff" + csv(manifest));
      zip.file("Journal.csv", "\ufeff" + csv([["Nr", "Rechnung", "Version", "Ereignis", "Status", "Rechnungsnummer", "Brutto", "SHA-256 Inhalt", "SHA-256 PDF", "SHA-256 XML", "Notiz", "Person", "Zeitpunkt", "Vorheriger Hash", "Hash"],
        ...entries.map((e) => [e.seq, e.invoice_id, e.version, EVENTS[e.event] || e.event, e.status, e.number, e.gross_cents == null ? "" : (e.gross_cents / 100).toFixed(2).replace(".", ","), e.data_sha256, e.pdf_sha256, e.xml_sha256, e.note, e.actor_email, e.at, e.prev_hash, e.hash])]));
      zip.file("Pruefung.txt", [
        `ROOTS Rechnungsarchiv · erstellt ${new Date().toLocaleString("de-DE")} von ${state.user?.email || ""}`,
        `Rechnungen: ${list.length}`,
        `Journal: ${check.entries} Einträge · ${check.ok ? "Kette vollständig und unverändert" : "ABWEICHUNG: " + (check.errors || []).join("; ")}`,
        `Letzter Kettenhash: ${check.last_hash || ""}`,
        "",
        "Jede PDF-Datei und jedes XML lässt sich mit sha256sum (macOS: shasum -a 256) gegen Rechnungen.csv prüfen.",
      ].join("\r\n"));
      const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      download(out, `ROOTS_Rechnungsarchiv_${today()}.zip`, "application/zip");
      toast(`${list.length} Rechnungen exportiert`, "ok");
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------- Kunden --- */

  function renderCustomers() {
    $("#customer-rows").innerHTML = state.customers.length
      ? state.customers.map((c) => {
          const d = c.data || {};
          return `<tr data-cid="${esc(c.id)}">
            <td><div class="cell-with-logo">${logoHtml(c, "cust-logo xs")}<div><div class="cell-main">${esc(custLabel(c))}</div><div class="cell-sub">${esc([d.street, `${d.zip || ""} ${d.city || ""}`.trim(), d.country].filter(Boolean).join(", "))}</div></div></div></td>
            <td class="mono">${esc(d.vat_id || "")}</td>
            <td>${esc(customerTemplate(c)?.name || "")}</td>
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
        <label class="field wide"><span class="flabel">Anzeigename im Tool</span><input name="display_name" value="${esc(d.display_name || "")}" placeholder="${esc(c?.name || "")}"></label>
        <label class="field wide"><span class="flabel">Straße / Postfach</span><input name="street" value="${esc(d.street || "")}"></label>
        <label class="field wide"><span class="flabel">Adresszusatz</span><input name="street2" value="${esc(d.street2 || "")}"></label>
        ${f("zip", "PLZ", d.zip)}
        ${f("city", "Ort", d.city)}
        ${f("country", "Land (ISO)", d.country || "DE", 'maxlength="2"')}
        ${f("vat_id", "USt-IdNr.", d.vat_id)}
        ${f("vat_print", "USt-IdNr. auf der Rechnung", d.vat_print, 'placeholder="z. B. TVA FR 27 552 032 534"')}
        <label class="field"><span class="flabel">Länderzeile</span><label class="chk" style="height:44px"><input type="checkbox" name="hide_country" value="1" ${d.hide_country ? "checked" : ""}> weglassen</label></label>
        <label class="field wide"><span class="flabel">Vorlage</span><select name="template_id">${state.templates.map((t) => `<option value="${esc(t.id)}" ${customerTemplate(c)?.id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
        ${f("email", "Rechnungs-E-Mail", d.email)}
        ${f("contact", "Kontakt", d.contact)}
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
    data.hide_country = fd.hide_country === "1";
    data.vat_print = String(data.vat_print || "").trim();
    data.display_name = String(data.display_name || "").trim();
    const tpl = state.templates.find((t) => t.id === data.template_id);
    data.tax_case = tpl?.data?.tax_case || "";
    data.lang = tpl?.data?.lang || "de";
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
      <div class="form-actions"><button class="btn-primary" type="submit"><i class="fa-solid fa-floppy-disk"></i> Stammdaten speichern</button></div>`;
    renderSequences();
    renderTemplates();
  }

  function renderSequences() {
    const box = $("#seq-settings");
    if (!box) return;
    const fmtWho = (q) => q.confirmed_at ? `Freigegeben am ${new Date(q.confirmed_at).toLocaleDateString("de-DE")}` : "";
    box.innerHTML = `
      <div class="card-head"><h3><i class="fa-solid fa-hashtag"></i> Nummernkreise</h3><button class="btn-ghost sm" data-act="seq-new"><i class="fa-solid fa-plus"></i> Nummernkreis</button></div>
      <div class="seq-list">${state.sequences.map((q) => {
        const used = state.templates.filter((t) => t.data?.sequence_id === q.id).map((t) => t.name);
        const next = previewNumber(q);
        const n2 = q.next_number != null ? [1, 2].map((k) => q.prefix + (Number(q.next_number) + k * q.step)).join(", ") : "";
        return `
        <div class="seq-item" data-seq="${esc(q.id)}">
          <div class="seq-head">
            <strong>${esc(q.name)}</strong>
            ${q.confirmed_at ? `<span class="tag tag-ok sm"><i class="fa-solid fa-check"></i> ${esc(fmtWho(q))}</span>` : `<span class="tag tag-bad sm"><i class="fa-solid fa-lock"></i> Nicht freigegeben</span>`}
          </div>
          <div class="fields">
            <label class="field"><span class="flabel">Name</span><input data-seq-f="name" value="${esc(q.name)}"></label>
            <label class="field"><span class="flabel">Präfix</span><input data-seq-f="prefix" value="${esc(q.prefix)}" class="mono"></label>
            <label class="field"><span class="flabel">Schrittweite</span><input data-seq-f="step" inputmode="numeric" value="${esc(q.step)}" class="mono"></label>
            <label class="field"><span class="flabel">${q.confirmed_at ? "Nächste Nummer" : "Erste Rechnungsnummer"}</span><input data-seq-f="next_number" inputmode="numeric" value="${esc(q.next_number ?? "")}" placeholder="z. B. 4411" class="mono ${q.next_number == null ? "invalid" : ""}"></label>
            <div class="field wide seq-meta">${next ? `Nächste Rechnung: <b class="mono">${esc(next)}</b>${n2 ? `, danach <span class="mono">${esc(n2)}</span>` : ""}` : "Startnummer fehlt"}${used.length ? ` · Vorlagen: ${esc(used.join(", "))}` : ""}</div>
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" data-act="seq-save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
            ${q.confirmed_at ? "" : `<button class="btn-primary" data-act="seq-confirm"><i class="fa-solid fa-lock-open"></i> Freigeben</button>`}
          </div>
        </div>`;
      }).join("")}</div>`;
  }

  function readSeq(item) {
    const val = (k) => item.querySelector(`[data-seq-f="${k}"]`).value.trim();
    const next = val("next_number").replace(/\D/g, "");
    return { id: item.dataset.seq || null, name: val("name"), prefix: val("prefix"), step: Math.max(1, Number(val("step")) || 1), next: next === "" ? null : Number(next) };
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
            <span class="tpl-meta">${esc(E.TAX_CASES[x.data?.tax_case]?.label || "")} · ${x.data?.lang === "en" ? "English" : "Deutsch"} · ${esc(x.data?.due_days || 30)} Tage${x.data?.layout?.elements?.length ? " · eigenes Layout" : ""}</span>
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
        <label class="field"><span class="flabel">Nummernkreis</span><select data-tpl="data.sequence_id">${state.sequences.map((q) => `<option value="${esc(q.id)}" ${d.sequence_id === q.id ? "selected" : ""}>${esc(q.name)} · ${esc(q.prefix)}</option>`).join("")}</select></label>
        <label class="field"><span class="flabel">Zahlungsziel (Tage)</span><input inputmode="numeric" data-tpl="data.due_days" value="${esc(d.due_days ?? 30)}"></label>
        <label class="field"><span class="flabel">Reihenfolge</span><input inputmode="numeric" data-tpl="sort" value="${esc(t.sort ?? 0)}"></label>
        <label class="field wide"><span class="flabel">Anlage · Titel</span><input data-tpl="data.annex.title" value="${esc(d.annex?.title || "")}"></label>
        <label class="field wide"><span class="flabel">Anlage · Text</span><textarea rows="3" data-tpl="data.annex.text">${esc(d.annex?.text || "")}</textarea></label>
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
        <button class="btn-secondary" data-act="tpl-design" style="margin-right:auto"><i class="fa-solid fa-pen-ruler"></i> Layout gestalten${d.layout?.elements?.length ? " · eigenes Layout" : ""}</button>
        <button class="btn-primary" data-act="tpl-save"><i class="fa-solid fa-floppy-disk"></i> Vorlage speichern</button>
      </div>`;
    $('[data-tpl="data.lang"]').value = d.lang || "de";
    $('[data-tpl="data.tax_case"]').value = d.tax_case || "S19";
    window.RootsUI.enhance($("#tpl-settings"));
  }

  /** Beispielrechnung fuer den Designer, passend zu Sprache und Steuerfall der Vorlage. */
  function sampleInvoice(tpl) {
    const d = tpl.data || {};
    const [ps, pe] = lastMonth();
    const foreign = d.tax_case === "AE" ? { country: "FR", city: "Paris", zip: "75009", street: "17 Boulevard Haussmann", vat_id: "FR27552032534" } : d.tax_case === "O" ? { country: "CH", city: "Bern", zip: "3011", street: "Bundesgasse 1" } : { country: "DE", city: "Hamburg", zip: "20245", street: "Musterstraße 1" };
    return {
      number: previewNumber(state.sequences[0]) || "237-0000", lang: d.lang || "de", tax_case: d.tax_case || "S19",
      issue_date: today(), due_date: addDays(today(), Number(d.due_days) || 30), period_start: ps, period_end: pe,
      project: "Beispielprojekt Markenstrategie", po: "PO 4500012345", ordered_by: "Max Mustermann",
      buyer: { name: "Muster AG", email: "", ...foreign },
      lines: (d.lines?.length ? d.lines : [{ label: "Beratungshonorar" }]).map((l, i) => ({ label: l.label, detail: l.detail || "", amount: i === 0 ? "12.500,00" : "480,00" })),
      annex: { title: "", text: "", rows: [] },
    };
  }

  function openDesigner(tpl) {
    state.view = "designer";
    render();
    window.RootsDesigner.open({
      host: $("#designer"),
      template: tpl,
      renderPdf: async (layout, warnings) => window.RootsInvoicePdf.render({ ...sampleInvoice(tpl), layout }, state.settings.seller || {}, await pdfAssets(), { final: true, warnings }),
      onSave: async (layout) => {
        tpl.data.layout = layout || undefined;
        const res = await api("template_save", { id: tpl.id, name: tpl.name, sort: tpl.sort, data: tpl.data });
        tpl.id = res.template?.id || tpl.id;
        state.templates = (await api("templates")).templates || [];
        toast(layout ? "Layout gespeichert" : "Standardlayout aktiv", "ok");
      },
      onClose: () => { state.view = "settings"; render(); },
      confirm: (t) => confirmDialog(t, "", "Verwerfen"),
      toast,
    });
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
        const tplOfCustomer = customerTemplate(newFlow.customer);
        if (newFlow.customer && tplOfCustomer) {
          $("#tpl-dialog").classList.remove("open");
          if (state.view === "edit" && !(await leaveEditor())) return;
          return startEditor(blankInvoice(tplOfCustomer.id, newFlow.customer));
        }
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
          case "seq-new": {
            await api("sequence_save", { id: null, name: "Neuer Nummernkreis", prefix: "", next: null, step: 1 });
            await refreshSequences(); return renderSettings();
          }
          case "seq-save": {
            const q = readSeq(btn.closest(".seq-item"));
            const before = state.sequences.find((x) => x.id === q.id);
            if (before?.confirmed_at && (before.prefix !== q.prefix || Number(before.step) !== q.step || Number(before.next_number) !== q.next)) {
              if (!(await confirmDialog("Freigabe aufheben?", "Präfix, Schrittweite oder Nummer ändern sich. Bis zur erneuten Freigabe lassen sich mit diesem Kreis keine Rechnungen erstellen.", "Ändern"))) return;
            }
            await api("sequence_save", q);
            await refreshSequences(); renderSettings(); return toast("Nummernkreis gespeichert");
          }
          case "seq-confirm": {
            const item = btn.closest(".seq-item");
            const q = readSeq(item);
            if (q.next == null) return toast("Erste Rechnungsnummer fehlt", "err");
            const first = q.prefix + q.next, then = [1, 2].map((k) => q.prefix + (q.next + k * q.step)).join(", ");
            const ok = await showDialog({
              icon: "fa-hashtag", tone: "ok",
              title: `Nummernkreis „${q.name}“ freigeben?`,
              html: `<p>Die nächste Rechnung erhält <b class="mono">${esc(first)}</b>, danach folgen <span class="mono">${esc(then)}</span>. Bereits vergebene Nummern werden übersprungen.</p>`,
              actions: [{ label: "Abbrechen", value: false }, { label: "Freigeben", value: true, primary: true }],
            });
            if (!ok) return;
            await api("sequence_save", q);
            await api("sequence_confirm", { id: q.id });
            await refreshSequences(); renderSettings(); return toast("Nummernkreis freigegeben", "ok");
          }
          case "undo": return stepHistory(-1);
          case "redo": return stepHistory(1);
          case "new-back": newFlow.customer = undefined; return renderNewStep();
          case "close-dialog": return btn.closest(".modal-overlay").classList.remove("open");
          case "back":
            if (state.view === "edit" && !(await leaveEditor())) return;
            state.view = "list"; state.edit = null; detail = null; return render();
          case "add-line": state.edit.lines.push({ label: "", detail: "", amount: "" }); renderEditor(); commitHistory(); return scheduleAutosave();
          case "del-line": state.edit.lines.splice(Number(btn.dataset.i), 1); renderEditor(); commitHistory(); return scheduleAutosave();
          case "add-annex-row": (state.edit.annex.rows = state.edit.annex.rows || []).push({ label: "", amount: "", bold: false }); return renderEditor();
          case "del-annex-row": state.edit.annex.rows.splice(Number(btn.dataset.i), 1); return renderEditor();
          case "annex-import": return $("#annex-file").click();
          case "annex-img-del": state.edit.annex.images.splice(Number(btn.dataset.i), 1); renderEditor(); commitHistory(); return scheduleAutosave();
          case "annex-img-move": {
            const list = state.edit.annex.images, i = Number(btn.dataset.i), j = i + Number(btn.dataset.d);
            if (j < 0 || j >= list.length) return;
            [list[i], list[j]] = [list[j], list[i]];
            renderEditor(); commitHistory(); return scheduleAutosave();
          }
          case "annex-file-del": state.edit.annex.files.splice(Number(btn.dataset.i), 1); renderEditor(); commitHistory(); return scheduleAutosave();
          case "journal": return openJournal(state.view === "edit" ? state.edit.id : detail.id, state.view === "edit");
          case "archive": return exportArchive();
          case "save": setBusy(true, "Speichern"); try { await saveDraft(); } finally { setBusy(false); } return updateLive();
          case "preview": return previewDraft();
          case "finalize": return finalize();
          case "delete-draft":
            if (!(await confirmDialog(`Entwurf ${state.edit.number} löschen?`, "", "Löschen"))) return;
            await api("delete", { id: state.edit.id });
            state.edit = null; state.view = "list"; await refresh(); return toast("Entwurf gelöscht");
          case "save-customer": {
            const b = state.edit.buyer;
            if (!b.name) return toast("Firma fehlt", "err");
            const existing = state.customers.find((c) => c.id === state.edit.customer_id) || state.customers.find((c) => c.name === b.name);
            await api("customer_save", { id: existing?.id || null, name: b.name, data: { logo: state.edit.buyer_logo ?? existing?.data?.logo ?? "", display_name: existing?.data?.display_name || "", street: b.street, street2: b.street2, zip: b.zip, city: b.city, country: b.country, vat_id: b.vat_id, vat_print: b.vat_print || existing?.data?.vat_print || "", hide_country: b.hide_country ?? !!existing?.data?.hide_country, email: b.email, template_id: state.edit.template || existing?.data?.template_id || "", tax_case: state.edit.tax_case, lang: state.edit.lang, contact: state.edit.ordered_by } });
            state.customers = (await api("customers")).customers || [];
            return toast("Kunde gespeichert");
          }
          case "pdf": {
            const row = state.invoices.find((i) => i.id === tr.dataset.id);
            return downloadPdf(row.id, row.number, row.customer_name);
          }
          case "dl-pdf": return downloadPdf(detail.id, detail.number, detail.customer_name);
          case "dl-xml": return download(new TextEncoder().encode(detail.xml), `${safeName(detail.number)}_factur-x.xml`, "application/xml");
          case "details": {
            const d = detail, v = d.validation || {};
            const row = (k, val) => `<div class="kv"><span>${esc(k)}</span><b>${val}</b></div>`;
            const ok = (x) => (x === "passed" ? `<span class="tag tag-ok sm"><i class="fa-solid fa-check"></i> bestanden</span>` : `<span class="tag tag-bad sm">${esc(x || "fehlt")}</span>`);
            const allOk = ["precheck", "schematron", "xsd", "roundtrip", "server"].every((k) => v[k] === "passed");
            return showDialog({
              icon: allOk ? "fa-circle-check" : "fa-triangle-exclamation", tone: allOk ? "ok" : "bad",
              title: `E-Rechnung ${d.number}`,
              html: `<div class="std-tags"><span class="tag tag-std">EN 16931</span><span class="tag tag-std">Factur-X 1.09 · ZUGFeRD</span><span class="tag tag-std">Profil EN 16931</span><span class="tag tag-std">PDF/A-3</span></div>
                ${row("Pflichtangaben § 14 UStG", ok(v.precheck))}
                ${row(`Schematron (${esc(v.schematron_version || "EN 16931")})`, ok(v.schematron))}
                ${row("XSD Factur-X EN 16931", ok(v.xsd))}
                ${row("PDF/A-3 · factur-x.xml eingebettet", ok(v.roundtrip))}
                ${row("Serverprüfung", ok(v.server))}
                ${row("Geprüft mit", esc(v.lib || ""))}
                ${row("Erstellt", esc(new Date(d.finalized_at).toLocaleString("de-DE")))}
                ${row("SHA-256 PDF", `<code>${esc(d.pdf_sha256 || "")}</code>`)}
                ${row("SHA-256 XML", `<code>${esc(d.xml_sha256 || "")}</code>`)}`,
              actions: [{ label: "Schließen", value: true, primary: true }],
            });
          }
          case "cancel": {
            const reason = await confirmDialog(`Rechnung ${detail.number} stornieren?`, "Die Rechnung bleibt gespeichert und wird als storniert markiert. Eine Gutschrift an den Kunden ist separat zu erstellen.", "Stornieren", true);
            if (!reason) return;
            await api("cancel", { id: detail.id, reason });
            await refresh();
            return openDetail(detail.id);
          }
          case "new-for": {
            const c = state.customers.find((x) => x.id === ctr.dataset.cid);
            const t = customerTemplate(c) || state.templates[0];
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
          case "tpl-design": {
            readTpl();
            return openDesigner(state.tplEdit);
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
      const rt = e.target.closest?.("[data-rich]");
      if (rt && state.edit) {
        const key = rt.dataset.rich;
        if (key === "annex") {
          state.edit.annex.html = RT.sanitize(rt.innerHTML);
          state.edit.annex.text = RT.plain(state.edit.annex.html);
          pendingFocus = "annex.text";
        } else {
          const l = state.edit.lines[Number(key.split(".")[1])];
          if (!l) return;
          l.html = RT.sanitize(rt.innerHTML);
          l.label = E.lineText(l).name;
          l.detail = "";
          pendingFocus = key;
        }
        scheduleHistory();
        scheduleAutosave();
        return updateLive();
      }
      const el = e.target.closest("[data-path]");
      if (!el || !state.edit) return;
      setPath(el.dataset.path, el.type === "checkbox" ? el.checked : el.dataset.date ? window.RootsUI.deToIso(el.value) : el.value);
      pendingFocus = regionKey(el.dataset.path);
      scheduleHistory();
      scheduleAutosave();
      updateLive();
    });
    document.addEventListener("change", (e) => {
      if (e.target.id === "pick-customer" && e.target.value) {
        const c = state.customers.find((x) => x.id === e.target.value);
        const d = c?.data || {};
        Object.assign(state.edit.buyer, { name: c.name, street: d.street || "", street2: d.street2 || "", zip: d.zip || "", city: d.city || "", country: d.country || "DE", vat_id: d.vat_id || "", vat_print: d.vat_print || "", hide_country: !!d.hide_country, email: d.email || "" });
        const ct = customerTemplate(c);
        if (ct) { state.edit.tax_case = ct.data.tax_case; state.edit.lang = ct.data.lang; state.edit.template = ct.id; }
        if (d.contact) state.edit.ordered_by = d.contact;
        state.edit.customer_id = c.id;
        state.edit.buyer_logo = d.logo || "";
        return renderEditor();
      }
      if (e.target.matches?.('[data-path="annex.on"]')) return renderEditor();
      const el = e.target.closest("select[data-path]");
      if (el && state.edit && (el.dataset.path === "lang" || el.dataset.path === "tax_case")) renderEditor();
    });

    document.addEventListener("change", (e) => {
      if (e.target.id !== "annex-file") return;
      const f = e.target.files?.[0];
      e.target.value = "";
      if (f) importAnnex(f).catch((err) => { setBusy(false); toast(err.message, "err"); });
    });
    document.addEventListener("dragover", (e) => {
      const card = e.target.closest?.("#annex-card");
      if (!card || !e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      card.classList.add("dropping");
    });
    document.addEventListener("dragleave", (e) => {
      const card = e.target.closest?.("#annex-card");
      if (card && !card.contains(e.relatedTarget)) card.classList.remove("dropping");
    });
    document.addEventListener("drop", (e) => {
      const card = e.target.closest?.("#annex-card");
      if (!card) return;
      e.preventDefault();
      card.classList.remove("dropping");
      const f = e.dataTransfer?.files?.[0];
      if (f) importAnnex(f).catch((err) => { setBusy(false); toast(err.message, "err"); });
    });

    $("#cust-form").addEventListener("submit", (e) => { e.preventDefault(); saveCustomer(e.target).catch((err) => toast(err.message, "err")); });
    $("#settings-form").addEventListener("submit", (e) => { e.preventDefault(); saveSettings(e.target).catch((err) => toast(err.message, "err")); });
  }

  let releaseTimer = null;
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest?.("[data-path], [data-rich]");
    if (!el || state.view !== "edit") return;
    clearTimeout(releaseTimer);
    const key = el.dataset.rich !== undefined ? (el.dataset.rich === "annex" ? "annex.text" : el.dataset.rich) : regionKey(el.dataset.path);
    window.RootsUI.highlight($("#preview-pages"), state.regions?.[key]);
  });

  /* Formatleiste der Positionen: Fokus bleibt im Textfeld */
  document.addEventListener("mousedown", (e) => {
    const b = e.target.closest?.("[data-rt]");
    if (!b) return;
    e.preventDefault();
    const field = document.activeElement?.closest?.("[data-rich]");
    if (!field) return;
    try { document.execCommand("styleWithCSS", false, false); } catch (_) { /* alte Browser */ }
    document.execCommand(b.dataset.rt);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    updateRtBar();
  });
  function updateRtBar() {
    const inField = !!document.activeElement?.closest?.("[data-rich]");
    $$(".rt-bar [data-rt]").forEach((b) => {
      let on = false;
      if (inField && b.dataset.rt !== "removeFormat") { try { on = document.queryCommandState(b.dataset.rt); } catch (_) { on = false; } }
      b.classList.toggle("on", on);
    });
  }
  document.addEventListener("selectionchange", updateRtBar);
  document.addEventListener("focusout", () => setTimeout(updateRtBar, 0));
  /* Einfuegen aus Word: nur erlaubte Formatierung uebernehmen */
  document.addEventListener("paste", (e) => {
    const field = e.target.closest?.("[data-rich]");
    if (!field) return;
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    const txt = e.clipboardData.getData("text/plain");
    const clean = html ? RT.sanitize(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(style|script|xml|head)[\s\S]*?<\/\1>/gi, "")) : RT.esc(txt).replace(/\r?\n/g, "<br>");
    document.execCommand("insertHTML", false, clean);
  });
  document.addEventListener("focusout", (e) => {
    if (!e.target.closest?.("[data-path], [data-rich]") || state.view !== "edit") return;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      if (!document.activeElement?.closest?.("[data-path], [data-rich]")) window.RootsUI.release($("#preview-pages"));
    }, 250);
  });
  document.addEventListener("keydown", (e) => {
    if (state.view !== "edit" || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if (e.target.closest?.("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    stepHistory(e.shiftKey ? 1 : -1);
  });

  /** Beim Verlassen ausstehende Aenderungen sofort speichern; nur bei Fehler nachfragen. */
  async function leaveEditor() {
    if (!state.edit) return true;
    const touched = hist.past.length > 0 || JSON.stringify(state.edit) !== hist.last || !!state.edit.id;
    if (!touched) return true;
    clearTimeout(autosaveTimer);
    try {
      await saveDraft(true);
      return true;
    } catch (e) {
      return confirmDialog("Entwurf nicht gespeichert", e.message, "Trotzdem verlassen");
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    wire();
    boot();
  });
})();
