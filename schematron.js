/**
 * ROOTS Rechnungen - offizieller Schematron Factur-X 1.09.2 EN 16931 im Browser.
 *
 * Die XSLT-2-Fassung aus dem factur-x-Paket ist mit xslt3 nach SEF kompiliert
 * (schematron/en16931.sef.json) und laeuft in SaxonJS. Die Codeliste wird
 * vorab in den documentPool gelegt, weil das Stylesheet sie per document() liest.
 */
window.RootsSchematron = (function () {
  "use strict";

  let state = null;

  function load() {
    if (state) return state;
    state = (async () => {
      const base = new URL("schematron/", location.href).href;
      const [sef, codedbText] = await Promise.all([
        fetch(base + "en16931.sef.json").then((r) => { if (!r.ok) throw new Error("Schematron fehlt"); return r.json(); }),
        fetch(base + "FACTUR-X_EN16931_codedb.xml").then((r) => { if (!r.ok) throw new Error("Codeliste fehlt"); return r.text(); }),
      ]);
      const codedb = await SaxonJS.getResource({ text: codedbText, type: "xml" });
      return { sef, base, pool: { [base + "FACTUR-X_EN16931_codedb.xml"]: codedb } };
    })().catch((e) => {
      state = null;
      throw e;
    });
    return state;
  }

  async function validate(xml) {
    const s = await load();
    const result = SaxonJS.transform({
      stylesheetInternal: s.sef,
      stylesheetBaseURI: s.base + "FACTUR-X_EN16931.xslt",
      documentPool: s.pool,
      sourceText: xml,
      destination: "serialized",
    });
    const svrl = new DOMParser().parseFromString(result.principalResult, "application/xml");
    const NS = "http://purl.oclc.org/dsdl/svrl";
    const errors = [];
    const warnings = [];
    for (const node of svrl.getElementsByTagNameNS(NS, "failed-assert")) {
      const text = (node.getElementsByTagNameNS(NS, "text")[0]?.textContent || "").replace(/\s+/g, " ").trim();
      const item = { id: node.getAttribute("id") || "", text, location: node.getAttribute("location") || "" };
      (node.getAttribute("flag") === "warning" ? warnings : errors).push(item);
    }
    return { passed: errors.length === 0, errors, warnings, version: "Factur-X 1.09.2 EN 16931" };
  }

  return { load, validate };
})();
