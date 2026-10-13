/**
 * ROOTS Rechnungen - Vorlagen-Designer.
 *
 * Die Seite zeigt das echte PDF (gerendert mit Beispieldaten) als Hintergrund;
 * darueber liegen Rahmen fuer jedes Element zum Auswaehlen, Verschieben und
 * Skalieren. Was man sieht, ist exakt das, was spaeter im PDF steht.
 * Werkzeugleiste und Bedienung angelehnt an den Memo-Editor im Signal Layer.
 */
window.RootsDesigner = (function () {
  "use strict";

  const LY = () => window.RootsLayout;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const round = (v, step = 0.5) => Math.round(v / step) * step;
  const COLORS = ["#0f172a", "#475569", "#667386", "#94a3b8", "#d9dee6", "#f1f5f9", "#ffffff", "#206efb", "#165fd9", "#eff6ff", "#10b981", "#dc2626"];
  const MARGIN = { left: 24, right: 20, top: 15, bottom: 12 };

  let D = null; // aktiver Designer

  /**
   * opts: { host, template, sample, seller, renderPdf(layout) -> Promise<Uint8Array>,
   *         onSave(layout) -> Promise, onClose() }
   */
  function open(opts) {
    const layout = JSON.parse(JSON.stringify(opts.template?.data?.layout || { version: 1, elements: [] }));
    D = { ...opts, layout, sel: null, scale: 3.2, past: [], future: [], grid: true, dirty: false, warnings: [], token: 0 };
    D.last = JSON.stringify(layout);
    renderShell();
    redraw();
    document.addEventListener("keydown", onKey);
  }

  function close() {
    document.removeEventListener("keydown", onKey);
    D = null;
  }

  /* -------------------------------------------------------------- Verlauf --- */

  function commit() {
    const cur = JSON.stringify(D.layout);
    if (cur === D.last) return;
    D.past.push(D.last);
    if (D.past.length > 150) D.past.shift();
    D.future = [];
    D.last = cur;
    D.dirty = true;
    updateRibbonState();
  }
  function step(dir) {
    const from = dir < 0 ? D.past : D.future;
    const to = dir < 0 ? D.future : D.past;
    if (!from.length) return;
    to.push(D.last);
    D.last = from.pop();
    D.layout = JSON.parse(D.last);
    if (D.sel && !find(D.sel)) D.sel = null;
    D.dirty = true;
    redraw();
  }

  const find = (id) => D.layout.elements.find((e) => e.id === id);
  const selected = () => (D.sel ? find(D.sel) : null);

  /* ---------------------------------------------------------------- Shell --- */

  function swatches(prop, title) {
    return `<div class="dz-swatches" title="${esc(title)}">${COLORS.map((c) => `<button type="button" class="dz-swatch" data-color="${c}" data-prop="${prop}" style="--c:${c}" title="${c}"></button>`).join("")}<button type="button" class="dz-swatch none" data-color="" data-prop="${prop}" title="Keine"></button></div>`;
  }

  function renderShell() {
    const blocks = Object.entries(LY().BLOCKS).map(([k, b]) => `<button type="button" class="dz-menu-item" data-add-block="${k}">${esc(b.label)}${LY().REQUIRED.includes(k) ? ' <em>Pflicht</em>' : ""}</button>`).join("");
    const phs = LY().PLACEHOLDERS.map(([k, l]) => `<button type="button" class="dz-menu-item" data-ph="${k}">${esc(l)} <code>{{${k}}}</code></button>`).join("");
    D.host.innerHTML = `
      <div class="dz">
        <div class="dz-ribbon" role="toolbar">
          <button type="button" class="dz-btn wide" data-dz="close" title="Zurück"><i class="fa-solid fa-arrow-left"></i></button>
          <span class="dz-title">${esc(D.template?.name || "Vorlage")}</span>
          <hr>
          <button type="button" class="dz-btn" data-dz="add-text" title="Textfeld"><i class="fa-solid fa-font"></i></button>
          <button type="button" class="dz-btn" data-dz="add-rect" title="Fläche"><i class="fa-regular fa-square"></i></button>
          <button type="button" class="dz-btn" data-dz="add-line" title="Linie"><i class="fa-solid fa-minus"></i></button>
          <button type="button" class="dz-btn" data-dz="add-image" title="Bild"><i class="fa-regular fa-image"></i></button>
          <div class="dz-drop"><button type="button" class="dz-btn wide" data-dz="menu" data-menu="blocks" title="Baustein"><i class="fa-solid fa-puzzle-piece"></i> Baustein <i class="fa-solid fa-chevron-down dz-car"></i></button><div class="dz-menu" data-menu-body="blocks">${blocks}</div></div>
          <div class="dz-drop"><button type="button" class="dz-btn wide" data-dz="menu" data-menu="ph" title="Platzhalter"><i class="fa-solid fa-code"></i> Platzhalter <i class="fa-solid fa-chevron-down dz-car"></i></button><div class="dz-menu" data-menu-body="ph">${phs}</div></div>
          <hr>
          <button type="button" class="dz-btn" data-dz="bold" title="Fett"><i class="fa-solid fa-bold"></i></button>
          <select class="dz-size" title="Schriftgröße">${[6, 6.8, 7, 8, 8.5, 9, 9.5, 10, 11, 12, 14, 15, 18, 22, 28, 36].map((s) => `<option value="${s}">${String(s).replace(".", ",")} pt</option>`).join("")}</select>
          <button type="button" class="dz-btn" data-dz="align" data-v="left" title="Links"><i class="fa-solid fa-align-left"></i></button>
          <button type="button" class="dz-btn" data-dz="align" data-v="center" title="Zentriert"><i class="fa-solid fa-align-center"></i></button>
          <button type="button" class="dz-btn" data-dz="align" data-v="right" title="Rechts"><i class="fa-solid fa-align-right"></i></button>
          <div class="dz-drop"><button type="button" class="dz-btn" data-dz="menu" data-menu="color" title="Schriftfarbe"><i class="fa-solid fa-font dz-colorbar" data-bar="color"></i></button><div class="dz-menu pal" data-menu-body="color">${swatches("color", "Schriftfarbe")}</div></div>
          <div class="dz-drop"><button type="button" class="dz-btn" data-dz="menu" data-menu="fill" title="Füllung"><i class="fa-solid fa-fill-drip dz-colorbar" data-bar="fill"></i></button><div class="dz-menu pal" data-menu-body="fill">${swatches("fill", "Füllung")}</div></div>
          <div class="dz-drop"><button type="button" class="dz-btn" data-dz="menu" data-menu="stroke" title="Linienfarbe"><i class="fa-solid fa-pen dz-colorbar" data-bar="stroke"></i></button><div class="dz-menu pal" data-menu-body="stroke">${swatches("stroke", "Linienfarbe")}</div></div>
          <hr>
          <button type="button" class="dz-btn" data-dz="front" title="Nach vorne"><i class="fa-solid fa-arrow-up-wide-short"></i></button>
          <button type="button" class="dz-btn" data-dz="back" title="Nach hinten"><i class="fa-solid fa-arrow-down-short-wide"></i></button>
          <button type="button" class="dz-btn" data-dz="dup" title="Duplizieren (⌘D)"><i class="fa-regular fa-copy"></i></button>
          <button type="button" class="dz-btn" data-dz="del" title="Löschen"><i class="fa-regular fa-trash-can"></i></button>
          <hr>
          <button type="button" class="dz-btn" data-dz="undo" title="Rückgängig (⌘Z)"><i class="fa-solid fa-rotate-left"></i></button>
          <button type="button" class="dz-btn" data-dz="redo" title="Wiederholen (⇧⌘Z)"><i class="fa-solid fa-rotate-right"></i></button>
          <button type="button" class="dz-btn" data-dz="grid" title="Raster und Hilfslinien"><i class="fa-solid fa-border-all"></i></button>
          <button type="button" class="dz-btn" data-dz="zoom-out" title="Verkleinern"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
          <button type="button" class="dz-btn" data-dz="zoom-in" title="Vergrößern"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
          <span class="dz-spacer"></span>
          <div class="dz-drop"><button type="button" class="dz-btn wide" data-dz="menu" data-menu="start" title="Neu beginnen"><i class="fa-regular fa-file"></i> Neu <i class="fa-solid fa-chevron-down dz-car"></i></button><div class="dz-menu right" data-menu-body="start"><button type="button" class="dz-menu-item" data-dz="start-default">Standardlayout (Richards Vorlage)</button><button type="button" class="dz-menu-item" data-dz="start-empty">Leeres Blatt</button><button type="button" class="dz-menu-item" data-dz="start-none">Layout entfernen (Standard verwenden)</button></div></div>
          <button type="button" class="btn-primary dz-save" data-dz="save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
          <input type="file" id="dz-file" accept="image/png,image/jpeg" hidden>
        </div>
        <div class="dz-body">
          <div class="dz-stage" id="dz-stage"><div class="dz-page" id="dz-page"><div class="dz-pdf" id="dz-pdf"></div><div class="dz-guides" id="dz-guides"></div><div class="dz-frames" id="dz-frames"></div></div></div>
          <aside class="dz-panel" id="dz-panel"></aside>
        </div>
        <div class="dz-ctx" id="dz-ctx"></div>
      </div>`;
    bindShell();
    window.RootsUI?.enhance(D.host);
  }

  /* ------------------------------------------------------------- Zeichnen --- */

  async function redraw() {
    layoutPage();
    drawFrames();
    renderPanel();
    updateRibbonState();
    const token = ++D.token;
    try {
      const warnings = [];
      const bytes = await D.renderPdf(D.layout, warnings);
      if (!D || token !== D.token) return;
      D.warnings = warnings;
      await paintPdf(bytes, token);
      renderPanel();
    } catch (e) {
      if (D) { D.warnings = [e.message]; renderPanel(); }
    }
  }

  function layoutPage() {
    const page = $("#dz-page");
    page.style.width = 210 * D.scale + "px";
    page.style.height = 297 * D.scale + "px";
    page.classList.toggle("grid", D.grid);
    page.style.setProperty("--mm", D.scale + "px");
    $("#dz-guides").innerHTML = D.grid ? `
      <div class="dz-margin" style="left:${MARGIN.left * D.scale}px;top:${MARGIN.top * D.scale}px;right:${MARGIN.right * D.scale}px;bottom:${MARGIN.bottom * D.scale}px"></div>` : "";
  }

  async function paintPdf(bytes, token) {
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.js", location.href).href;
    const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: ((210 * D.scale) / base.width) * ratio });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    c.style.width = 210 * D.scale + "px";
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    doc.destroy();
    if (!D || token !== D.token) return;
    $("#dz-pdf").replaceChildren(c);
  }

  function frameLabel(e) {
    if (e.type === "block") return LY().BLOCKS[e.block]?.label || e.block;
    return { text: "Text", rect: "Fläche", line: "Linie", image: "Bild" }[e.type];
  }

  function drawFrames() {
    const k = D.scale;
    const els = [...D.layout.elements].sort((a, b) => (a.z || 0) - (b.z || 0));
    $("#dz-frames").innerHTML = els.map((e) => {
      const isLine = e.type === "line";
      const h = isLine ? Math.max(Math.abs(e.h), 0) : e.h;
      return `<div class="dz-frame${e.id === D.sel ? " sel" : ""}${isLine ? " line" : ""}" data-id="${e.id}" style="left:${e.x * k}px;top:${e.y * k}px;width:${Math.max(e.w, 0.5) * k}px;height:${Math.max(h, isLine ? 0 : 1) * k}px">
        <span class="dz-tag">${esc(frameLabel(e))}${e.repeat ? ' <i class="fa-solid fa-layer-group"></i>' : ""}</span>
        ${e.id === D.sel ? (isLine ? '<i class="dz-h" data-h="w"></i><i class="dz-h" data-h="e"></i>' : ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((h) => `<i class="dz-h" data-h="${h}"></i>`).join("")) : ""}
      </div>`;
    }).join("");
  }

  /* -------------------------------------------------------- Eigenschaften --- */

  function num(label, key, v, stepv = 0.5) {
    return `<label class="dz-f"><span>${esc(label)}</span><input data-p="${key}" inputmode="decimal" value="${esc(String(round(v, 0.1)).replace(".", ","))}" data-step="${stepv}"></label>`;
  }

  function renderPanel() {
    const panel = $("#dz-panel");
    if (!panel) return;
    const e = selected();
    const missing = LY().required(D.layout);
    const status = `
      <section class="dz-sec">
        <h4>Pflichtangaben</h4>
        ${missing.length ? `<ul class="dz-warn">${missing.map((m) => `<li>Baustein fehlt: ${esc(m)}</li>`).join("")}</ul>` : `<p class="dz-ok"><i class="fa-solid fa-circle-check"></i> Alle Pflichtbausteine vorhanden</p>`}
        ${D.warnings.length ? `<ul class="dz-warn">${D.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      </section>`;
    if (!e) {
      panel.innerHTML = `${status}<section class="dz-sec"><h4>Elemente</h4><div class="dz-list">${[...D.layout.elements].sort((a, b) => a.y - b.y).map((x) => `<button type="button" class="dz-list-item" data-pick="${x.id}">${esc(frameLabel(x))}<span>${round(x.y, 1).toString().replace(".", ",")} mm</span></button>`).join("") || '<p class="dz-muted">Leeres Blatt</p>'}</div></section>`;
      return;
    }
    const s = e.style || {};
    let typeFields = "";
    if (e.type === "text") {
      typeFields = `<label class="dz-f wide"><span>Text</span><textarea data-p="text" rows="4">${esc(e.text || "")}</textarea></label>`;
    }
    if (e.type === "image") {
      typeFields = `<div class="dz-f wide"><button type="button" class="btn-secondary" data-dz="pick-image"><i class="fa-regular fa-image"></i> Bild wählen</button></div>`;
    }
    if (e.type === "rect") {
      typeFields = num("Eckenradius mm", "style.radius", s.radius || 0) + num("Rahmen pt", "style.strokeWidth", s.strokeWidth || 0, 0.25) + num("Deckkraft %", "style.opacityPct", (s.opacity ?? 1) * 100, 5);
    }
    if (e.type === "line") {
      typeFields = num("Stärke pt", "style.strokeWidth", s.strokeWidth || 0.75, 0.25);
    }
    if (e.type === "text" || e.type === "block") {
      typeFields += num("Zeilenabstand", "style.lineHeight", s.lineHeight || 1.32, 0.05);
    }
    panel.innerHTML = `${status}
      <section class="dz-sec">
        <div class="dz-sec-head"><h4>${esc(frameLabel(e))}</h4><button type="button" class="icon-btn" data-dz="deselect" title="Auswahl aufheben"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="dz-grid">
          ${num("X mm", "x", e.x)}${num("Y mm", "y", e.y)}
          ${num(e.type === "line" ? "Länge X mm" : "Breite mm", "w", e.w)}${num(e.type === "line" ? "Länge Y mm" : "Höhe mm", "h", e.h)}
          ${typeFields}
          <label class="dz-check wide"><input type="checkbox" data-p="repeat" ${e.repeat ? "checked" : ""}> Auf allen Seiten</label>
        </div>
      </section>`;
  }

  /* ------------------------------------------------------------- Bedienung --- */

  function setProp(e, path, raw) {
    if (path === "repeat") { e.repeat = !!raw; return; }
    if (path === "text") { e.text = raw; return; }
    const v = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    if (!Number.isFinite(v)) return;
    if (path === "style.opacityPct") { e.style.opacity = Math.max(0, Math.min(1, v / 100)); return; }
    if (path.startsWith("style.")) { e.style[path.slice(6)] = v; return; }
    e[path] = v;
  }

  let redrawTimer = null;
  const soon = () => { clearTimeout(redrawTimer); redrawTimer = setTimeout(redraw, 220); };

  function add(el) {
    el.z = Math.max(0, ...D.layout.elements.map((x) => x.z || 0)) + 1;
    D.layout.elements.push(el);
    D.sel = el.id;
    commit();
    redraw();
  }

  function act(name, btn) {
    const e = selected();
    switch (name) {
      case "close":
        if (D.dirty) return D.confirm("Änderungen am Layout verwerfen?").then((ok) => { if (ok) { const cb = D.onClose; close(); cb(); } });
        { const cb = D.onClose; close(); return cb(); }
      case "save":
        return D.onSave(D.layout.elements.length ? D.layout : null).then(() => { D.dirty = false; updateRibbonState(); });
      case "add-text": return add(LY().newElement("text"));
      case "add-rect": return add(LY().newElement("rect"));
      case "add-line": return add(LY().newElement("line"));
      case "add-image": D.pendingImage = null; return $("#dz-file").click();
      case "pick-image": D.pendingImage = e?.id; return $("#dz-file").click();
      case "bold": if (e && (e.type === "text" || e.type === "block")) { e.style.font = e.style.font === "bold" ? "regular" : "bold"; commit(); redraw(); } return;
      case "align": if (e) { e.style.align = btn.dataset.v; commit(); redraw(); } return;
      case "front": if (e) { e.z = Math.max(...D.layout.elements.map((x) => x.z || 0)) + 1; commit(); redraw(); } return;
      case "back": if (e) { e.z = Math.min(...D.layout.elements.map((x) => x.z || 0)) - 1; commit(); redraw(); } return;
      case "dup": if (e) { const c = JSON.parse(JSON.stringify(e)); c.id = LY().newElement("text").id; c.x += 4; c.y += 4; add(c); } return;
      case "del": if (e) { D.layout.elements = D.layout.elements.filter((x) => x.id !== e.id); D.sel = null; commit(); redraw(); } return;
      case "undo": return step(-1);
      case "redo": return step(1);
      case "grid": D.grid = !D.grid; layoutPage(); updateRibbonState(); return;
      case "zoom-in": D.scale = Math.min(6, D.scale + 0.4); return redraw();
      case "zoom-out": D.scale = Math.max(1.6, D.scale - 0.4); return redraw();
      case "deselect": D.sel = null; drawFrames(); renderPanel(); return;
      case "start-default": D.layout = LY().defaultLayout(); D.sel = null; commit(); return redraw();
      case "start-empty": D.layout = LY().emptyLayout(); D.sel = null; commit(); return redraw();
      case "start-none": D.layout = LY().emptyLayout(); D.sel = null; commit(); return redraw();
    }
  }

  function bindShell() {
    const root = $(".dz", D.host);
    root.addEventListener("mousedown", (ev) => { if (ev.target.closest(".dz-ribbon button")) ev.preventDefault(); });
    root.addEventListener("click", (ev) => {
      const menuBtn = ev.target.closest("[data-dz='menu']");
      root.querySelectorAll(".dz-menu.open").forEach((m) => { if (!menuBtn || m.dataset.menuBody !== menuBtn.dataset.menu) m.classList.remove("open"); });
      if (menuBtn) { root.querySelector(`[data-menu-body="${menuBtn.dataset.menu}"]`).classList.toggle("open"); return; }
      const blk = ev.target.closest("[data-add-block]");
      if (blk) { closeMenus(); return add(LY().newElement("block", blk.dataset.addBlock)); }
      const ph = ev.target.closest("[data-ph]");
      if (ph) {
        closeMenus();
        const e = selected();
        const token = `{{${ph.dataset.ph}}}`;
        if (e && e.type === "text") { e.text = (e.text || "") + token; }
        else { const t = LY().newElement("text"); t.text = token; return add(t); }
        commit(); return redraw();
      }
      const sw = ev.target.closest(".dz-swatch");
      if (sw) {
        closeMenus();
        const e = selected();
        if (!e) return;
        e.style[sw.dataset.prop] = sw.dataset.color;
        if (sw.dataset.prop === "stroke" && sw.dataset.color && !(Number(e.style.strokeWidth) > 0)) e.style.strokeWidth = 0.75;
        commit(); return redraw();
      }
      const pick = ev.target.closest("[data-pick]");
      if (pick) { D.sel = pick.dataset.pick; drawFrames(); renderPanel(); return; }
      const b = ev.target.closest("[data-dz]");
      if (b && b.dataset.dz !== "menu") { closeMenus(); act(b.dataset.dz, b); }
      if (!ev.target.closest(".dz-ctx")) $("#dz-ctx").classList.remove("open");
    });
    root.querySelector(".dz-size").addEventListener("change", (ev) => {
      const e = selected();
      if (!e) return;
      e.style.size = Number(ev.target.value);
      commit(); redraw();
    });
    $("#dz-file").addEventListener("change", async (ev) => {
      const f = ev.target.files?.[0];
      ev.target.value = "";
      if (!f) return;
      try {
        const src = await toDataUrl(f);
        if (D.pendingImage) { const e = find(D.pendingImage); if (e) e.src = src; commit(); return redraw(); }
        const img = LY().newElement("image");
        img.src = src;
        add(img);
      } catch (err) { D.toast?.(err.message, "err"); }
    });
    const panel = $("#dz-panel");
    panel.addEventListener("input", (ev) => {
      const el = ev.target.closest("[data-p]");
      const e = selected();
      if (!el || !e) return;
      setProp(e, el.dataset.p, el.type === "checkbox" ? el.checked : el.value);
      drawFrames();
      clearTimeout(D.commitT);
      D.commitT = setTimeout(commit, 500);
      soon();
    });
    panel.addEventListener("click", (ev) => {
      const pick = ev.target.closest("[data-pick]");
      if (pick) { D.sel = pick.dataset.pick; drawFrames(); renderPanel(); }
    });

    const stage = $("#dz-stage");
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("dblclick", (ev) => {
      const f = ev.target.closest(".dz-frame");
      if (!f) return;
      const e = find(f.dataset.id);
      if (e?.type === "text") { D.sel = e.id; renderPanel(); const ta = $("#dz-panel textarea"); ta?.focus(); ta?.select(); }
    });
    stage.addEventListener("contextmenu", (ev) => {
      const f = ev.target.closest(".dz-frame");
      if (!f) return;
      ev.preventDefault();
      D.sel = f.dataset.id; drawFrames(); renderPanel();
      const m = $("#dz-ctx");
      const e = find(D.sel);
      m.innerHTML = `
        <button type="button" data-dz="dup"><i class="fa-regular fa-copy"></i> Duplizieren</button>
        <button type="button" data-dz="front"><i class="fa-solid fa-arrow-up-wide-short"></i> Nach vorne</button>
        <button type="button" data-dz="back"><i class="fa-solid fa-arrow-down-short-wide"></i> Nach hinten</button>
        ${e.type === "image" ? '<button type="button" data-dz="pick-image"><i class="fa-regular fa-image"></i> Bild ersetzen</button>' : ""}
        <hr><button type="button" data-dz="del" class="danger"><i class="fa-regular fa-trash-can"></i> Löschen</button>`;
      const r = root.getBoundingClientRect();
      m.style.left = ev.clientX - r.left + "px";
      m.style.top = ev.clientY - r.top + "px";
      m.classList.add("open");
    });
  }

  function closeMenus() {
    D.host.querySelectorAll(".dz-menu.open").forEach((m) => m.classList.remove("open"));
  }

  function toDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg)$/.test(file.type)) return reject(new Error("Nur PNG oder JPG"));
      if (file.size > 2 * 1024 * 1024) return reject(new Error("Bild größer als 2 MB"));
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Bild nicht lesbar"));
      r.readAsDataURL(file);
    });
  }

  function updateRibbonState() {
    if (!D) return;
    const e = selected();
    const root = D.host;
    const has = !!e;
    const textual = has && (e.type === "text" || e.type === "block");
    root.querySelectorAll('[data-dz="bold"],[data-dz="align"],.dz-size,[data-menu="color"]').forEach((b) => { b.disabled = !textual; });
    root.querySelectorAll('[data-menu="fill"]').forEach((b) => { b.disabled = !(has && e.type === "rect"); });
    root.querySelectorAll('[data-menu="stroke"]').forEach((b) => { b.disabled = !(has && (e.type === "rect" || e.type === "line")); });
    root.querySelectorAll('[data-dz="front"],[data-dz="back"],[data-dz="dup"],[data-dz="del"]').forEach((b) => { b.disabled = !has; });
    const u = root.querySelector('[data-dz="undo"]'); if (u) u.disabled = !D.past.length;
    const r = root.querySelector('[data-dz="redo"]'); if (r) r.disabled = !D.future.length;
    root.querySelector('[data-dz="grid"]')?.classList.toggle("on", D.grid);
    root.querySelector('[data-dz="bold"]')?.classList.toggle("on", textual && e.style.font === "bold");
    root.querySelectorAll('[data-dz="align"]').forEach((b) => b.classList.toggle("on", textual && (e.style.align || "left") === b.dataset.v));
    const size = root.querySelector(".dz-size");
    if (size && textual) { size.value = String(e.style.size || 9.5); size._csFill?.(); }
    size?.closest(".cs")?.classList.toggle("disabled", !textual);
    ["color", "fill", "stroke"].forEach((p) => {
      const bar = root.querySelector(`[data-bar="${p}"]`);
      if (bar) bar.style.setProperty("--bar", (has && e.style[p]) || "transparent");
    });
    const save = root.querySelector('[data-dz="save"]');
    if (save) save.classList.toggle("dirty", D.dirty);
  }

  /* --------------------------------------------------- Ziehen, Skalieren --- */

  function snapLines(exceptId) {
    const xs = [0, MARGIN.left, 105, 210 - MARGIN.right, 210];
    const ys = [0, MARGIN.top, 148.5, 297 - MARGIN.bottom, 297];
    D.layout.elements.forEach((o) => {
      if (o.id === exceptId) return;
      xs.push(o.x, o.x + o.w);
      ys.push(o.y, o.y + o.h);
    });
    return { xs, ys };
  }

  function snap(v, lines, tol) {
    let best = null;
    for (const l of lines) if (Math.abs(l - v) <= tol && (best === null || Math.abs(l - v) < Math.abs(best - v))) best = l;
    return best;
  }

  function onDown(ev) {
    if (ev.button !== 0) return;
    const frame = ev.target.closest(".dz-frame");
    if (!frame) {
      if (ev.target.closest(".dz-page") || ev.target.closest(".dz-stage")) { D.sel = null; drawFrames(); renderPanel(); updateRibbonState(); }
      return;
    }
    const e = find(frame.dataset.id);
    if (!e) return;
    if (D.sel !== e.id) { D.sel = e.id; drawFrames(); renderPanel(); updateRibbonState(); }
    const handle = ev.target.closest(".dz-h")?.dataset.h || "move";
    const start = { x: ev.clientX, y: ev.clientY, e: { ...e } };
    const lines = snapLines(e.id);
    const tol = 6 / D.scale;
    let moved = false;
    ev.preventDefault();

    const move = (mv) => {
      const dx = (mv.clientX - start.x) / D.scale;
      const dy = (mv.clientY - start.y) / D.scale;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.4) return;
      moved = true;
      const o = start.e;
      const guides = [];
      const free = mv.altKey;
      if (handle === "move") {
        let nx = round(o.x + dx), ny = round(o.y + dy);
        if (D.grid && !free) {
          const sx = snap(nx, lines.xs, tol) ?? (snap(nx + o.w, lines.xs, tol) !== null ? snap(nx + o.w, lines.xs, tol) - o.w : null);
          const sy = snap(ny, lines.ys, tol) ?? (snap(ny + o.h, lines.ys, tol) !== null ? snap(ny + o.h, lines.ys, tol) - o.h : null);
          if (sx !== null) { nx = sx; guides.push(["v", lines.xs.find((l) => l === nx || l === nx + o.w)]); }
          if (sy !== null) { ny = sy; guides.push(["h", lines.ys.find((l) => l === ny || l === ny + o.h)]); }
        }
        e.x = nx; e.y = ny;
      } else if (e.type === "line") {
        if (handle === "e") { e.w = round(o.w + dx); e.h = mv.shiftKey ? round(o.h + dy) : o.h; }
        else { e.x = round(o.x + dx); e.w = round(o.w - dx); }
      } else {
        let { x, y, w, h } = o;
        if (handle.includes("e")) w = Math.max(2, round(o.w + dx));
        if (handle.includes("s")) h = Math.max(1, round(o.h + dy));
        if (handle.includes("w")) { x = round(o.x + dx); w = Math.max(2, o.w - (x - o.x)); }
        if (handle.includes("n")) { y = round(o.y + dy); h = Math.max(1, o.h - (y - o.y)); }
        if (D.grid && !free) {
          if (handle.includes("e")) { const s = snap(x + w, lines.xs, tol); if (s !== null) { w = s - x; guides.push(["v", s]); } }
          if (handle.includes("s")) { const s = snap(y + h, lines.ys, tol); if (s !== null) { h = s - y; guides.push(["h", s]); } }
          if (handle.includes("w")) { const s = snap(x, lines.xs, tol); if (s !== null) { w += x - s; x = s; guides.push(["v", s]); } }
          if (handle.includes("n")) { const s = snap(y, lines.ys, tol); if (s !== null) { h += y - s; y = s; guides.push(["h", s]); } }
        }
        Object.assign(e, { x, y, w, h });
      }
      drawFrames();
      showGuides(guides);
      const f = $(`.dz-frame[data-id="${e.id}"]`);
      f?.classList.add("dragging");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      showGuides([]);
      if (moved) { commit(); redraw(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function showGuides(list) {
    const g = $("#dz-guides");
    g.querySelectorAll(".dz-guide").forEach((n) => n.remove());
    list.forEach(([dir, v]) => {
      if (v === undefined) return;
      const n = document.createElement("div");
      n.className = "dz-guide " + dir;
      n.style[dir === "v" ? "left" : "top"] = v * D.scale + "px";
      g.appendChild(n);
    });
  }

  function onKey(ev) {
    if (!D) return;
    if (ev.target.closest?.("input, textarea, select")) return;
    const e = selected();
    const meta = ev.metaKey || ev.ctrlKey;
    if (meta && ev.key.toLowerCase() === "z") { ev.preventDefault(); return step(ev.shiftKey ? 1 : -1); }
    if (meta && ev.key.toLowerCase() === "d") { ev.preventDefault(); return act("dup"); }
    if (meta && ev.key.toLowerCase() === "s") { ev.preventDefault(); return act("save"); }
    if (!e) return;
    if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); return act("del"); }
    if (ev.key === "Escape") return act("deselect");
    const d = ev.shiftKey ? 5 : 0.5;
    const map = { ArrowLeft: ["x", -d], ArrowRight: ["x", d], ArrowUp: ["y", -d], ArrowDown: ["y", d] };
    if (map[ev.key]) {
      ev.preventDefault();
      e[map[ev.key][0]] = round(e[map[ev.key][0]] + map[ev.key][1]);
      drawFrames(); renderPanel();
      clearTimeout(D.commitT); D.commitT = setTimeout(commit, 400);
      soon();
    }
  }

  return { open, close };
})();
