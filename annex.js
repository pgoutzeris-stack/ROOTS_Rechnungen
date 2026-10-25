/**
 * ROOTS Rechnungen - Anlagen aus Excel, Word, PDF und Bildern.
 *
 * capture(file) oeffnet einen Vollbild-Dialog:
 *   Excel  Tabelle mit Spalten- und Zeilenkoepfen, Bereich per Ziehen waehlen
 *          (wie in Excel). Der Bereich wird ohne Gitternetz mit Schrift,
 *          Fuellung, Rahmen und verbundenen Zellen als Bild gezeichnet.
 *   Word / PDF / Bild  Seiten untereinander, Ausschnitt per Rechteck aufziehen.
 * Ergebnis: { bytes: Uint8Array (PNG), w, h (CSS-Pixel), label } oder null.
 *
 * Die Bibliotheken (ExcelJS, JSZip + docx-preview) werden erst
 * beim ersten Import geladen.
 */
window.RootsAnnex = (function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SCALE = 2.5;           // Aufloesung des Bildes relativ zu CSS-Pixeln
  const MAX_ROWS = 400, MAX_COLS = 60;

  const MIME = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };

  function kind(file) {
    const ext = String(file.name || "").toLowerCase().split(".").pop();
    if (ext === "xlsx" || ext === "xlsm") return { type: "excel", mime: MIME[ext] };
    if (ext === "docx") return { type: "word", mime: MIME.docx };
    if (ext === "pdf") return { type: "pdf", mime: MIME.pdf };
    if (ext === "png" || ext === "jpg" || ext === "jpeg") return { type: "image", mime: MIME[ext] };
    if (ext === "xls") return { type: "old", hint: "Alte Excel-Datei (.xls): bitte als .xlsx speichern." };
    if (ext === "doc") return { type: "old", hint: "Alte Word-Datei (.doc): bitte als .docx speichern." };
    return { type: "unknown", hint: "Dateityp nicht unterstützt. Erlaubt: .xlsx, .xlsm, .docx, .pdf, .png, .jpg" };
  }

  /* ------------------------------------------------------------ Laden --- */

  const loaded = {};
  function script(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loaded[src]; reject(new Error(src.split("/").pop() + " konnte nicht geladen werden")); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }
  const libs = {
    excel: () => script("vendor/exceljs.min.js"),
    word: async () => { await script("vendor/jszip.min.js"); await script("vendor/docx-preview.min.js"); },
    zip: () => script("vendor/jszip.min.js"),
  };

  /* ----------------------------------------------------------- Dialog --- */

  function overlay(title) {
    const el = document.createElement("div");
    el.className = "ax-overlay";
    el.innerHTML = `
      <div class="ax-shell">
        <header class="ax-head">
          <div class="ax-title"><i class="fa-regular fa-file"></i><span>${esc(title)}</span></div>
          <div class="ax-tabs"></div>
          <button class="icon-btn ax-close" title="Schließen"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="ax-body"><div class="ax-loading"><span class="spinner"></span> Datei wird geöffnet</div></div>
        <footer class="ax-foot">
          <span class="ax-sel"></span>
          <div class="ax-actions">
            <button class="btn-secondary ax-all hidden"></button>
            <button class="btn-secondary ax-cancel">Abbrechen</button>
            <button class="btn-primary ax-ok" disabled><i class="fa-solid fa-crop-simple"></i> In die Anlage</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("open"));
    return el;
  }

  async function capture(file) {
    const k = kind(file);
    if (k.type === "old" || k.type === "unknown") throw new Error(k.hint);
    const buf = await file.arrayBuffer();
    const el = overlay(file.name);
    const body = el.querySelector(".ax-body");
    const ok = el.querySelector(".ax-ok");
    const selLabel = el.querySelector(".ax-sel");

    return new Promise((resolve) => {
      let view = null;
      const done = (v) => {
        document.removeEventListener("keydown", onKey, true);
        el.classList.remove("open");
        setTimeout(() => el.remove(), 180);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.stopPropagation(); done(null); }
        if (e.key === "Enter" && !ok.disabled) { e.stopPropagation(); ok.click(); }
      };
      document.addEventListener("keydown", onKey, true);
      el.querySelector(".ax-close").onclick = () => done(null);
      el.querySelector(".ax-cancel").onclick = () => done(null);
      const onSelect = (text) => { selLabel.textContent = text || ""; ok.disabled = !text; };
      const all = el.querySelector(".ax-all");
      const run = async (btn, fn) => {
        ok.disabled = true; all.disabled = true;
        const prev = btn.innerHTML;
        btn.innerHTML = `<span class="spinner"></span> Bild wird erzeugt`;
        try {
          const shots = [].concat(await fn());
          done(shots.map((s) => ({ ...s, label: `${file.name} · ${s.label}` })));
        } catch (e) {
          btn.innerHTML = prev;
          ok.disabled = false; all.disabled = false;
          selLabel.textContent = e.message;
        }
      };
      ok.onclick = () => run(ok, () => view.shot());
      all.onclick = () => run(all, () => view.all());

      (async () => {
        try {
          if (k.type === "excel") view = await excelView(buf, body, el.querySelector(".ax-tabs"), onSelect);
          else view = await pageView(k.type, buf, body, onSelect);
          if (view.allLabel) { all.innerHTML = view.allLabel; all.classList.remove("hidden"); }
        } catch (e) {
          body.innerHTML = `<div class="ax-loading err"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(e.message || e)}</div>`;
        }
      })();
    });
  }

  /* ------------------------------------------------------------ Excel --- */

  const OFFICE_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];

  function themeColors(wb) {
    const xml = wb?._themes?.theme1;
    if (!xml) return OFFICE_THEME;
    const pick = (name) => {
      const m = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(xml);
      if (!m) return null;
      const v = /srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]) || /lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]);
      return v ? v[1].toUpperCase() : null;
    };
    // Reihenfolge der Theme-Indizes in Excel: lt1, dk1, lt2, dk2, accent1..6
    const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];
    return order.map((n, i) => pick(n) || OFFICE_THEME[i]);
  }

  function tint(hex, t) {
    if (!t) return hex;
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const out = c.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t));
    return out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
  }

  const INDEXED = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080"];

  function color(c, theme, fallback) {
    if (!c) return fallback;
    if (c.argb && /^[0-9A-Fa-f]{8}$/.test(c.argb)) return "#" + tint(c.argb.slice(2).toUpperCase(), c.tint);
    if (c.theme !== undefined && theme[c.theme]) return "#" + tint(theme[c.theme], c.tint);
    if (c.indexed !== undefined && INDEXED[c.indexed]) return "#" + INDEXED[c.indexed];
    return fallback;
  }

  function colName(n) {
    let s = "";
    for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }
  function parseRef(ref) {
    const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref).trim().toUpperCase());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    return { r: Number(m[2]) - 1, c: c - 1 };
  }
  function parseRange(ref) {
    const [a, b] = String(ref).replace(/^.*!/, "").split(":");
    const p = parseRef(a), q = parseRef(b || a);
    if (!p || !q) return null;
    return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
  }

  /* Zahlenformate: die gaengigen Faelle aus Kalkulationen, deutsch dargestellt. */
  function fmtNumber(v, fmt) {
    fmt = String(fmt || "General");
    if (fmt === "General" || fmt === "@") {
      const s = Math.abs(v) >= 1e11 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : String(+v.toPrecision(11));
      return s.replace(".", ",");
    }
    const sections = fmt.split(";");
    const neg = v < 0;
    let sec = sections[0];
    if (neg && sections[1]) sec = sections[1];
    else if (v === 0 && sections[2]) sec = sections[2];
    const clean = sec.replace(/\[(Red|Rot|Black|Schwarz|Blue|Blau|Green|Grün|Color\d+)\]/gi, "").replace(/\[\$([^\]-]*)(-[^\]]*)?\]/g, (_, sym) => `"${sym}"`);
    const numPart = clean.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/_.|\*./g, "");
    const pct = /%/.test(numPart);
    if (!/[0#?]/.test(numPart)) return String(v).replace(".", ",");
    const decMatch = /\.([0#?]+)/.exec(numPart);
    const decimals = decMatch ? decMatch[1].length : 0;
    const grouping = /[0#?],[0#?]/.test(numPart);
    let n = Math.abs(v) * (pct ? 100 : 1);
    const scale = /[0#?](,+)(?![0#?])/.exec(numPart);
    if (scale) n = n / Math.pow(1000, scale[1].length);
    let txt = n.toLocaleString("de-DE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping });
    if (neg && sections[1]) {
      if (/\(/.test(numPart)) txt = `(${txt})`;
      else if (/-/.test(numPart)) txt = "-" + txt;
    } else if (neg) txt = "-" + txt;
    if (v === 0 && !/0/.test(numPart)) txt = "";
    // Literale vor und nach der Zahl
    const lit = (part) => (part.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1)).join("") + part.replace(/"[^"]*"/g, "").replace(/[0#?.,%()\-_*\\ ]|\[.*?\]/g, "");
    const firstDigit = clean.search(/[0#?]/);
    const lastDigit = Math.max(clean.lastIndexOf("0"), clean.lastIndexOf("#"), clean.lastIndexOf("?"));
    const before = firstDigit > 0 ? lit(clean.slice(0, firstDigit)) : "";
    const after = lastDigit >= 0 ? lit(clean.slice(lastDigit + 1)) : "";
    const spaceAfter = /^\s|^_|"\s/.test(clean.slice(lastDigit + 1).replace(/[%)]/, "")) || /\s"?€/.test(clean.slice(lastDigit + 1));
    return `${before}${txt}${pct ? "%" : ""}${after ? (spaceAfter ? " " : "") + after.trim() : ""}`.trim();
  }

  function fmtDate(d, fmt) {
    const p = (n) => String(n).padStart(2, "0");
    const f = String(fmt || "").toLowerCase();
    const date = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    if (/h/.test(f) && /[dmy]/.test(f.replace(/\[.*?\]/g, "").replace(/mm(?=:)|:mm/g, ""))) return `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (/h/.test(f)) return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (/mmm/.test(f) && !/d/.test(f)) return d.toLocaleDateString("de-DE", { month: f.includes("mmmm") ? "long" : "short", year: "numeric", timeZone: "UTC" });
    if (/^m+[./ -]?y+$/.test(f.replace(/\\/g, ""))) return `${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
    if (/yy/.test(f) && !/yyyy/.test(f)) return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`;
    return date;
  }

  function cellText(cell) {
    let v = cell.value;
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && !(v instanceof Date)) {
      if (v.richText) return v.richText.map((r) => r.text).join("");
      if ("result" in v || "formula" in v || "sharedFormula" in v) v = v.result;
      else if (v.text !== undefined) return String(v.text);
      else if (v.error) return v.error;
    }
    if (v === null || v === undefined) return "";
    if (v && typeof v === "object" && v.error) return v.error;
    if (v instanceof Date) return fmtDate(v, cell.numFmt);
    if (typeof v === "number") return fmtNumber(v, cell.numFmt);
    if (typeof v === "boolean") return v ? "WAHR" : "FALSCH";
    return String(v);
  }

  const BORDER = { thin: "1px solid", hair: "1px solid", medium: "2px solid", thick: "3px solid", double: "3px double", dotted: "1px dotted", dashed: "1px dashed", mediumDashed: "2px dashed", dashDot: "1px dashed", mediumDashDot: "2px dashed", dashDotDot: "1px dotted", slantDashDot: "2px dashed" };

  function cellStyle(cell, theme, isNumber) {
    const s = [];
    const f = cell.font || {};
    if (f.bold) s.push("font-weight:700");
    if (f.italic) s.push("font-style:italic");
    if (f.underline) s.push("text-decoration:underline");
    if (f.strike) s.push("text-decoration:line-through");
    if (f.size) s.push(`font-size:${(f.size * 4) / 3}px`);
    if (f.name) s.push(`font-family:'${String(f.name).replace(/'/g, "")}',Calibri,Arial,sans-serif`);
    const fc = color(f.color, theme, null);
    if (fc) s.push(`color:${fc}`);
    const fill = cell.fill;
    if (fill && fill.type === "pattern" && fill.pattern && fill.pattern !== "none") {
      const bg = color(fill.fgColor, theme, null) || color(fill.bgColor, theme, null);
      if (bg) s.push(`background:${bg}`);
    } else if (fill && fill.type === "gradient" && fill.stops?.length) {
      const bg = color(fill.stops[0].color, theme, null);
      if (bg) s.push(`background:${bg}`);
    }
    const b = cell.border || {};
    for (const side of ["top", "right", "bottom", "left"]) {
      if (b[side]?.style) s.push(`border-${side}:${BORDER[b[side].style] || "1px solid"} ${color(b[side].color, theme, "#000")}`);
    }
    const a = cell.alignment || {};
    const h = a.horizontal === "centerContinuous" ? "center" : a.horizontal;
    s.push(`text-align:${h && h !== "general" && h !== "fill" && h !== "distributed" ? (h === "justify" ? "justify" : h) : isNumber ? "right" : "left"}`);
    s.push(`vertical-align:${a.vertical === "top" ? "top" : a.vertical === "middle" || a.vertical === "center" ? "middle" : "bottom"}`);
    if (a.wrapText) s.push("white-space:pre-wrap;word-break:break-word");
    if (a.indent) s.push(`padding-left:${3 + a.indent * 9}px`);
    return s.join(";");
  }

  async function excelView(buf, body, tabs, onSelect) {
    await libs.excel();
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const theme = themeColors(wb);
    const sheets = wb.worksheets.filter((w) => w.state !== "hidden" && w.state !== "veryHidden");
    if (!sheets.length) throw new Error("Die Datei enthält keine sichtbare Tabelle.");

    let ws = null, model = null, sel = null;

    tabs.innerHTML = sheets.length > 1 ? sheets.map((w, i) => `<button class="ax-tab" data-i="${i}">${esc(w.name)}</button>`).join("") : "";
    tabs.onclick = (e) => {
      const b = e.target.closest(".ax-tab");
      if (b) show(Number(b.dataset.i));
    };

    function buildModel(sheet) {
      let rows = 0, cols = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rn) => {
        row.eachCell({ includeEmpty: false }, (cell, cn) => {
          if (cell.value !== null && cell.value !== undefined && cell.value !== "" || cell.fill?.pattern && cell.fill.pattern !== "none" || cell.border && Object.keys(cell.border).length) {
            rows = Math.max(rows, rn);
            cols = Math.max(cols, cn);
          }
        });
      });
      const merges = [];
      const mergeList = sheet.model?.merges || Object.keys(sheet._merges || {}).map((k) => sheet._merges[k].range || sheet._merges[k]);
      (mergeList || []).forEach((m) => {
        const r = parseRange(typeof m === "string" ? m : m.range || m.tl + ":" + m.br);
        if (r) { merges.push(r); rows = Math.max(rows, r.r2 + 1); cols = Math.max(cols, r.c2 + 1); }
      });
      const used = { r2: Math.min(Math.max(rows, 1), MAX_ROWS) - 1, c2: Math.min(Math.max(cols, 1), MAX_COLS) - 1 };
      rows = Math.min(Math.max(rows, 1) + 2, MAX_ROWS);
      cols = Math.min(Math.max(cols, 1) + 1, MAX_COLS);
      const master = new Map(), covered = new Set();
      merges.forEach((m) => {
        master.set(`${m.r1}:${m.c1}`, m);
        for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
      });
      const colW = [], hiddenC = [];
      for (let c = 0; c < cols; c++) {
        const col = sheet.getColumn(c + 1);
        hiddenC[c] = !!col.hidden;
        colW[c] = Math.round((col.width || sheet.properties?.defaultColWidth || 8.43) * 7 + 5);
      }
      const rowH = [], hiddenR = [];
      for (let r = 0; r < rows; r++) {
        const row = sheet.getRow(r + 1);
        hiddenR[r] = !!row.hidden;
        rowH[r] = Math.round(((row.height || sheet.properties?.defaultRowHeight || 15) * 4) / 3);
      }
      // erste belegte Zeile und Spalte, damit leere Raender nicht ins Bild kommen
      let r1 = used.r2, c1 = used.c2;
      sheet.eachRow({ includeEmpty: false }, (row, rn) => row.eachCell({ includeEmpty: false }, (cell, cn) => {
        if (cell.value !== null && cell.value !== undefined && cell.value !== "" || cell.fill?.pattern && cell.fill.pattern !== "none") { r1 = Math.min(r1, rn - 1); c1 = Math.min(c1, cn - 1); }
      }));
      merges.forEach((m) => { r1 = Math.min(r1, m.r1); c1 = Math.min(c1, m.c1); });
      return { rows, cols, master, covered, colW, rowH, hiddenC, hiddenR, used: { r1: Math.max(0, r1), c1: Math.max(0, c1), r2: used.r2, c2: used.c2 } };
    }

    function cellHtml(r, c, withId) {
      const key = `${r}:${c}`;
      if (model.covered.has(key)) return "";
      const cell = ws.getCell(r + 1, c + 1);
      const m = model.master.get(key);
      const text = cellText(cell);
      let v = cell.value;
      if (v && typeof v === "object" && "result" in v) v = v.result;
      const isNum = typeof v === "number" || v instanceof Date;
      let span = "";
      if (m) {
        let cs = 0, rs = 0;
        for (let x = m.c1; x <= m.c2; x++) if (!model.hiddenC[x]) cs++;
        for (let y = m.r1; y <= m.r2; y++) if (!model.hiddenR[y]) rs++;
        span = `${cs > 1 ? ` colspan="${cs}"` : ""}${rs > 1 ? ` rowspan="${rs}"` : ""}`;
      }
      return `<td${withId ? ` data-r="${r}" data-c="${c}"` : ""}${span} style="${cellStyle(cell, theme, isNum)}">${esc(text)}</td>`;
    }

    function show(i) {
      ws = sheets[i];
      model = buildModel(ws);
      sel = null;
      [...tabs.children].forEach((b, j) => b.classList.toggle("active", j === i));
      const head = [`<th class="ax-corner"></th>`];
      for (let c = 0; c < model.cols; c++) if (!model.hiddenC[c]) head.push(`<th class="ax-ch" data-c="${c}">${colName(c)}</th>`);
      const cols = [`<col style="width:42px">`];
      for (let c = 0; c < model.cols; c++) if (!model.hiddenC[c]) cols.push(`<col style="width:${model.colW[c]}px">`);
      const rows = [];
      for (let r = 0; r < model.rows; r++) {
        if (model.hiddenR[r]) continue;
        const tds = [];
        for (let c = 0; c < model.cols; c++) if (!model.hiddenC[c]) tds.push(cellHtml(r, c, true));
        rows.push(`<tr style="height:${model.rowH[r]}px"><th class="ax-rh" data-r="${r}">${r + 1}</th>${tds.join("")}</tr>`);
      }
      body.innerHTML = `
        <div class="ax-sheet">
          <table class="ax-grid"><colgroup>${cols.join("")}</colgroup><thead><tr>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>
          <div class="ax-range hidden"></div>
        </div>`;
      wireGrid();
      const pa = ws.pageSetup?.printArea ? parseRange(String(ws.pageSetup.printArea).split(",")[0]) : null;
      setSel(pa);
    }

    function setSel(s) {
      sel = s;
      const box = body.querySelector(".ax-range");
      if (!s) { box.classList.add("hidden"); onSelect(""); return; }
      // auf verbundene Zellen erweitern
      let changed = true;
      while (changed) {
        changed = false;
        model.master.forEach((m) => {
          const hit = m.r1 <= s.r2 && m.r2 >= s.r1 && m.c1 <= s.c2 && m.c2 >= s.c1;
          if (hit && (m.r1 < s.r1 || m.r2 > s.r2 || m.c1 < s.c1 || m.c2 > s.c2)) {
            s = { r1: Math.min(s.r1, m.r1), c1: Math.min(s.c1, m.c1), r2: Math.max(s.r2, m.r2), c2: Math.max(s.c2, m.c2) };
            changed = true;
          }
        });
      }
      sel = s;
      const sheetEl = body.querySelector(".ax-sheet");
      const base = sheetEl.getBoundingClientRect();
      const cellRect = (r, c) => {
        for (let rr = r; rr >= 0; rr--) {
          for (let cc = c; cc >= 0; cc--) {
            const td = sheetEl.querySelector(`td[data-r="${rr}"][data-c="${cc}"]`);
            if (td) return td.getBoundingClientRect();
          }
        }
        return null;
      };
      const firstVisible = (from, to, hidden) => { for (let i = from; i <= to; i++) if (!hidden[i]) return i; return from; };
      const lastVisible = (from, to, hidden) => { for (let i = to; i >= from; i--) if (!hidden[i]) return i; return to; };
      const a = cellRect(firstVisible(s.r1, s.r2, model.hiddenR), firstVisible(s.c1, s.c2, model.hiddenC));
      const b = cellRect(lastVisible(s.r1, s.r2, model.hiddenR), lastVisible(s.c1, s.c2, model.hiddenC));
      if (!a || !b) return;
      Object.assign(box.style, {
        left: a.left - base.left + "px", top: a.top - base.top + "px",
        width: Math.max(b.right, a.right) - a.left + "px", height: Math.max(b.bottom, a.bottom) - a.top + "px",
      });
      box.classList.remove("hidden");
      const ref = `${colName(s.c1)}${s.r1 + 1}${s.r1 === s.r2 && s.c1 === s.c2 ? "" : `:${colName(s.c2)}${s.r2 + 1}`}`;
      onSelect(`${ws.name}!${ref}`);
    }

    function wireGrid() {
      const grid = body.querySelector(".ax-grid");
      let anchor = null, dragging = false;
      const at = (e) => {
        const td = e.target.closest("td[data-r]");
        if (td) return { r: Number(td.dataset.r), c: Number(td.dataset.c), td };
        return null;
      };
      grid.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        const ch = e.target.closest(".ax-ch"), rh = e.target.closest(".ax-rh");
        if (ch) { const c = Number(ch.dataset.c); anchor = { r: 0, c, col: true }; dragging = true; setSel({ r1: 0, r2: model.rows - 1, c1: c, c2: c }); e.preventDefault(); return; }
        if (rh) { const r = Number(rh.dataset.r); anchor = { r, c: 0, row: true }; dragging = true; setSel({ r1: r, r2: r, c1: 0, c2: model.cols - 1 }); e.preventDefault(); return; }
        const p = at(e);
        if (!p) return;
        e.preventDefault();
        const m = model.master.get(`${p.r}:${p.c}`);
        if (e.shiftKey && sel && anchor) {
          setSel({ r1: Math.min(anchor.r, p.r), c1: Math.min(anchor.c, p.c), r2: Math.max(anchor.r, m ? m.r2 : p.r), c2: Math.max(anchor.c, m ? m.c2 : p.c) });
        } else {
          anchor = { r: p.r, c: p.c };
          setSel(m ? { ...m } : { r1: p.r, c1: p.c, r2: p.r, c2: p.c });
        }
        dragging = true;
      });
      grid.addEventListener("mousemove", (e) => {
        if (!dragging || !anchor) return;
        if (anchor.col) { const ch = e.target.closest("[data-c]"); if (ch) { const c = Number(ch.dataset.c); setSel({ r1: 0, r2: model.rows - 1, c1: Math.min(anchor.c, c), c2: Math.max(anchor.c, c) }); } return; }
        if (anchor.row) { const rh = e.target.closest("[data-r]"); if (rh) { const r = Number(rh.dataset.r); setSel({ r1: Math.min(anchor.r, r), r2: Math.max(anchor.r, r), c1: 0, c2: model.cols - 1 }); } return; }
        const p = at(e);
        if (p) setSel({ r1: Math.min(anchor.r, p.r), c1: Math.min(anchor.c, p.c), r2: Math.max(anchor.r, p.r), c2: Math.max(anchor.c, p.c) });
      });
      window.addEventListener("mouseup", () => { dragging = false; }, { once: false });
    }

    /** Bereich ohne Koepfe und Gitternetz zeichnen, wie beim Drucken. */
    async function shot(range) {
      if (!range && !sel) throw new Error("Kein Bereich gewählt.");
      const s = range || sel;
      const cols = [], rows = [];
      let w = 0;
      for (let c = s.c1; c <= s.c2; c++) if (!model.hiddenC[c]) { cols.push(`<col style="width:${model.colW[c]}px">`); w += model.colW[c]; }
      for (let r = s.r1; r <= s.r2; r++) {
        if (model.hiddenR[r]) continue;
        const tds = [];
        for (let c = s.c1; c <= s.c2; c++) if (!model.hiddenC[c]) tds.push(cellHtml(r, c, false));
        rows.push(`<tr style="height:${model.rowH[r]}px">${tds.join("")}</tr>`);
      }
      const host = document.createElement("div");
      host.className = "ax-render";
      host.innerHTML = `<table class="ax-print" style="width:${w}px"><colgroup>${cols.join("")}</colgroup><tbody>${rows.join("")}</tbody></table>`;
      document.body.appendChild(host);
      try {
        const table = host.firstElementChild;
        const canvas = await paint(table, SCALE);
        const ref = `${colName(s.c1)}${s.r1 + 1}:${colName(s.c2)}${s.r2 + 1}`;
        return await toResults(canvas, table.offsetWidth, table.offsetHeight, `${ws.name}!${ref}`);
      } finally {
        host.remove();
      }
    }

    show(0);
    return { shot, all: () => shot(model.used), allLabel: `<i class="fa-solid fa-table"></i> Ganzes Blatt` };
  }

  /* ------------------------------------------- Word, PDF, Bild (Seiten) --- */

  async function pageView(type, buf, body, onSelect) {
    body.innerHTML = `<div class="ax-pages"></div>`;
    const pagesEl = body.firstElementChild;
    let pages = [];

    if (type === "word") {
      await libs.word();
      const host = document.createElement("div");
      host.className = "ax-docx";
      pagesEl.appendChild(host);
      await window.docx.renderAsync(buf, host, host, { inWrapper: false, breakPages: true, ignoreLastRenderedPageBreak: false, experimental: true, useBase64URL: true, renderHeaders: true, renderFooters: true });
      pages = [...host.querySelectorAll("section.docx")];
      if (!pages.length) throw new Error("Das Dokument ist leer.");
    } else if (type === "pdf") {
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.js", location.href).href;
      const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
      const n = Math.min(pdf.numPages, 30);
      for (let i = 1; i <= n; i++) {
        const page = await pdf.getPage(i);
        const vp1 = page.getViewport({ scale: 96 / 72 });
        const vp = page.getViewport({ scale: (96 / 72) * SCALE });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        canvas.style.width = Math.round(vp1.width) + "px";
        canvas.style.height = Math.round(vp1.height) + "px";
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        const wrap = document.createElement("div");
        wrap.className = "ax-page";
        wrap.appendChild(canvas);
        pagesEl.appendChild(wrap);
        pages.push(wrap);
      }
    } else {
      const blob = new Blob([buf]);
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      const maxW = Math.min(img.naturalWidth, 900);
      img.style.width = maxW + "px";
      img.draggable = false;
      const wrap = document.createElement("div");
      wrap.className = "ax-page";
      wrap.appendChild(img);
      pagesEl.appendChild(wrap);
      pages.push(wrap);
    }

    pages.forEach((p) => { p.classList.add("ax-croppable"); p.insertAdjacentHTML("beforeend", `<div class="ax-crop hidden"><i></i><i></i><i></i><i></i></div>`); });
    let sel = null; // { page, x, y, w, h } in CSS-Pixeln relativ zur Seite

    function draw() {
      pages.forEach((p) => p.querySelector(".ax-crop").classList.add("hidden"));
      if (!sel) return onSelect("");
      const box = sel.page.querySelector(".ax-crop");
      Object.assign(box.style, { left: sel.x + "px", top: sel.y + "px", width: sel.w + "px", height: sel.h + "px" });
      box.classList.remove("hidden");
      const idx = pages.indexOf(sel.page) + 1;
      onSelect(`${pages.length > 1 ? `Seite ${idx} · ` : ""}${Math.round(sel.w)} × ${Math.round(sel.h)} px`);
    }

    // Ganze Seite vorwaehlen, wenn es nur eine gibt (Bild)
    if (type === "image") {
      const p = pages[0];
      sel = { page: p, x: 0, y: 0, w: p.offsetWidth, h: p.offsetHeight };
      draw();
    }

    let drag = null;
    pagesEl.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const page = e.target.closest(".ax-croppable");
      if (!page) return;
      e.preventDefault();
      const r = page.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const handle = e.target.closest(".ax-crop i");
      const inside = sel && sel.page === page && x > sel.x && x < sel.x + sel.w && y > sel.y && y < sel.y + sel.h;
      if (handle && sel) {
        const i = [...handle.parentNode.children].indexOf(handle);
        // gegenueberliegende Ecke bleibt fest
        const fx = i === 0 || i === 3 ? sel.x + sel.w : sel.x;
        const fy = i === 0 || i === 1 ? sel.y + sel.h : sel.y;
        drag = { page, mode: "new", ox: fx, oy: fy };
      } else if (inside) {
        drag = { page, mode: "move", dx: x - sel.x, dy: y - sel.y };
      } else {
        drag = { page, mode: "new", ox: x, oy: y };
        sel = { page, x, y, w: 0, h: 0 };
      }
    });
    const onMove = (e) => {
      if (!drag) return;
      const page = drag.page;
      const r = page.getBoundingClientRect();
      const W = page.offsetWidth, H = page.offsetHeight;
      const x = Math.max(0, Math.min(W, e.clientX - r.left)), y = Math.max(0, Math.min(H, e.clientY - r.top));
      if (drag.mode === "move") {
        sel = { ...sel, x: Math.max(0, Math.min(W - sel.w, x - drag.dx)), y: Math.max(0, Math.min(H - sel.h, y - drag.dy)) };
      } else {
        sel = { page, x: Math.min(drag.ox, x), y: Math.min(drag.oy, y), w: Math.abs(x - drag.ox), h: Math.abs(y - drag.oy) };
      }
      draw();
    };
    const onUp = () => {
      if (drag && sel && (sel.w < 8 || sel.h < 8)) { sel = null; draw(); }
      drag = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const observer = new MutationObserver(() => {
      if (!document.body.contains(body)) {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });

    async function shot() {
      if (!sel) throw new Error("Kein Ausschnitt gewählt.");
      const { page, x, y, w, h } = sel;
      let src, k;
      const media = page.querySelector("canvas, img");
      if (type === "pdf") { src = media; k = media.width / page.offsetWidth; }
      else if (type === "image") { src = media; k = media.naturalWidth / media.offsetWidth; }
      else {
        page.querySelector(".ax-crop").classList.add("hidden");
        try {
          src = await paint(page, SCALE);
        } finally {
          page.querySelector(".ax-crop").classList.remove("hidden");
        }
        k = src.width / page.offsetWidth;
      }
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * k));
      out.height = Math.max(1, Math.round(h * k));
      const ctx = out.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, Math.round(x * k), Math.round(y * k), out.width, out.height, 0, 0, out.width, out.height);
      const idx = pages.indexOf(page) + 1;
      return toResult(out, w, h, pages.length > 1 ? `Seite ${idx}` : "Ausschnitt");
    }

    async function all() {
      const out = [];
      const keep = sel;
      for (const page of pages) {
        sel = { page, x: 0, y: 0, w: page.offsetWidth, h: page.offsetHeight };
        out.push(await shot());
      }
      sel = keep;
      draw();
      return out.map((r, i) => ({ ...r, label: pages.length > 1 ? `Seite ${i + 1}` : "Ganze Seite" }));
    }

    return { shot, all, allLabel: type === "image" ? "" : `<i class="fa-regular fa-copy"></i> ${pages.length > 1 ? `Alle ${pages.length} Seiten` : "Ganze Seite"}` };
  }

  /* ------------------------------------------------------------ Zeichnen --- */

  /**
   * Zeichnet einen DOM-Teilbaum anhand seines Layouts auf ein Canvas: Flaechen,
   * Rahmen, Bilder und Text Wort fuer Wort an der Stelle, die der Browser
   * berechnet hat. Ohne Kopie in einem iframe, deshalb auch im abgeschotteten
   * Intranet-Rahmen (sandbox ohne allow-same-origin) moeglich.
   */
  async function paint(root, scale) {
    try { await document.fonts?.ready; } catch (_) { /* egal */ }
    const base = root.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(base.width * scale));
    canvas.height = Math.max(1, Math.round(base.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.translate(-base.left, -base.top);
    const clear = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);

    const clipOf = (el) => {
      for (let n = el; n && n !== root.parentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.overflow !== "visible" || cs.overflowX !== "visible") return n.getBoundingClientRect();
      }
      return null;
    };

    function text(node) {
      const s = node.textContent;
      if (!s || !s.trim()) return;
      const el = node.parentElement;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.color === "transparent") return;
      ctx.save();
      const clip = clipOf(el);
      if (clip) { ctx.beginPath(); ctx.rect(clip.left, clip.top, clip.width, clip.height); ctx.clip(); }
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = cs.color;
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText("Hg");
      const asc = m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8;
      const desc = m.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2;
      const under = /underline/.test(cs.textDecorationLine || cs.textDecoration);
      const range = document.createRange();
      const re = /\S+/g;
      let w;
      while ((w = re.exec(s))) {
        range.setStart(node, w.index);
        range.setEnd(node, w.index + w[0].length);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const r = rects[0];
        const y = r.top + (r.height - (asc + desc)) / 2 + asc;
        ctx.fillText(w[0], r.left, y);
        if (under) ctx.fillRect(r.left, y + desc * 0.35, r.width, Math.max(0.6, parseFloat(cs.fontSize) / 16));
      }
      ctx.restore();
    }

    function walk(el) {
      if (el.classList?.contains("ax-crop")) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      const r = el.getBoundingClientRect();
      if (!clear(cs.backgroundColor)) { ctx.fillStyle = cs.backgroundColor; ctx.fillRect(r.left, r.top, r.width, r.height); }
      if ((el.tagName === "IMG" && el.complete && el.naturalWidth) || el.tagName === "CANVAS") {
        try { ctx.drawImage(el, r.left, r.top, r.width, r.height); } catch (_) { /* Bild nicht lesbar */ }
      }
      for (const n of el.childNodes) {
        if (n.nodeType === 3) text(n);
        else if (n.nodeType === 1) walk(n);
      }
      for (const [side, x, y, w, h] of [
        ["Top", r.left, r.top, r.width, null], ["Bottom", r.left, r.bottom, r.width, null],
        ["Left", r.left, r.top, null, r.height], ["Right", r.right, r.top, null, r.height],
      ]) {
        const bw = parseFloat(cs[`border${side}Width`]);
        if (!bw || cs[`border${side}Style`] === "none" || clear(cs[`border${side}Color`])) continue;
        ctx.fillStyle = cs[`border${side}Color`];
        if (w !== null) ctx.fillRect(x, side === "Top" ? y : y - bw, w, bw);
        else ctx.fillRect(side === "Left" ? x : x - bw, y, bw, h);
      }
    }

    walk(root);
    return canvas;
  }

  /* ----------------------------------------------------------- Ausgabe --- */

  /** Canvas als PNG; zu grosse Bilder werden verkleinert (Grenze 4 MB je Bild). */
  async function toResult(canvas, w, h, label) {
    let c = canvas;
    for (let i = 0; i < 4; i++) {
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      if (blob.size <= 4 * 1024 * 1024 || c.width < 600) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", w: Math.round(w), h: Math.round(h), label };
      }
      const next = document.createElement("canvas");
      next.width = Math.round(c.width * 0.75);
      next.height = Math.round(c.height * 0.75);
      next.getContext("2d").drawImage(c, 0, 0, next.width, next.height);
      c = next;
    }
    throw new Error("Ausschnitt ist zu groß. Kleineren Bereich wählen.");
  }

  /** Sehr hohe Bereiche (ganzes Blatt) in Stuecke teilen, die je auf eine Anlagenseite passen. */
  async function toResults(canvas, w, h, label) {
    const MAX_RATIO = 1.15;           // Hoehe/Breite einer Anlagenseite
    if (h / w <= MAX_RATIO * 1.1) return [await toResult(canvas, w, h, label)];
    const sliceH = Math.floor(w * MAX_RATIO);
    const k = canvas.height / h;
    const parts = [];
    for (let y = 0, n = 1; y < h; y += sliceH, n++) {
      const hh = Math.min(sliceH, h - y);
      const c = document.createElement("canvas");
      c.width = canvas.width;
      c.height = Math.round(hh * k);
      c.getContext("2d").drawImage(canvas, 0, Math.round(y * k), c.width, c.height, 0, 0, c.width, c.height);
      parts.push(await toResult(c, w, hh, `${label} (${n})`));
    }
    return parts;
  }

  async function sha256(bytes) {
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
  }

  return { kind, capture, sha256, MIME, loadZip: libs.zip, _fmt: fmtNumber };
})();
