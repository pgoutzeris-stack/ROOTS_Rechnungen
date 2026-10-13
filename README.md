# ROOTS Rechnungen

Intranet-Tool für Ausgangsrechnungen als E-Rechnung nach EN 16931
(Factur-X 1.09 / ZUGFeRD, Profil EN 16931, PDF/A-3 mit eingebettetem `factur-x.xml`).
Sichtbar nur für die Personen in `public.rg_members`.

## Prüfkette

1. Pflichtangaben (`einvoice.js`, `precheck`) live im Formular
2. Offizieller Schematron Factur-X 1.09.2 EN 16931 (`schematron/`, SaxonJS)
3. XSD und Einbettung mit der Python-Bibliothek `factur-x` (Akretion) in Pyodide (`facturx.js`, Wheels in `py/`)
4. Serverprüfung in `public.rg_finalize` (XPath auf das XML, Summen, Steuerfall, PDF-Marker)

Nur Schritt 4 macht eine Rechnung endgültig. Endgültige Rechnungen sind per
Trigger unveränderlich; ein Entwurf trägt nie XML oder PDF.

## Aktualisieren des Schematrons

```
npx xslt3 -xsl:FACTUR-X_EN16931.xslt -export:schematron/en16931.sef.json -nogo -relocate:on
```

Quelle: `facturx/xsd_and_schematron/facturx-en16931/` aus dem factur-x-Paket.

## Lokal testen

`dev-harness.html` mit `dev-mock.js` (nicht im Repo) ersetzt den Intranet-Broker durch Speicher.

Fremdcode: pdf-lib (MIT), fontkit (MIT), SaxonJS 2.7 (Saxonica, siehe `vendor/SaxonJS-LICENSE.txt`),
factur-x (BSD), Inter (OFL), Pyodide (MPL).
