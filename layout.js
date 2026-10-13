/**
 * ROOTS Rechnungen - frei gestaltete Vorlagen.
 *
 * Ein Layout ist eine Liste von Elementen auf einer A4-Seite, Masse in mm:
 *   { id, type: "text"|"rect"|"line"|"image"|"block", x, y, w, h, z, repeat,
 *     text, block, src, style: { font, size, color, align, lineHeight,
 *     fill, stroke, strokeWidth, radius, opacity } }
 * Texte koennen Platzhalter wie {{nummer}} enthalten. Bausteine ("block")
 * setzen Inhalte mit variabler Laenge (Positionen, Summen, Adresse ...).
 * Das XML der E-Rechnung haengt nicht vom Layout ab; das Layout bestimmt nur
 * das sichtbare PDF. Pflichtbausteine prueft required().
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RootsLayout = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MM = 72 / 25.4;
  const PAGE = { w: 210, h: 297 };

  const BLOCKS = {
    title: { label: "Titel (RECHNUNG / INVOICE)", w: 80, h: 9, size: 15, font: "bold" },
    sender: { label: "Absenderzeile", w: 120, h: 4, size: 6.8, color: "#667386" },
    buyer: { label: "Kundenadresse", w: 85, h: 32, size: 9.5 },
    date: { label: "Ort und Datum", w: 60, h: 5, size: 9.5, align: "right" },
    meta: { label: "Rechnungsdaten", w: 160, h: 34, size: 9.5 },
    lines: { label: "Positionen", w: 160, h: 30, size: 9.5 },
    totals: { label: "Summen", w: 160, h: 22, size: 9.5 },
    taxnote: { label: "Steuerhinweis", w: 160, h: 10, size: 8.5, color: "#667386" },
    payment: { label: "Zahlungsangaben", w: 160, h: 24, size: 9.5 },
    thanks: { label: "Dankeszeile", w: 160, h: 9, size: 9.5 },
    footer: { label: "Firmenangaben (Fußzeile)", w: 166, h: 11, size: 6.8, color: "#667386" },
    logo: { label: "ROOTS-Logo", w: 20, h: 20 },
    enote: { label: "Hinweis E-Rechnung", w: 166, h: 3, size: 6, color: "#667386" },
  };

  /** Ohne diese Bausteine fehlen Pflichtangaben nach § 14 UStG im PDF. */
  const REQUIRED = ["buyer", "meta", "lines", "totals", "payment", "footer"];

  const PLACEHOLDERS = [
    ["nummer", "Rechnungsnummer"], ["datum", "Rechnungsdatum"], ["faellig", "Fällig am"],
    ["leistung_von", "Leistung von"], ["leistung_bis", "Leistung bis"], ["projekt", "Projekt"],
    ["bestellung", "Bestellnummer"], ["kostenstelle", "Kostenstelle"], ["referenz", "Käuferreferenz"], ["kontakt", "Kontakt"],
    ["kunde", "Kunde"], ["kunde_ustid", "USt-IdNr. Kunde"],
    ["netto", "Netto"], ["ust", "Umsatzsteuer"], ["brutto", "Brutto"],
    ["firma", "Firma"], ["firma_adresse", "Firmenadresse"], ["iban", "IBAN"], ["bic", "BIC"], ["bank", "Bank"],
    ["steuernummer", "Steuernummer"], ["ustid", "USt-IdNr."], ["handelsregister", "Handelsregister"], ["geschaeftsfuehrer", "Geschäftsführer"],
    ["web", "Website"], ["email", "E-Mail"],
  ];

  /** Welcher Formular-Bereich zu einem Platzhalter gehoert (fuer die Vorschau-Hervorhebung). */
  const PH_REGION = { nummer: "number", datum: "issue_date", faellig: "due_date", leistung_von: "period", leistung_bis: "period", projekt: "project", bestellung: "po", kostenstelle: "cost_center", referenz: "buyer_reference", kontakt: "ordered_by", kunde: "buyer", kunde_ustid: "buyer", netto: "totals", ust: "totals", brutto: "totals" };

  let seq = 0;
  const uid = () => "e" + Date.now().toString(36) + (seq++).toString(36);

  function hex(c, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ""));
    if (!m) return fallback;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** Standardlayout, nachgebaut nach Richards Vorlagen. Ausgangspunkt fuer eigene Entwuerfe. */
  function defaultLayout() {
    const el = (o) => ({ id: uid(), z: 0, repeat: false, style: {}, ...o });
    return {
      version: 1,
      elements: [
        el({ type: "block", block: "logo", x: 169.8, y: 17.6, w: 20.5, h: 20.5, repeat: true }),
        el({ type: "block", block: "sender", x: 24, y: 50.6, w: 140, h: 4, style: { size: 6.8, color: "#667386" } }),
        el({ type: "block", block: "buyer", x: 24, y: 57.3, w: 90, h: 30 }),
        el({ type: "block", block: "date", x: 130, y: 85, w: 60.2, h: 5, style: { align: "right" } }),
        el({ type: "block", block: "title", x: 24, y: 100, w: 80, h: 8, style: { size: 15, font: "bold" } }),
        el({ type: "block", block: "meta", x: 24, y: 111, w: 166, h: 34 }),
        el({ type: "block", block: "lines", x: 24, y: 150, w: 166, h: 26 }),
        el({ type: "block", block: "totals", x: 24, y: 180, w: 166, h: 24 }),
        el({ type: "block", block: "payment", x: 24, y: 208, w: 166, h: 24 }),
        el({ type: "block", block: "thanks", x: 24, y: 236, w: 166, h: 9 }),
        el({ type: "line", x: 24, y: 270.8, w: 166, h: 0, repeat: true, style: { stroke: "#d9dee6", strokeWidth: 0.5 } }),
        el({ type: "block", block: "footer", x: 24, y: 273.2, w: 166, h: 11, repeat: true, style: { size: 6.8, color: "#667386" } }),
      ],
    };
  }

  function emptyLayout() {
    return { version: 1, elements: [] };
  }

  function required(layout) {
    const have = new Set((layout?.elements || []).filter((e) => e.type === "block").map((e) => e.block));
    return REQUIRED.filter((b) => !have.has(b)).map((b) => BLOCKS[b].label);
  }

  function newElement(type, block) {
    const base = { id: uid(), type, x: 30, y: 40, w: 60, h: 12, z: 0, repeat: false, style: {} };
    if (type === "text") return { ...base, text: "Text", style: { size: 10, color: "#0f172a", font: "regular", align: "left" } };
    if (type === "rect") return { ...base, w: 60, h: 30, style: { fill: "#eff6ff", stroke: "", strokeWidth: 0, radius: 2, opacity: 1 } };
    if (type === "line") return { ...base, w: 80, h: 0, style: { stroke: "#0f172a", strokeWidth: 0.75 } };
    if (type === "image") return { ...base, w: 40, h: 20 };
    const def = BLOCKS[block] || {};
    return { ...base, type: "block", block, w: def.w || 60, h: def.h || 10, style: { size: def.size || 9.5, font: def.font || "regular", color: def.color || "#0f172a", align: def.align || "left" } };
  }

  /* --------------------------------------------------------------- Werte --- */

  function values(ctx) {
    const { inv, seller, t, money, date, L } = ctx;
    const b = inv.buyer || {};
    return {
      nummer: inv.number, datum: date(inv.issue_date), faellig: date(inv.due_date),
      leistung_von: date(inv.period_start), leistung_bis: date(inv.period_end), projekt: inv.project,
      bestellung: inv.po, kostenstelle: inv.cost_center, referenz: inv.buyer_reference, kontakt: inv.ordered_by,
      kunde: b.name, kunde_ustid: b.vat_id,
      netto: money(t.net), ust: money(t.tax), brutto: money(t.gross),
      firma: seller.name, firma_adresse: `${seller.street}, ${seller.zip} ${seller.city}`, iban: seller.iban, bic: seller.bic, bank: seller.bank,
      steuernummer: seller.tax_number, ustid: seller.vat_id, handelsregister: `${seller.court || ""} ${seller.register || ""}`.trim(),
      geschaeftsfuehrer: seller.ceo, web: seller.web, email: seller.email, titel: L.title,
    };
  }

  function fill(text, vals) {
    return String(text || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => (vals[k] == null ? "" : String(vals[k])));
  }

  /* ---------------------------------------------------------- Bilder etc --- */

  async function prepare(doc, layout) {
    const images = {};
    for (const e of layout?.elements || []) {
      if (e.type !== "image" || !e.src || images[e.src]) continue;
      const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(e.src);
      if (!m) continue;
      const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      images[e.src] = m[1] === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    }
    return images;
  }

  /* ------------------------------------------------------------- Zeichnen --- */

  /**
   * Zeichnet die Elemente einer Seite.
   * ctx: { PDFLib, page, H, R, B, logo, images, inv, seller, L, tc, t, money, date,
   *        final, wrap, regions, pageIndex, warnings }
   */
  function draw(ctx, layout, first) {
    const { PDFLib, page, H, R, B, wrap } = ctx;
    const { rgb } = PDFLib;
    const vals = values(ctx);
    const elements = [...(layout.elements || [])].filter((e) => first || e.repeat).sort((a, b) => (a.z || 0) - (b.z || 0));

    for (const e of elements) {
      const s = e.style || {};
      const x = e.x * MM, w = e.w * MM, h = e.h * MM;
      const top = H - e.y * MM;
      const font = s.font === "bold" ? B : R;
      const size = Number(s.size) || 9.5;
      const lh = size * (Number(s.lineHeight) || 1.32);
      const color = rgb(...hex(s.color, [0.06, 0.09, 0.16]));
      const mark = (key, y0 = e.y, hh = e.h) => {
        if (!ctx.regions || !key) return;
        ctx.regions[key] = { page: ctx.pageIndex, x: (e.x - 1.5) / PAGE.w, y: (y0 - 1.5) / PAGE.h, w: (e.w + 3) / PAGE.w, h: (hh + 3) / PAGE.h };
      };

      if (e.type === "rect") {
        const fillC = hex(s.fill, null), strokeC = hex(s.stroke, null);
        const r = Math.min((Number(s.radius) || 0) * MM, w / 2, h / 2);
        const opts = { opacity: s.opacity ?? 1, borderOpacity: s.opacity ?? 1 };
        if (fillC) opts.color = rgb(...fillC);
        if (strokeC && Number(s.strokeWidth) > 0) { opts.borderColor = rgb(...strokeC); opts.borderWidth = Number(s.strokeWidth); }
        if (!fillC && !opts.borderColor) continue;
        if (r > 0) {
          const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
          page.drawSvgPath(path, { x, y: top, ...opts });
        } else {
          page.drawRectangle({ x, y: top - h, width: w, height: h, ...opts });
        }
        continue;
      }

      if (e.type === "line") {
        const c = hex(s.stroke, [0.06, 0.09, 0.16]);
        page.drawLine({ start: { x, y: top }, end: { x: x + w, y: top - h }, thickness: Number(s.strokeWidth) || 0.75, color: rgb(...c), opacity: s.opacity ?? 1 });
        continue;
      }

      if (e.type === "image") {
        const img = ctx.images[e.src];
        if (!img) continue;
        const sc = Math.min(w / img.width, h / img.height);
        page.drawImage(img, { x: x + (w - img.width * sc) / 2, y: top - h + (h - img.height * sc) / 2, width: img.width * sc, height: img.height * sc, opacity: s.opacity ?? 1 });
        continue;
      }

      /* Text und Bausteine: Zeilen sammeln, dann setzen */
      const rows = []; // { text, bold, right, muted, key, size }
      const push = (text, o = {}) => wrap(String(text ?? ""), o.bold ? B : font, o.size || size, o.wrapW || w).forEach((ln, i) => rows.push({ text: ln, ...o, first: i === 0 }));

      if (e.type === "text") {
        push(fill(e.text, vals));
        const keys = [...String(e.text || "").matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => PH_REGION[m[1]]).filter(Boolean);
        if (keys.length) keys.forEach((k) => mark(k));
      } else if (e.type === "block") {
        drawBlock(e, ctx, vals, { x, w, top, size, lh, font, color, mark, push, rows });
        if (e.block === "logo" || rows.special) continue;
      }

      let y = top - size * 0.95;
      for (const r of rows) {
        const f = r.bold ? B : font;
        const sz = r.size || size;
        const c = r.muted ? rgb(0.4, 0.45, 0.52) : color;
        if (r.amount !== undefined) {
          const aw = f.widthOfTextAtSize(r.amount, sz);
          page.drawText(r.amount, { x: x + r.amountX - aw, y, size: sz, font: f, color: c });
        }
        const tx = r.indent ? x + r.indent : x;
        const tw = f.widthOfTextAtSize(r.text, sz);
        const avail = (r.wrapW || w);
        const ax = s.align === "right" ? x + w - tw : s.align === "center" ? x + (w - tw) / 2 : tx;
        if (r.label !== undefined) page.drawText(r.label, { x, y, size: sz, font: R, color: rgb(0.4, 0.45, 0.52) });
        page.drawText(r.text, { x: r.amount !== undefined || r.label !== undefined ? tx : ax, y, size: sz, font: f, color: c });
        y -= (r.gap ?? lh * (sz / size));
        void avail;
      }
      const used = rows.length ? top - y - (rows[rows.length - 1].gap ?? lh) + size * 0.3 : 0;
      if (used > h + 1 && ctx.warnings) ctx.warnings.push(`${e.type === "block" ? BLOCKS[e.block]?.label : "Textfeld"} läuft über den Rahmen`);
    }
  }

  function drawBlock(e, ctx, vals, g) {
    const { inv, seller, L, tc, t, money, date, page, R, B, logo, H } = ctx;
    const b = inv.buyer || {};
    const lang = inv.lang === "en" ? "en" : "de";
    const { x, w, top, size, lh, push, rows, mark } = g;
    const mmY = (yPt) => (H - yPt) / MM;

    switch (e.block) {
      case "logo": {
        const sc = Math.min(w / logo.width, (e.h * MM) / logo.height);
        page.drawImage(logo, { x: x + (w - logo.width * sc) / 2, y: top - e.h * MM, width: logo.width * sc, height: logo.height * sc });
        return;
      }
      case "title": push(L.title, { bold: true }); return;
      case "sender": push(`${seller.name} | ${seller.street} | ${seller.zip} ${seller.city}`); return;
      case "date": push(`${seller.city}, ${date(inv.issue_date)}`); mark("issue_date"); return;
      case "buyer": {
        [b.name, b.street2, b.street, `${b.zip || ""} ${b.city || ""}`.trim(), ctx.countryName(b.country, lang), b.email, b.vat_id && tc.category !== "O" ? `${lang === "en" ? "VAT" : "USt-IdNr."} ${b.vat_id}` : null]
          .filter(Boolean).forEach((ln, i) => push(ln, { bold: i === 0 }));
        mark("buyer");
        return;
      }
      case "meta": {
        const labelW = Math.min(w * 0.36, 120);
        const meta = [
          [L.number, inv.number, "number", true], [L.project, inv.project, "project"],
          [L.period, `${date(inv.period_start)} - ${date(inv.period_end)}`, "period"],
          [L.cost, inv.cost_center, "cost_center"], [L.po, inv.po, "po"],
          [L.contact, inv.ordered_by, "ordered_by"],
        ].filter((r) => String(r[1] || "").trim());
        let y = top;
        meta.forEach(([label, value, key, bold]) => {
          const lines = ctx.wrap(String(value), bold ? B : R, size, w - labelW);
          lines.forEach((ln, i) => rows.push({ text: ln, label: i === 0 ? label : undefined, indent: labelW, bold, wrapW: w - labelW }));
          const hMm = (lines.length * lh) / MM;
          if (ctx.regions) ctx.regions[key] = { page: ctx.pageIndex, x: (e.x - 1.5) / 210, y: (mmY(y) - 1.5) / 297, w: (e.w + 3) / 210, h: (hMm + 3) / 297 };
          y -= lines.length * lh;
          rows[rows.length - 1].gap = lh + size * 0.3;
          y -= size * 0.3;
        });
        return;
      }
      case "lines": {
        const amountX = Math.min(w * 0.24, 92);
        let y = top;
        (inv.lines || []).forEach((l, i) => {
          const lines = ctx.wrap(l.label + (l.detail ? ` (${l.detail})` : ""), R, size, w - amountX - 16);
          lines.forEach((ln, j) => rows.push({ text: ln, indent: amountX + 16, amount: j === 0 ? (t.lines[i] ? money(t.lines[i]) : "- €") : undefined, amountX, wrapW: w - amountX - 16 }));
          if (ctx.regions) ctx.regions[`lines.${i}`] = { page: ctx.pageIndex, x: (e.x - 1.5) / 210, y: (mmY(y) - 1.5) / 297, w: (e.w + 3) / 210, h: ((lines.length * lh) / MM + 3) / 297 };
          y -= lines.length * lh + size * 0.6;
          rows[rows.length - 1].gap = lh + size * 0.6;
        });
        return;
      }
      case "totals": {
        const amountX = Math.min(w * 0.24, 92);
        const row = (amount, text, bold) => rows.push({ text, amount, amountX, indent: amountX + 16, bold, gap: size * 1.6 });
        if (tc.category === "S") {
          row(money(t.net), L.net); row(money(t.tax), L.tax); row(money(t.gross), L.gross, true);
        } else {
          row(money(t.gross), L.total, true);
          ctx.wrap(`(${tc[lang]})`, R, size * 0.9, w - amountX - 16).forEach((ln) => rows.push({ text: ln, indent: amountX + 16, muted: true, size: size * 0.9, wrapW: w - amountX - 16 }));
        }
        mark("totals");
        return;
      }
      case "taxnote":
        if (tc.category !== "S") push(`(${tc[lang]})`, { muted: true });
        mark("totals");
        return;
      case "payment":
        push(L.pay);
        push(seller.name, { bold: true });
        push(`${seller.bank}, IBAN: ${seller.iban}, BIC: ${seller.bic}`);
        mark("due_date");
        return;
      case "thanks": push(L.thanks); return;
      case "footer": {
        const p1 = [seller.name, seller.street, `${seller.zip} ${seller.city}`, seller.web].filter(Boolean).join("  |  ");
        const p2 = [`${L.ceo}: ${seller.ceo}`, `${L.seat}: ${seller.city}`, seller.court, seller.register].filter(Boolean).join("  |  ");
        const p3 = [`${seller.bank}, IBAN: ${seller.iban}, BIC: ${seller.bic}`, seller.tax_number ? `${L.taxno} ${seller.tax_number}` : "", seller.vat_id ? `${L.vat} ${seller.vat_id}` : ""].filter(Boolean).join("  |  ");
        [p1, p2, p3].forEach((p) => push(p));
        return;
      }
      case "enote": if (ctx.final) push(L.e); return;
      default: return;
    }
  }

  return { MM, PAGE, BLOCKS, REQUIRED, PLACEHOLDERS, defaultLayout, emptyLayout, newElement, required, prepare, draw, fill, values, hex };
});
