/**
 * ROOTS Rechnungen - sichtbares PDF nach Richards Vorlagen (Stand 10/2026).
 *
 * Erzeugt das Basis-PDF mit eingebetteten Schriften und sRGB-OutputIntent
 * (Voraussetzung fuer PDF/A-3). XML-Anhang und XMP setzt danach factur-x.
 * assets: { regular, bold, logo, icc } als Uint8Array.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("pdf-lib"), require("@pdf-lib/fontkit"), require("./einvoice.js"), require("./layout.js"));
  else root.RootsInvoicePdf = factory(root.PDFLib, root.fontkit, root.RootsEInvoice, root.RootsLayout);
})(typeof self !== "undefined" ? self : this, function (PDFLib, fontkit, E, LY) {
  "use strict";

  const { PDFDocument, rgb, PDFName, PDFString, PDFHexString, degrees } = PDFLib;

  const T = {
    de: {
      title: "RECHNUNG", number: "Rechnungsnummer:", project: "Projekt:", period: "Leistungszeitraum:",
      cost: "KSt:", po: "Bestellung:", contact: "Kontakt:", ref: "Ihre Referenz:",
      net: "Gesamtbetrag netto", tax: "zzgl. 19% Mehrwertsteuer", gross: "Gesamtbetrag brutto", total: "Rechnungsbetrag",
      due: "Zahlbar ohne Abzug bis", pay: "Wir bitten um die Überweisung des Gesamtbetrages auf folgendes Geschäftskonto:",
      thanks: "Wir bedanken uns für das entgegengebrachte Vertrauen und freuen uns auf die weitere Zusammenarbeit!",
      ceo: "Geschäftsführer", seat: "Sitz der Gesellschaft", taxno: "Steuernummer", vat: "USt-IdNr.", buyerVat: "USt-IdNr. Kunde:",
      annex: "Anlage", e: "E-Rechnung nach EN 16931 · Factur-X / ZUGFeRD, Profil EN 16931 · Datensatz eingebettet als factur-x.xml",
      draft: "ENTWURF",
    },
    en: {
      title: "INVOICE", number: "Invoice Number:", project: "Project:", period: "Delivery Period:",
      cost: "Cost Center:", po: "Purchase Order:", contact: "Ordered by:", ref: "Your Reference:",
      net: "total net", tax: "plus 19% VAT", gross: "total", total: "total",
      due: "Payable without deduction by", pay: "Please transfer the full amount to our bank account:",
      thanks: "We’d like to thank you for trusting ROOTS Brand Strategy Consultants!",
      ceo: "Managing Director", seat: "Registered office", taxno: "Tax number", vat: "VAT ID", buyerVat: "Customer VAT ID:",
      annex: "Appendix", e: "Electronic invoice according to EN 16931 · Factur-X / ZUGFeRD, profile EN 16931 · embedded as factur-x.xml",
      draft: "DRAFT",
    },
  };

  /** Leistungszeitraum wie in den Vorlagen: "01.09. - 30.09.2026", Jahr nur einmal bei gleichem Jahr. */
  function periodText(a, b, date) {
    const da = date(a), db = date(b);
    if (String(a).slice(0, 4) === String(b).slice(0, 4) && da.length === 10) return `${da.slice(0, 6)} - ${db}`;
    return `${da} - ${db}`;
  }

  const INK = rgb(0.06, 0.09, 0.16);
  const PH_COLOR = rgb(0.72, 0.76, 0.82);
  /** Graue Platzhalter fuer leere Felder, nur in der Live-Vorschau. */
  const PLACEHOLDER = {
    de: { number: "Rechnungsnummer", project: "Projekt", period: "Leistungszeitraum", cost_center: "Kostenstelle", po: "Bestellnummer", ordered_by: "Kontakt" },
    en: { number: "Invoice number", project: "Project", period: "Delivery period", cost_center: "Cost center", po: "Purchase order", ordered_by: "Ordered by" },
  };
  const MUTED = rgb(0.4, 0.45, 0.52);
  const LINE = rgb(0.85, 0.87, 0.9);

  function wrap(text, font, size, width) {
    const out = [];
    String(text || "").split(/\n/).forEach((para) => {
      let line = "";
      para.split(/\s+/).filter(Boolean).forEach((word) => {
        const next = line ? line + " " + word : word;
        if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
        else { out.push(line); line = word; }
      });
      out.push(line);
    });
    return out;
  }

  async function render(inv, seller, assets, opts = {}) {
    const lang = inv.lang === "en" ? "en" : "de";
    const L = T[lang];
    const tc = E.TAX_CASES[inv.tax_case] || E.TAX_CASES.S19;
    const t = E.totals(inv);
    const money = (c) => E.money(c, "de");
    const date = (iso) => E.fmtDate(iso, lang);

    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const R = await doc.embedFont(assets.regular, { subset: true });
    const B = await doc.embedFont(assets.bold, { subset: true });
    const logo = await doc.embedJpg(assets.logo);

    const W = 595.28, H = 841.89, ML = 68, MR = 56, CW = W - ML - MR;
    const pages = [];
    const layout = inv.layout && Array.isArray(inv.layout.elements) && inv.layout.elements.length ? inv.layout : null;
    const layoutImages = layout ? await LY.prepare(doc, layout) : {};
    const layoutCtx = (page) => ({ PDFLib, page, H, R, B, logo, images: layoutImages, inv, seller, L, tc, t, money, date, final: !!opts.final, wrap, countryName, periodText, regions: opts.regions || null, pageIndex: pages.length - 1, warnings: opts.warnings || null });

    function footer(page) {
      const s = 6.8;
      const parts1 = [`${seller.name}`, `${seller.street}`, `${seller.zip} ${seller.city}`, seller.web].filter(Boolean).join("  |  ");
      const parts2 = [`${L.ceo}: ${seller.ceo}`, `${L.seat}: ${seller.city}`, seller.court, seller.register].filter(Boolean).join("  |  ");
      const parts3 = [`${seller.bank}, IBAN: ${seller.iban}, BIC: ${seller.bic}`, seller.tax_number ? `${L.taxno} ${seller.tax_number}` : "", tc.category === "AE" && seller.vat_id ? `${L.vat} ${seller.vat_id}` : ""].filter(Boolean).join("  |  ");
      page.drawLine({ start: { x: ML, y: 74 }, end: { x: W - MR, y: 74 }, thickness: 0.5, color: LINE });
      [parts1, parts2, parts3].forEach((txt, i) => page.drawText(txt, { x: ML, y: 62 - i * 9.5, size: s, font: R, color: MUTED }));
    }

    function newPage(first) {
      const page = doc.addPage([W, H]);
      if (layout) {
        pages.push(page);
        LY.draw(layoutCtx(page), layout, !!first);
        pages.pop();
      } else {
        page.drawImage(logo, { x: W - MR - 58, y: H - 50 - 58, width: 58, height: 58 });
        footer(page);
      }
      if (!opts.final) {
        if (opts.preview) page.drawText(L.draft, { x: 150, y: 330, size: 84, font: B, color: rgb(0.58, 0.64, 0.72), opacity: 0.07, rotate: degrees(35) });
        else page.drawText(L.draft, { x: 120, y: 300, size: 110, font: B, color: rgb(0.86, 0.15, 0.15), opacity: 0.12, rotate: degrees(35) });
      }
      pages.push(page);
      return page;
    }

    /* Bereiche fuer die Vorschau: Schluessel -> Seite und Rechteck (Anteile der Seite). */
    const regions = opts.regions || null;
    const mark = (key, x1, yTop, x2, yBottom, size = 9.5) => {
      if (!regions) return;
      const top = H - yTop - size - 4;
      const bottom = H - yBottom + size * 0.45 + 4;
      regions[key] = { page: pages.length - 1, x: (x1 - 6) / W, y: top / H, w: (x2 - x1 + 12) / W, h: (bottom - top) / H };
    };

    /* ---------------- Seite 1 */
    let p = newPage(true);
    let y;
    const b = inv.buyer || {};
    const text = (s, x, y, o = {}) => p.drawText(String(s ?? ""), { x, y, size: o.size || 9.5, font: o.bold ? B : R, color: o.color || INK });
    const right = (s, xr, y, o = {}) => {
      const f = o.bold ? B : R, size = o.size || 9.5;
      p.drawText(String(s), { x: xr - f.widthOfTextAtSize(String(s), size), y, size, font: f, color: o.color || INK });
    };

    if (!layout) {
    text(`${seller.name} | ${seller.street} | ${seller.zip} ${seller.city}`, ML, H - 150, { size: 6.8, color: MUTED });
    y = H - 170;
    const buyerTop = y;
    [b.name, b.street2 ? b.street2 : null, b.street, `${b.zip || ""} ${b.city || ""}`.trim(), b.hide_country ? null : countryName(b.country, lang), b.email, b.vat_id && tc.category !== "O" ? (b.vat_print || `${lang === "en" ? "VAT" : "USt-IdNr."} ${b.vat_id}`) : null]
      .filter(Boolean).forEach((line, i) => { text(line, ML, y, { bold: i === 0 }); y -= 13; });
    mark("buyer", ML, buyerTop, ML + 260, y + 13);

    const dateY = Math.min(H - 250, y - 6);
    right(`${seller.city}, ${date(inv.issue_date)}`, W - MR, dateY);
    mark("issue_date", W - MR - 160, dateY, W - MR, dateY);
    const topY = Math.min(H - 300, y - 40);

    y = topY;
    text(L.title, ML, y, { size: 15, bold: true });
    y -= 26;
    const meta = [
      [L.number, inv.number, "number"],
      [L.project, inv.project, "project"],
      [L.period, periodText(inv.period_start, inv.period_end, date), "period"],
      [L.cost, inv.cost_center, "cost_center"],
      [L.po, inv.po, "po"],
      [L.contact, inv.ordered_by, "ordered_by"],
    ].filter((r) => opts.preview || String(r[1] || "").trim());
    meta.forEach(([k, v, key]) => {
      text(k, ML, y, { color: MUTED });
      const empty = !String(v || "").trim();
      const lines = wrap(empty ? PLACEHOLDER[lang][key] || "…" : v, k === L.number ? B : R, 9.5, CW - 120);
      lines.forEach((ln, i) => text(ln, ML + 120, y - i * 12.5, { bold: k === L.number && !empty, color: empty ? PH_COLOR : undefined }));
      mark(key, ML, y, W - MR, y - (lines.length - 1) * 12.5);
      y -= 12.5 * lines.length + 3;
    });

    y -= 18;
    const AX = ML + 92;
    (inv.lines || []).forEach((l, i) => {
      right(t.lines[i] ? money(t.lines[i]) : "- €", AX, y);
      const lines = wrap(l.label + (l.detail ? ` (${l.detail})` : ""), R, 9.5, CW - 110);
      lines.forEach((ln, j) => text(ln, AX + 16, y - j * 12.5));
      mark(`lines.${i}`, ML, y, W - MR, y - (lines.length - 1) * 12.5);
      y -= 12.5 * lines.length + 6;
    });
    p.drawLine({ start: { x: ML, y: y + 4 }, end: { x: AX + 200, y: y + 4 }, thickness: 0.5, color: LINE });
    y -= 12;
    const totalsTop = y;
    if (tc.category === "S") {
      right(money(t.net), AX, y); text(L.net, AX + 16, y); y -= 15;
      right(money(t.tax), AX, y); text(L.tax, AX + 16, y); y -= 15;
      right(money(t.gross), AX, y, { bold: true }); text(L.gross, AX + 16, y, { bold: true }); y -= 22;
    } else {
      right(money(t.gross), AX, y, { bold: true }); text(L.total, AX + 16, y, { bold: true }); y -= 16;
      wrap(`(${tc[lang]})`, R, 8.5, W - MR - AX - 16).forEach((ln) => { text(ln, AX + 16, y, { size: 8.5, color: MUTED }); y -= 11; });
      y -= 10;
    }

    mark("totals", ML, totalsTop, W - MR, y + 22);
    y -= 6;
    wrap(L.pay, R, 9.5, CW).forEach((ln) => { text(ln, ML, y); y -= 12.5; });
    y -= 3;
    text(seller.name, ML, y, { bold: true }); y -= 12.5;
    text(`${seller.bank}, IBAN: ${seller.iban}, BIC: ${seller.bic}`, ML, y); y -= 24;
    wrap(L.thanks, R, 9.5, CW).forEach((ln) => { text(ln, ML, y); y -= 12.5; });
    if (y < 90) throw new Error("Seite 1 läuft in die Fußzeile. Positionen kürzen oder in die Anlage verschieben.");
    }

    /* ---------------- Anlage */
    const a = inv.annex || {};
    const rows = (a.rows || []).filter((r) => String(r.label || "").trim() || String(r.amount || "").trim());
    const images = (a.images || []).filter((im) => im && im.sha);
    if (String(a.text || "").trim() || rows.length || images.length) {
      p = newPage();
      y = H - 150;
      text(`${L.annex}: ${a.title || ""}`.trim(), ML, y, { size: 12, bold: true });
      mark("annex.title", ML, y, W - MR, y, 12);
      y -= 26;
      const textTop = y;
      wrap(a.text, R, 9.5, CW).forEach((ln) => {
        if (y < 100) { p = newPage(); y = H - 150; }
        text(ln, ML, y); y -= 13;
      });
      if (String(a.text || "").trim()) mark("annex.text", ML, textTop, W - MR, Math.min(textTop, y + 13));
      if (rows.length) {
        y -= 8;
        rows.forEach((r) => {
          if (y < 100) { p = newPage(); y = H - 150; }
          const bold = !!r.bold;
          text(r.label, ML, y, { bold });
          mark(`annex.rows.${(a.rows || []).indexOf(r)}`, ML, y, W - MR, y);
          const c = E.toCents(r.amount);
          if (String(r.amount || "").trim()) right(Number.isFinite(c) ? money(c) : String(r.amount), W - MR, y, { bold });
          y -= 6;
          p.drawLine({ start: { x: ML, y }, end: { x: W - MR, y }, thickness: 0.4, color: LINE });
          y -= 11;
        });
      }
      /* Ausschnitte aus Excel, Word, PDF: volle Satzbreite hoechstens, nie hochskaliert */
      for (const im of images) {
        const idx = (a.images || []).indexOf(im);
        const bytes = opts.files && opts.files.get(im.sha);
        const natW = (Number(im.w) || 600) * 0.75, natH = (Number(im.h) || 300) * 0.75;   // CSS-Pixel -> pt
        const maxH = H - 150 - 100;
        let w = Math.min(CW, natW), h = (natH * w) / natW;
        if (h > maxH) { w = (w * maxH) / h; h = maxH; }
        const caption = String(im.caption || "").trim();
        const need = h + (caption ? 18 : 0) + 14;
        if (y - need < 100) { p = newPage(); y = H - 150; }
        y -= 6;
        if (bytes) {
          const img = bytes[0] === 0x89 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          p.drawImage(img, { x: ML, y: y - h, width: w, height: h });
        } else if (opts.final) {
          throw new Error(`Anlage-Bild ${idx + 1} fehlt.`);
        } else {
          p.drawRectangle({ x: ML, y: y - h, width: w, height: h, color: rgb(0.95, 0.96, 0.98) });
        }
        mark(`annex.images.${idx}`, ML, y - 9.5, ML + w, y - h + 4.3);
        y -= h;
        if (caption) {
          y -= 13;
          wrap(caption, R, 8.5, CW).forEach((ln, j) => { if (j < 3) { text(ln, ML, y, { size: 8.5, color: MUTED }); y -= 11; } });
          y += 11;
        }
        y -= 18;
      }
    }

    /* ---------------- PDF/A-Voraussetzungen */
    const title = `${lang === "en" ? "Invoice" : "Rechnung"} ${inv.number}`;
    doc.setTitle(title, { showInWindowTitleBar: true });
    doc.setAuthor(seller.name);
    doc.setSubject(`${title} · ${b.name || ""}`);
    doc.setCreator("ROOTS Rechnungen");
    doc.setProducer("ROOTS Rechnungen");
    doc.setLanguage(lang === "en" ? "en-GB" : "de-DE");
    const now = opts.now || new Date();
    doc.setCreationDate(now);
    doc.setModificationDate(now);

    const icc = doc.context.flateStream(assets.icc, { N: 3 });
    const iccRef = doc.context.register(icc);
    const intent = doc.context.obj({
      Type: "OutputIntent",
      S: "GTS_PDFA1",
      OutputConditionIdentifier: PDFString.of("sRGB"),
      Info: PDFString.of("sRGB IEC61966-2.1"),
      DestOutputProfile: iccRef,
    });
    doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([doc.context.register(intent)]));
    const id = PDFHexString.of(Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join(""));
    doc.context.trailerInfo.ID = doc.context.obj([id, id]);

    return doc.save({ useObjectStreams: false });
  }

  const COUNTRIES = {
    DE: ["Deutschland", "Germany"], FR: ["Frankreich", "France"], CH: ["Schweiz", "Switzerland"], AT: ["Österreich", "Austria"],
    NL: ["Niederlande", "Netherlands"], BE: ["Belgien", "Belgium"], IT: ["Italien", "Italy"], ES: ["Spanien", "Spain"],
    GB: ["Vereinigtes Königreich", "United Kingdom"], US: ["USA", "USA"], PL: ["Polen", "Poland"], DK: ["Dänemark", "Denmark"],
    LU: ["Luxemburg", "Luxembourg"], SE: ["Schweden", "Sweden"], CZ: ["Tschechien", "Czechia"],
  };
  function countryName(cc, lang) {
    const c = String(cc || "").toUpperCase();
    if (!c) return "";
    const n = COUNTRIES[c];
    return n ? n[lang === "en" ? 1 : 0] : c;
  }

  return { render, countryName, COUNTRIES, periodText };
});
