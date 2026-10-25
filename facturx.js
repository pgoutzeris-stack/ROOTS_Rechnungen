/**
 * ROOTS Rechnungen - factur-x (Akretion, Python) im Browser ueber Pyodide.
 *
 * Prueft das XML gegen das offizielle XSD (Factur-X 1.09 EN 16931), bettet es
 * als factur-x.xml in das PDF (PDF/A-3, AFRelationship Data, XMP) und liest es
 * zur Kontrolle wieder aus. Wheels liegen unter py/, damit zur Laufzeit nichts
 * von PyPI kommt.
 */
window.RootsFacturX = (function () {
  "use strict";

  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
  const WHEELS = [
    "pypdf-6.20.1-py3-none-any.whl",
    "iso4217-1.16.20260101-py2.py3-none-any.whl",
    "python_stdnum-2.2-py3-none-any.whl",
    "factur_x-7.6-py3-none-any.whl",
  ];

  const PY = `
import sys, types, base64, json
sys.modules.setdefault("requests", types.ModuleType("requests"))
from facturx import generate_from_binary, xml_check_xsd, get_xml_from_pdf
import facturx as _fx
import mimetypes
# Pyodide kennt die Office-Typen nicht; ohne sie landet application/octet-stream als /Subtype im PDF
mimetypes.add_type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx")
mimetypes.add_type("application/vnd.ms-excel.sheet.macroEnabled.12", ".xlsm")
mimetypes.add_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx")

_fx_mod = __import__("facturx.facturx", fromlist=["CREATOR"])
_fx_mod.CREATOR = "ROOTS Rechnungen"

def rg_build(pdf_b64, xml_str, lang, meta_json="{}", att_json="[]"):
    res = {"xsd": "failed", "roundtrip": "failed", "lib": "factur-x " + getattr(_fx, "__version__", "7.6")}
    pdf = base64.b64decode(pdf_b64)
    xml = xml_str.encode("utf-8")
    try:
        xml_check_xsd(xml, flavor="factur-x", level="en16931")
        res["xsd"] = "passed"
    except Exception as e:
        res["xsd_error"] = str(e)[:1200]
        return json.dumps(res)
    meta = json.loads(meta_json or "{}")
    pdf_metadata = {k: meta[k] for k in ("author", "title", "subject", "keywords") if meta.get(k)} or None
    attachments = {}
    for a in json.loads(att_json or "[]"):
        attachments[a["name"]] = {"filedata": base64.b64decode(a["b64"]), "description": a.get("description") or a["name"], "afrelationship": "supplement"}
    out = generate_from_binary(pdf, xml, flavor="factur-x", level="en16931", check_xsd=False, lang=lang, xmp_compression=False, pdf_metadata=pdf_metadata, attachments=attachments or None)
    fn, back = get_xml_from_pdf(out, check_xsd=True)
    if fn == "factur-x.xml" and back == xml:
        res["roundtrip"] = "passed"
    else:
        res["roundtrip_error"] = "Eingebettetes XML weicht ab"
    res["pdf"] = base64.b64encode(out).decode("ascii")
    return json.dumps(res)

def rg_xsd(xml_str):
    try:
        xml_check_xsd(xml_str.encode("utf-8"), flavor="factur-x", level="en16931")
        return json.dumps({"xsd": "passed"})
    except Exception as e:
        return json.dumps({"xsd": "failed", "xsd_error": str(e)[:1200]})
`;

  let ready = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.loadPyodide) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Pyodide konnte nicht geladen werden"));
      document.head.appendChild(s);
    });
  }

  function load(onStatus) {
    if (ready) return ready;
    ready = (async () => {
      onStatus?.("Prüfmodul wird geladen");
      await loadScript(PYODIDE + "pyodide.js");
      const py = await window.loadPyodide({ indexURL: PYODIDE });
      onStatus?.("lxml wird geladen");
      await py.loadPackage(["lxml", "micropip", "ssl"]);
      onStatus?.("factur-x wird installiert");
      const base = new URL("py/", location.href).href;
      const micropip = py.pyimport("micropip");
      await micropip.install(WHEELS.map((w) => base + w), { deps: false });
      py.runPython(PY);
      return py;
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  }

  /** attachments: [{ name, bytes, description }] als weitere Dateien im PDF/A-3 (AFRelationship Supplement). */
  async function build(pdfBytes, xml, lang, onStatus, meta, attachments) {
    const py = await load(onStatus);
    onStatus?.("XSD-Prüfung und Einbettung");
    const fn = py.globals.get("rg_build");
    try {
      const att = (attachments || []).map((a) => ({ name: a.name, description: a.description || a.name, b64: bytesToBase64(a.bytes) }));
      return JSON.parse(fn(bytesToBase64(pdfBytes), xml, lang, JSON.stringify(meta || {}), JSON.stringify(att)));
    } finally {
      fn.destroy();
    }
  }

  async function xsd(xml, onStatus) {
    const py = await load(onStatus);
    const fn = py.globals.get("rg_xsd");
    try {
      return JSON.parse(fn(xml));
    } finally {
      fn.destroy();
    }
  }

  function bytesToBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  return { load, build, xsd, bytesToBase64, base64ToBytes };
})();
