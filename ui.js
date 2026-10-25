/**
 * ROOTS Rechnungen - eigene Bedienelemente.
 *
 * - Dropdowns: jedes <select> bekommt eine eigene Oberflaeche im Stil von
 *   ROOTS Image AI. Das native select bleibt unsichtbar die Datenquelle und
 *   meldet Aenderungen wie gewohnt per input/change.
 * - Datumsfelder: Textfelder im Format TT.MM.JJJJ statt Browser-Datumsauswahl.
 * - Vorschau: zeichnet ein PDF mit pdf.js seitenweise in Canvas-Elemente,
 *   weil der eingebaute PDF-Betrachter im abgeschotteten iframe nicht laeuft.
 */
window.RootsUI = (function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ------------------------------------------------------------ Dropdown --- */

  let openWrap = null;

  function close() {
    if (!openWrap) return;
    openWrap.classList.remove("open");
    openWrap = null;
  }

  function label(select) {
    const o = select.options[select.selectedIndex];
    return o ? o.textContent : "";
  }

  function build(select) {
    const wrap = document.createElement("div");
    wrap.className = "cs";
    if (select.id) wrap.dataset.for = select.id;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cs-trigger";
    trigger.innerHTML = `<span class="cs-value"></span><i class="fa-solid fa-chevron-down cs-arrow"></i>`;
    const list = document.createElement("div");
    list.className = "cs-options";
    list.setAttribute("role", "listbox");
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(trigger);
    wrap.appendChild(list);
    select.classList.add("cs-native");
    select.tabIndex = -1;

    const fill = () => {
      trigger.querySelector(".cs-value").textContent = label(select);
      trigger.classList.toggle("placeholder", !select.value);
      trigger.classList.toggle("invalid", select.classList.contains("invalid"));
      list.innerHTML = [...select.options].map((o, i) =>
        `<div class="cs-option${o.selected ? " selected" : ""}" role="option" data-i="${i}">${esc(o.textContent)}${o.selected ? '<i class="fa-solid fa-check"></i>' : ""}</div>`).join("");
    };
    fill();
    select._csFill = fill;

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const was = wrap.classList.contains("open");
      close();
      if (!was) {
        fill();
        wrap.classList.add("open");
        openWrap = wrap;
        list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
      }
    });
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = select.selectedIndex + (e.key === "ArrowDown" ? 1 : -1);
        if (n >= 0 && n < select.options.length) choose(n);
      }
      if (e.key === "Escape") close();
    });
    list.addEventListener("click", (e) => {
      const opt = e.target.closest(".cs-option");
      if (!opt) return;
      e.stopPropagation();
      choose(Number(opt.dataset.i));
      close();
      trigger.focus();
    });

    function choose(i) {
      if (select.selectedIndex === i) return fill();
      select.selectedIndex = i;
      fill();
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /** Alle noch nicht umgebauten selects unterhalb von root ersetzen. */
  function enhance(root = document) {
    root.querySelectorAll("select:not(.cs-native)").forEach(build);
    root.querySelectorAll("select.cs-native").forEach((s) => s._csFill?.());
  }

  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  /* ---------------------------------------------------------------- Datum --- */

  const isoToDe = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
  };

  /** "1.9.2026" / "01.09.26" -> "2026-09-01"; ungueltig -> "" */
  function deToIso(text) {
    const m = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\s*$/.exec(String(text || ""));
    if (!m) return "";
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
    if (d.getUTCDate() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1) return "";
    return d.toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------ Vorschau --- */

  let pdfjsReady = null;
  function pdfjs() {
    if (!pdfjsReady) {
      pdfjsReady = Promise.resolve().then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error("pdf.js fehlt");
        // Im abgeschotteten iframe scheitert ein Worker von fremder Herkunft;
        // pdf.worker.min.js ist als Skript geladen, pdf.js nutzt es dann direkt.
        lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.js", location.href).href;
        return lib;
      });
    }
    return pdfjsReady;
  }

  let renderToken = 0;
  async function renderPdf(bytes, container) {
    const token = ++renderToken;
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: bytes, disableWorker: true, isEvalSupported: false }).promise;
    if (token !== renderToken) return;
    const cs = getComputedStyle(container);
    const width = Math.max(280, Math.floor(container.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 2));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const canvases = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (width / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.style.width = width + "px";
      canvas.className = "preview-page";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      if (token !== renderToken) return;
      const wrap = document.createElement("div");
      wrap.className = "preview-page-wrap";
      if (container.dataset.zoomKey) wrap.dataset.restore = "1";
      wrap.style.width = width + "px";
      wrap.appendChild(canvas);
      canvases.push(wrap);
    }
    const scroll = container.scrollTop;
    container.replaceChildren(...canvases);
    container.scrollTop = scroll;
    doc.destroy();
    return doc.numPages;
  }

  /* ---------------------------------------------------------------- Logo --- */

  /** Bilddatei auf max. 240x120 verkleinern, als PNG-Data-URL. */
  function logoFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(file.type)) return reject(new Error("Nur PNG, JPG, WebP, SVG oder GIF"));
      if (file.size > 3 * 1024 * 1024) return reject(new Error("Logo größer als 3 MB"));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, 240 / img.width, 120 / img.height);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * s));
        c.height = Math.max(1, Math.round(img.height * s));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Bild nicht lesbar")); };
      img.src = url;
    });
  }

  function monogram(name) {
    const words = String(name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
    return (words[0]?.[0] || "?").toUpperCase() + (words[1]?.[0] || "").toUpperCase();
  }

  /** Nur Data-URLs und https-Bilder anzeigen. */
  function safeLogo(src) {
    const s = String(src || "");
    return /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(s) || /^https:\/\/[^\s"'<>]+$/.test(s) ? s : "";
  }

  /* ------------------------------------------------- Bereich hervorheben --- */

  /**
   * Bereich einer Seite dezent umrahmen und leicht heranzoomen. Der Zoom bleibt,
   * solange im Formular ein Feld aktiv ist; release() zoomt wieder heraus.
   * region: { page, x, y, w, h } als Anteile der Seite.
   */
  function highlight(container, region) {
    if (!container || !region) return;
    const wraps = container.querySelectorAll(".preview-page-wrap");
    const wrap = wraps[region.page];
    if (!wrap) return;
    const key = JSON.stringify(region);
    let hl = wrap.querySelector(".pv-hl");
    const known = hl && hl.dataset.key === key;
    if (!known) {
      container.querySelectorAll(".pv-hl").forEach((el) => { if (el !== hl) el.remove(); });
      if (!hl) {
        hl = document.createElement("div");
        hl.className = "pv-hl" + (wrap.dataset.restore === "1" && container.dataset.zoomKey === key ? " steady" : "");
        wrap.appendChild(hl);
      }
      hl.dataset.key = key;
      hl.style.left = region.x * 100 + "%";
      hl.style.top = region.y * 100 + "%";
      hl.style.width = region.w * 100 + "%";
      hl.style.height = region.h * 100 + "%";
    }
    hl.classList.remove("fade");
    wraps.forEach((w) => { if (w !== wrap) w.classList.remove("zoomed"); });
    const origin = `${Math.max(0, region.x) * 100}% ${(region.y + region.h / 2) * 100}%`;
    const wasZoomed = wrap.classList.contains("zoomed");
    if (!wasZoomed && wrap.dataset.restore === "1") {
      // nach dem Neuzeichnen der Vorschau ohne Animation wieder herstellen
      wrap.classList.add("no-anim");
      wrap.style.transformOrigin = origin;
      wrap.classList.add("zoomed");
      void wrap.offsetWidth;
      wrap.classList.remove("no-anim");
    } else {
      wrap.style.transformOrigin = origin;
      wrap.classList.add("zoomed");
    }
    container.dataset.zoomKey = key;
    const restored = wrap.dataset.restore === "1";
    delete wrap.dataset.restore;
    if (!known && !restored) {
      const target = wrap.offsetTop + wrap.offsetHeight * (region.y + region.h / 2) - container.clientHeight / 2;
      if (Math.abs(container.scrollTop - target) > 40) container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  function release(container) {
    if (!container) return;
    container.querySelectorAll(".preview-page-wrap.zoomed").forEach((w) => w.classList.remove("zoomed"));
    container.querySelectorAll(".pv-hl").forEach((hl) => { hl.classList.add("fade"); setTimeout(() => hl.classList.contains("fade") && hl.remove(), 700); });
    delete container.dataset.zoomKey;
  }

  return { enhance, highlight, release, close, isoToDe, deToIso, renderPdf, logoFromFile, monogram, safeLogo };
})();
