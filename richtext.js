/**
 * ROOTS Rechnungen - formatierter Positionstext.
 *
 * Gespeichert wird ein kleines HTML (b, i, u, ul, ol, li, br, div, p). Daraus
 * entstehen Absaetze mit Laeufen, die das PDF selbst umbricht und setzt
 * (Fett ueber Inter Bold, Kursiv ueber Schraegstellung, Unterstrich als Linie).
 * Fuer das XML gibt es den reinen Text: erste Zeile = Bezeichnung (BT-153),
 * Rest = Beschreibung (BT-154).
 * Laeuft im Browser und in Node (kein DOM noetig).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RootsRich = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
  const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp|#\d+);/g, (m, k) => ENT[k] ?? (k[0] === "#" ? String.fromCharCode(Number(k.slice(1))) : m));

  /** Alte Positionen mit Bezeichnung und Zusatz in einen Text ueberfuehren. */
  function fromLine(l) {
    if (l && typeof l.html === "string") return l.html;
    const label = String(l?.label || "");
    const detail = String(l?.detail || "");
    return esc(label) + (detail ? ` (${esc(detail)})` : "");
  }

  /* --------------------------------------------------------- Zerlegen --- */

  const TAG = /<\s*(\/?)\s*([a-zA-Z0-9]+)([^>]*)>/g;

  /** HTML -> Absaetze [{ list: null|"ul"|"ol", n, cont, runs: [{ t, b, i, u }] }] */
  function parse(html) {
    const paras = [];
    const st = { b: 0, i: 0, u: 0 };
    const lists = [];       // Stapel { type, n }
    let cur = null;
    const open = (o = {}) => { cur = { list: null, n: 0, cont: false, runs: [], ...o }; paras.push(cur); };
    const ensure = () => { if (!cur) open(lists.length ? { list: lists[lists.length - 1].type, cont: true, depth: lists.length } : {}); };
    const text = (s) => {
      s = unesc(s.replace(/[\r\n\t]+/g, " "));
      if (!s) return;
      if (!cur && !s.trim()) return;
      ensure();
      cur.runs.push({ t: s, b: !!st.b, i: !!st.i, u: !!st.u });
    };
    let last = 0, m;
    const src = String(html || "");
    TAG.lastIndex = 0;
    while ((m = TAG.exec(src))) {
      text(src.slice(last, m.index));
      last = TAG.lastIndex;
      const close = !!m[1], tag = m[2].toLowerCase();
      const style = /style\s*=\s*"([^"]*)"/i.exec(m[3] || "")?.[1] || "";
      if (tag === "b" || tag === "strong") st.b += close ? -1 : 1;
      else if (tag === "i" || tag === "em") st.i += close ? -1 : 1;
      else if (tag === "u") st.u += close ? -1 : 1;
      else if (tag === "span" && !close) {
        // execCommand mit styleWithCSS schreibt Spans; Formatierung mitnehmen
        const f = { b: /font-weight\s*:\s*(bold|[6-9]00)/i.test(style), i: /font-style\s*:\s*italic/i.test(style), u: /underline/i.test(style) };
        (st.spans = st.spans || []).push(f);
        if (f.b) st.b++; if (f.i) st.i++; if (f.u) st.u++;
      } else if (tag === "span" && close) {
        const f = (st.spans || []).pop();
        if (f) { if (f.b) st.b--; if (f.i) st.i--; if (f.u) st.u--; }
      } else if (tag === "ul" || tag === "ol") {
        if (cur && !cur.runs.length && paras[paras.length - 1] === cur) paras.pop();
        if (close) lists.pop(); else lists.push({ type: tag, n: 0 });
        cur = null;
      } else if (tag === "li") {
        if (close) { cur = null; continue; }
        const L = lists[lists.length - 1] || { type: "ul", n: 0 };
        L.n++;
        open({ list: L.type, n: L.n, depth: Math.max(1, lists.length) });
      } else if (tag === "br") {
        if (cur && !cur.runs.length && cur.fromDiv) { cur.fromDiv = false; continue; }
        if (cur) { const prev = cur; open({ list: prev.list, cont: !!prev.list, depth: prev.depth }); }
        else open(lists.length ? { list: lists[lists.length - 1].type, cont: true, depth: lists.length } : {});
      } else if (tag === "div" || tag === "p") {
        if (!close) open(lists.length ? { list: lists[lists.length - 1].type, cont: true, depth: lists.length, fromDiv: true } : { fromDiv: true });
        else cur = null;
      }
      st.b = Math.max(0, st.b); st.i = Math.max(0, st.i); st.u = Math.max(0, st.u);
    }
    text(src.slice(last));
    // leere Absaetze am Ende entfernen, innen zu einem zusammenfassen
    while (paras.length && !paras[paras.length - 1].runs.some((r) => r.t.trim())) paras.pop();
    while (paras.length && !paras[0].runs.some((r) => r.t.trim())) paras.shift();
    paras.forEach((p) => {
      if (p.runs.length) { p.runs[0].t = p.runs[0].t.replace(/^\s+/, ""); const z = p.runs[p.runs.length - 1]; z.t = z.t.replace(/\s+$/, ""); }
    });
    return paras;
  }

  /** Nur erlaubte Tags, ohne Attribute. Formatierung aus Spans wird zu b/i/u. */
  function sanitize(html) {
    const out = [];
    parse(html).forEach((p, idx, all) => {
      const prev = all[idx - 1];
      const inner = p.runs.map((r) => {
        let s = esc(r.t);
        if (r.u) s = `<u>${s}</u>`;
        if (r.i) s = `<i>${s}</i>`;
        if (r.b) s = `<b>${s}</b>`;
        return s;
      }).join("") || "<br>";
      if (p.list) {
        const startList = !prev || prev.list !== p.list || (!p.cont && p.n === 1);
        if (startList) { if (prev && prev.list) out.push(`</${prev.list}>`); out.push(`<${p.list}>`); }
        out.push(p.cont ? `<li>${inner}</li>` : `<li>${inner}</li>`);
      } else {
        if (prev && prev.list) out.push(`</${prev.list}>`);
        out.push(`<div>${inner}</div>`);
      }
    });
    const lastP = out.length ? parse(html).slice(-1)[0] : null;
    if (lastP && lastP.list) out.push(`</${lastP.list}>`);
    return out.join("");
  }

  /** Reiner Text, Listen mit • bzw. 1. */
  function plainLines(html) {
    return parse(html).map((p) => {
      const t = p.runs.map((r) => r.t).join("").replace(/\s+/g, " ").trim();
      if (!p.list || p.cont) return t;
      return (p.list === "ol" ? `${p.n}. ` : "• ") + t;
    }).filter((t) => t !== "");
  }
  const plain = (html) => plainLines(html).join("\n");

  /* ----------------------------------------------------------- Setzen --- */

  /**
   * Absaetze auf Breite umbrechen.
   * fonts: { R, B }  size: pt  width: pt
   * Ergebnis: Zeilen [{ segs: [{ text, x, b, i, u }], marker, markerX, gapBefore }]
   */
  function layout(paras, fonts, size, width) {
    const INDENT = size * 1.4;
    const out = [];
    paras.forEach((p, pi) => {
      const depth = p.list ? (p.depth || 1) : 0;
      const left = depth * INDENT;
      const avail = Math.max(20, width - left);
      // Woerter mit Formatierung, Leerzeichen bleiben am Wort
      const words = [];
      p.runs.forEach((r) => {
        r.t.split(/(\s+)/).forEach((w) => { if (w) words.push({ ...r, t: w }); });
      });
      let line = [], lineW = 0;
      const font = (w) => (w.b ? fonts.B : fonts.R);
      const flush = (first) => {
        while (line.length && !line[line.length - 1].t.trim()) line.pop();
        let x = left;
        const segs = line.map((w) => { const s = { text: w.t, x, b: w.b, i: w.i, u: w.u }; x += font(w).widthOfTextAtSize(w.t, size); return s; });
        out.push({
          segs,
          marker: first && p.list && !p.cont ? (p.list === "ol" ? `${p.n}.` : "•") : null,
          markerX: left - INDENT * 0.85,
          para: pi,
        });
        line = []; lineW = 0;
      };
      let first = true;
      words.forEach((w) => {
        const ww = font(w).widthOfTextAtSize(w.t, size);
        if (!w.t.trim() && !line.length) return;
        if (lineW + ww > avail && line.length && w.t.trim()) { flush(first); first = false; }
        if (!w.t.trim() && !line.length) return;
        // ueberlange Woerter hart trennen
        if (ww > avail && w.t.trim()) {
          let part = "";
          for (const ch of w.t) {
            if (font(w).widthOfTextAtSize(part + ch, size) > avail - lineW && (part || line.length)) {
              if (part) line.push({ ...w, t: part });
              flush(first); first = false; part = "";
            }
            part += ch;
          }
          if (part) { line.push({ ...w, t: part }); lineW += font(w).widthOfTextAtSize(part, size); }
          return;
        }
        line.push(w); lineW += ww;
      });
      if (line.length || !words.length) flush(first);
    });
    return out;
  }

  /** Eine gesetzte Zeile zeichnen. */
  function drawLine(page, ln, x, y, size, color, fonts, PDFLib) {
    if (ln.marker) page.drawText(ln.marker, { x: x + ln.markerX, y, size, font: fonts.R, color });
    ln.segs.forEach((s) => {
      const f = s.b ? fonts.B : fonts.R;
      const o = { x: x + s.x, y, size, font: f, color };
      if (s.i && PDFLib) o.ySkew = PDFLib.degrees(12);
      page.drawText(s.text, o);
      if (s.u && s.text.trim()) {
        const w = f.widthOfTextAtSize(s.text.replace(/\s+$/, ""), size);
        page.drawLine({ start: { x: x + s.x, y: y - size * 0.14 }, end: { x: x + s.x + w, y: y - size * 0.14 }, thickness: size * 0.055, color });
      }
    });
  }

  return { fromLine, parse, sanitize, plain, plainLines, layout, drawLine, esc };
});
