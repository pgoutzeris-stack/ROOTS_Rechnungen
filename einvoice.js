/**
 * ROOTS Rechnungen - E-Rechnung nach EN 16931 (Factur-X / ZUGFeRD, Profil EN 16931).
 *
 * Baut aus einem Rechnungsobjekt das CII-XML und prueft es vorab gegen die
 * Geschaeftsregeln, die im Formular sichtbar werden sollen. Die verbindliche
 * Pruefung ist danach der offizielle Schematron (schematron.js) und das XSD
 * (factur-x im Browser, facturx.js). Laeuft im Browser und in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RootsEInvoice = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PROFILE = "urn:cen.eu:en16931:2017";

  /** Steuerfaelle, die ROOTS heute fakturiert. */
  const TAX_CASES = {
    S19: {
      label: "Inland · 19 % USt",
      category: "S",
      rate: 19,
      de: "zzgl. 19% Mehrwertsteuer",
      en: "plus 19% VAT",
    },
    AE: {
      label: "EU · Reverse Charge (§ 13b UStG)",
      category: "AE",
      rate: 0,
      reasonCode: "VATEX-EU-AE",
      de: "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge) gemäß Art. 194, 196 MwStSystRL.",
      en: "Reverse Charge - According to Article 194, 196 of Council Directive 2006/112/EEC, VAT liability rests with the service recipient.",
    },
    O: {
      label: "Drittland · im Inland nicht steuerbar (§ 3a Abs. 2 UStG)",
      category: "O",
      rate: null,
      reasonCode: "VATEX-EU-O",
      de: "Nicht im Inland steuerbare sonstige Leistung gemäß § 3a Abs. 2 UStG. Steuerschuldnerschaft des Leistungsempfängers / Reverse Charge.",
      en: "Not taxable in Germany according to Section 3a (2) German VAT Act. VAT liability rests with the service recipient.",
    },
  };

  const EU = ["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"];

  /* ------------------------------------------------------------ Betraege --- */

  /** "1.234,56" / "1234.56" / 1234.56 -> Cent als Ganzzahl. */
  function toCents(value) {
    if (typeof value === "number") return Math.round(value * 100);
    let s = String(value ?? "").trim().replace(/[€\s]/g, "");
    if (!s) return 0;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  }

  const dec = (cents) => {
    const neg = cents < 0;
    const a = Math.abs(cents);
    return (neg ? "-" : "") + Math.floor(a / 100) + "." + String(a % 100).padStart(2, "0");
  };

  function money(cents, lang) {
    const n = cents / 100;
    return n.toLocaleString(lang === "en" ? "en-GB" : "de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }

  /** Summen exakt wie BR-CO-10 bis BR-CO-17 sie verlangen. */
  function totals(inv) {
    const tc = TAX_CASES[inv.tax_case] || TAX_CASES.S19;
    const lines = (inv.lines || []).map((l) => toCents(l.amount));
    const net = lines.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const tax = tc.rate ? Math.round((net * tc.rate) / 100) : 0;
    return { lines, net, tax, gross: net + tax, rate: tc.rate, category: tc.category };
  }

  /* ---------------------------------------------------------------- XML --- */

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ymd = (iso) => String(iso || "").replace(/-/g, "");
  const tag = (name, value, attrs = "") => (value === undefined || value === null || value === "" ? "" : `<${name}${attrs}>${esc(value)}</${name}>`);
  const compact = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();

  function addressXml(p) {
    return "<ram:PostalTradeAddress>" +
      tag("ram:PostcodeCode", p.zip) +
      tag("ram:LineOne", p.street) +
      tag("ram:LineTwo", p.street2) +
      tag("ram:CityName", p.city) +
      tag("ram:CountryID", (p.country || "").toUpperCase()) +
      "</ram:PostalTradeAddress>";
  }

  /** BT-125 erlaubt nur diese MIME-Typen (EN 16931, BR-CL-24). Word bleibt nur im PDF. */
  const XML_ATTACH_MIME = ["application/pdf", "image/png", "image/jpeg", "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.oasis.opendocument.spreadsheet"];

  /** attachments: [{ name, mime, b64 }] als BG-24 (Zusatzdokumente) ins XML. */
  function buildXml(inv, seller, attachments) {
    const tc = TAX_CASES[inv.tax_case] || TAX_CASES.S19;
    const t = totals(inv);
    const b = inv.buyer || {};
    const lang = inv.lang === "en" ? "en" : "de";
    const sellerVat = tc.category === "O" ? "" : compact(seller.vat_id);

    const notes = [];
    if (inv.project) notes.push({ text: (lang === "en" ? "Project: " : "Projekt: ") + inv.project });
    if (inv.cost_center) notes.push({ text: "KSt: " + inv.cost_center });
    if (inv.ordered_by) notes.push({ text: (lang === "en" ? "Ordered by: " : "Kontakt: ") + inv.ordered_by });
    if (inv.note) notes.push({ text: inv.note });
    notes.push({
      code: "REG",
      text: `${seller.name} · ${seller.street} · ${seller.zip} ${seller.city} · Geschäftsführer: ${seller.ceo} · Sitz der Gesellschaft: ${seller.city} · ${seller.court} ${seller.register}`,
    });

    const lineXml = (inv.lines || []).map((l, i) => {
      const c = t.lines[i];
      return "<ram:IncludedSupplyChainTradeLineItem>" +
        `<ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>` +
        "<ram:SpecifiedTradeProduct>" + tag("ram:Name", l.label) + tag("ram:Description", l.detail) + "</ram:SpecifiedTradeProduct>" +
        `<ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${dec(c)}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>` +
        '<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>' +
        "<ram:SpecifiedLineTradeSettlement>" +
        `<ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${tc.category}</ram:CategoryCode>` +
        (tc.rate === null ? "" : `<ram:RateApplicablePercent>${tc.rate}</ram:RateApplicablePercent>`) +
        "</ram:ApplicableTradeTax>" +
        `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${dec(c)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>` +
        "</ram:SpecifiedLineTradeSettlement>" +
        "</ram:IncludedSupplyChainTradeLineItem>";
    }).join("");

    const sellerXml = "<ram:SellerTradeParty>" +
      tag("ram:Name", seller.name) +
      "<ram:SpecifiedLegalOrganization>" + tag("ram:ID", `${seller.register}`.trim()) + tag("ram:TradingBusinessName", seller.trading_name) + "</ram:SpecifiedLegalOrganization>" +
      (seller.contact_name || seller.phone || seller.email
        ? "<ram:DefinedTradeContact>" + tag("ram:PersonName", seller.contact_name) +
          (seller.phone ? `<ram:TelephoneUniversalCommunication>${tag("ram:CompleteNumber", seller.phone)}</ram:TelephoneUniversalCommunication>` : "") +
          (seller.email ? `<ram:EmailURIUniversalCommunication>${tag("ram:URIID", seller.email)}</ram:EmailURIUniversalCommunication>` : "") +
          "</ram:DefinedTradeContact>"
        : "") +
      addressXml(seller) +
      (seller.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(seller.email)}</ram:URIID></ram:URIUniversalCommunication>` : "") +
      (seller.tax_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(seller.tax_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : "") +
      (sellerVat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(sellerVat)}</ram:ID></ram:SpecifiedTaxRegistration>` : "") +
      "</ram:SellerTradeParty>";

    const buyerVat = tc.category === "O" ? "" : compact(b.vat_id);
    const buyerXml = "<ram:BuyerTradeParty>" +
      tag("ram:Name", b.name) +
      (b.contact ? `<ram:DefinedTradeContact>${tag("ram:PersonName", b.contact)}</ram:DefinedTradeContact>` : "") +
      addressXml(b) +
      (b.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(b.email)}</ram:URIID></ram:URIUniversalCommunication>` : "") +
      (buyerVat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(buyerVat)}</ram:ID></ram:SpecifiedTaxRegistration>` : "") +
      "</ram:BuyerTradeParty>";

    const reason = tc.reasonCode ? tc[lang] : "";
    const taxXml = "<ram:ApplicableTradeTax>" +
      `<ram:CalculatedAmount>${dec(t.tax)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>` +
      tag("ram:ExemptionReason", reason) +
      `<ram:BasisAmount>${dec(t.net)}</ram:BasisAmount><ram:CategoryCode>${tc.category}</ram:CategoryCode>` +
      tag("ram:ExemptionReasonCode", tc.reasonCode) +
      (tc.rate === null ? "" : `<ram:RateApplicablePercent>${tc.rate}</ram:RateApplicablePercent>`) +
      "</ram:ApplicableTradeTax>";

    const terms = lang === "en"
      ? `Payable without deduction by ${fmtDate(inv.due_date, "en")}.`
      : `Zahlbar ohne Abzug bis ${fmtDate(inv.due_date, "de")}.`;

    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">' +
      `<rsm:ExchangedDocumentContext><ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>${PROFILE}</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter></rsm:ExchangedDocumentContext>` +
      "<rsm:ExchangedDocument>" + tag("ram:ID", inv.number) + "<ram:TypeCode>380</ram:TypeCode>" +
      `<ram:IssueDateTime><udt:DateTimeString format="102">${ymd(inv.issue_date)}</udt:DateTimeString></ram:IssueDateTime>` +
      notes.map((n) => "<ram:IncludedNote>" + tag("ram:Content", n.text) + tag("ram:SubjectCode", n.code) + "</ram:IncludedNote>").join("") +
      "</rsm:ExchangedDocument>" +
      "<rsm:SupplyChainTradeTransaction>" + lineXml +
      "<ram:ApplicableHeaderTradeAgreement>" + tag("ram:BuyerReference", inv.buyer_reference) + sellerXml + buyerXml +
      (inv.po ? `<ram:BuyerOrderReferencedDocument>${tag("ram:IssuerAssignedID", inv.po)}</ram:BuyerOrderReferencedDocument>` : "") +
      (attachments || []).filter((a) => XML_ATTACH_MIME.includes(a.mime)).map((a, i) =>
        "<ram:AdditionalReferencedDocument>" + tag("ram:IssuerAssignedID", `Anlage ${i + 1}`) + "<ram:TypeCode>916</ram:TypeCode>" + tag("ram:Name", a.name) +
        `<ram:AttachmentBinaryObject mimeCode="${esc(a.mime)}" filename="${esc(a.name)}">${a.b64}</ram:AttachmentBinaryObject></ram:AdditionalReferencedDocument>`).join("") +
      "</ram:ApplicableHeaderTradeAgreement>" +
      "<ram:ApplicableHeaderTradeDelivery/>" +
      "<ram:ApplicableHeaderTradeSettlement>" +
      tag("ram:PaymentReference", inv.number) +
      "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>" +
      '<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode>' +
      `<ram:PayeePartyCreditorFinancialAccount>${tag("ram:IBANID", compact(seller.iban))}${tag("ram:AccountName", seller.name)}</ram:PayeePartyCreditorFinancialAccount>` +
      (seller.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution>${tag("ram:BICID", compact(seller.bic))}</ram:PayeeSpecifiedCreditorFinancialInstitution>` : "") +
      "</ram:SpecifiedTradeSettlementPaymentMeans>" +
      taxXml +
      "<ram:BillingSpecifiedPeriod>" +
      `<ram:StartDateTime><udt:DateTimeString format="102">${ymd(inv.period_start)}</udt:DateTimeString></ram:StartDateTime>` +
      `<ram:EndDateTime><udt:DateTimeString format="102">${ymd(inv.period_end)}</udt:DateTimeString></ram:EndDateTime>` +
      "</ram:BillingSpecifiedPeriod>" +
      "<ram:SpecifiedTradePaymentTerms>" + tag("ram:Description", terms) +
      `<ram:DueDateDateTime><udt:DateTimeString format="102">${ymd(inv.due_date)}</udt:DateTimeString></ram:DueDateDateTime>` +
      "</ram:SpecifiedTradePaymentTerms>" +
      "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
      `<ram:LineTotalAmount>${dec(t.net)}</ram:LineTotalAmount>` +
      `<ram:TaxBasisTotalAmount>${dec(t.net)}</ram:TaxBasisTotalAmount>` +
      `<ram:TaxTotalAmount currencyID="EUR">${dec(t.tax)}</ram:TaxTotalAmount>` +
      `<ram:GrandTotalAmount>${dec(t.gross)}</ram:GrandTotalAmount>` +
      `<ram:DuePayableAmount>${dec(t.gross)}</ram:DuePayableAmount>` +
      "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
      "</ram:ApplicableHeaderTradeSettlement>" +
      "</rsm:SupplyChainTradeTransaction>" +
      "</rsm:CrossIndustryInvoice>";
  }

  function fmtDate(iso, lang) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    return lang === "en" ? `${m[3]}.${m[2]}.${m[1]}` : `${m[3]}.${m[2]}.${m[1]}`;
  }

  /* -------------------------------------------------------------- Regeln --- */

  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

  function ibanOk(iban) {
    const s = compact(iban);
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
    let mod = 0;
    for (const ch of r) mod = (mod * 10 + Number(ch)) % 97;
    return mod === 1;
  }

  const vatOk = (v) => /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(compact(v));

  /**
   * Vorpruefung mit verstaendlichen Meldungen. Jede Meldung nennt die Regel aus
   * EN 16931 bzw. § 14 UStG, damit sie sich mit dem Schematron-Ergebnis deckt.
   * level: "error" sperrt die Freigabe, "warn" nicht.
   */
  function precheck(inv, seller) {
    const out = [];
    const err = (rule, field, text) => out.push({ level: "error", rule, field, text });
    const warn = (rule, field, text) => out.push({ level: "warn", rule, field, text });
    const tc = TAX_CASES[inv.tax_case];
    const b = inv.buyer || {};
    const t = totals(inv);

    if (!tc) err("BR-CO-18", "tax_case", "Steuerfall fehlt.");
    if (!String(inv.number || "").trim()) err("BR-02", "number", "Rechnungsnummer fehlt.");
    if (!isDate(inv.issue_date)) err("BR-03", "issue_date", "Rechnungsdatum fehlt.");
    if (!isDate(inv.period_start) || !isDate(inv.period_end)) err("§ 14 UStG", "period", "Leistungszeitraum fehlt.");
    else if (inv.period_end < inv.period_start) err("BR-29", "period", "Leistungszeitraum endet vor dem Beginn.");
    if (!isDate(inv.due_date)) err("BR-CO-25", "due_date", "Fälligkeitsdatum fehlt.");
    else if (isDate(inv.issue_date) && inv.due_date < inv.issue_date) warn("BR-CO-25", "due_date", "Fälligkeit liegt vor dem Rechnungsdatum.");

    if (!String(b.name || "").trim()) err("BR-07", "buyer.name", "Name des Kunden fehlt.");
    if (!String(b.street || "").trim()) err("§ 14 UStG", "buyer.street", "Anschrift des Kunden fehlt.");
    if (!String(b.city || "").trim()) err("BR-10", "buyer.city", "Ort des Kunden fehlt.");
    if (!/^[A-Z]{2}$/.test(String(b.country || "").toUpperCase())) err("BR-11", "buyer.country", "Land des Kunden fehlt (ISO-Code, z. B. DE).");

    if (!String(seller.name || "").trim()) err("BR-06", "seller.name", "Firmenname fehlt in den Stammdaten.");
    if (!String(seller.street || "").trim() || !String(seller.city || "").trim() || !String(seller.zip || "").trim()) err("BR-08", "seller.address", "Firmenanschrift unvollständig.");
    if (!ibanOk(seller.iban)) err("BR-61", "seller.iban", "IBAN in den Stammdaten ist ungültig.");
    if (!seller.tax_number && !seller.vat_id) err("BR-CO-26", "seller.tax", "Steuernummer oder USt-IdNr. fehlt in den Stammdaten.");

    const lines = inv.lines || [];
    if (!lines.length) err("BR-16", "lines", "Mindestens eine Position.");
    lines.forEach((l, i) => {
      if (!String(l.label || "").trim()) err("BR-25", `lines.${i}.label`, `Position ${i + 1}: Bezeichnung fehlt.`);
      if (!Number.isFinite(t.lines[i])) err("BR-27", `lines.${i}.amount`, `Position ${i + 1}: Betrag ist keine Zahl.`);
      else if (t.lines[i] < 0) err("BR-27", `lines.${i}.amount`, `Position ${i + 1}: negativer Betrag. Gutschriften laufen über Storno.`);
    });
    if (t.gross === 0 && lines.length && t.lines.every(Number.isFinite)) warn("BR-CO-15", "lines", "Rechnungsbetrag ist 0,00 €.");

    if (tc && tc.category === "AE") {
      if (!vatOk(seller.vat_id)) err("BR-AE-02", "seller.vat_id", "Reverse Charge braucht die USt-IdNr. von ROOTS (Stammdaten).");
      if (!vatOk(b.vat_id)) err("BR-AE-02", "buyer.vat_id", "Reverse Charge braucht die USt-IdNr. des Kunden.");
      const cc = String(b.country || "").toUpperCase();
      if (cc === "DE") err("§ 13b UStG", "buyer.country", "Kunde in Deutschland: Reverse Charge EU passt nicht.");
      else if (cc && !EU.includes(cc)) err("§ 3a UStG", "buyer.country", "Kunde außerhalb der EU: Steuerfall „Drittland“ wählen.");
      if (vatOk(b.vat_id) && cc && compact(b.vat_id).slice(0, 2) !== (cc === "GR" ? "EL" : cc)) warn("§ 18e UStG", "buyer.vat_id", "Länderkennung der USt-IdNr. passt nicht zum Land.");
    }
    if (tc && tc.category === "O") {
      const cc = String(b.country || "").toUpperCase();
      if (EU.includes(cc)) err("§ 3a UStG", "buyer.country", "Kunde in der EU: „Drittland“ passt nicht.");
    }
    if (tc && tc.category === "S") {
      const cc = String(b.country || "").toUpperCase();
      if (cc && cc !== "DE") warn("§ 3a UStG", "buyer.country", "Ausländischer Kunde mit deutscher Umsatzsteuer: Steuerfall prüfen.");
    }
    if (!inv.po && !inv.buyer_reference) warn("Kunde", "po", "Ohne Bestellnummer lehnen viele Rechnungseingänge ab.");
    return out;
  }

  return { XML_ATTACH_MIME, PROFILE, TAX_CASES, EU, toCents, dec, money, totals, buildXml, precheck, fmtDate, ibanOk, vatOk };
});
