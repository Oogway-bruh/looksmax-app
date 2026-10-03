import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { decodeEntities, decodeText, extractContent, htmlToText, rtfToText } from "@/lib/extract";
import { OFFICE } from "@/lib/file-types";

const zipBuffer = async (files: Record<string, string | Buffer>) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
};
const rels = (items: [string, string, string][]) =>
  `<Relationships>${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`;

describe("kodowania i encje", () => {
  it("rozpoznaje UTF-8 z BOM, UTF-16 i polskie Windows-1250", () => {
    expect(decodeText(Buffer.from("﻿żółć", "utf8"))).toBe("żółć");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Żuchwa szeroka", "utf16le")]))).toBe("Żuchwa szeroka");
    // "Żuchwa" w Windows-1250: Ż = 0xAF
    expect(decodeText(Buffer.from([0xaf, 0x75, 0x63, 0x68, 0x77, 0x61, 0x20, 0xb3, 0xb9, 0x6b, 0x61]))).toBe("Żuchwa łąka");
    expect(decodeText(Buffer.from("zwykły tekst ąę", "utf8"))).toBe("zwykły tekst ąę");
  });

  it("dekoduje encje w jednym przebiegu (bez podwójnego dekodowania)", () => {
    expect(decodeEntities("a &amp;lt; b &#x2264; c &#8805; d &deg;")).toBe("a &lt; b ≤ c ≥ d °");
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;");
  });
});

describe("HTML i RTF", () => {
  it("HTML: tabele, akapity, encje; bez tytułu i stylów", () => {
    const text = htmlToText("<html><head><title>Tytuł</title><style>x{}</style></head><h1>Oczy</h1><table><tr><td>Tilt</td><td>&gt; 4&deg;</td></tr></table><p>A&nbsp;B</p></html>");
    expect(text).toContain("Oczy");
    expect(text).toContain("Tilt | > 4°");
    expect(text).toContain("A B");
    expect(text).not.toContain("Tytuł");
  });

  it("RTF: tekst z polskimi znakami (\\'xx i \\u), bez tabel czcionek", () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1250{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}\f0 Szeroka \'bf uchwa\par Canthal tilt \u8805? 4\'b0\par}`;
    const text = rtfToText(rtf);
    expect(text).toContain("Szeroka ż uchwa");
    expect(text).toContain("Canthal tilt ≥ 4°");
    expect(text).not.toContain("Arial");
  });
});

describe("PowerPoint", () => {
  it("kolejność slajdów z presentation.xml, łamania linii, tabele, notatki z relacji", async () => {
    const data = await zipBuffer({
      "ppt/presentation.xml": `<p:presentation><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels([
        ["rId1", "slide", "slides/slide1.xml"],
        ["rId2", "slide", "slides/slide2.xml"],
      ]),
      // slide2.xml jest pierwszy w prezentacji (przestawione slajdy).
      "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t xml:space="preserve">Canthal </a:t></a:r><a:r><a:t>tilt</a:t></a:r><a:br/><a:r><a:t>&gt; 4°</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>FWHR</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>1.9</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:sld>`,
      "ppt/slides/_rels/slide2.xml.rels": rels([["rIdN", "notesSlide", "../notesSlides/notesSlide7.xml"]]),
      "ppt/notesSlides/notesSlide7.xml": `<p:notes><a:p><a:r><a:t>notatka prelegenta</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>`,
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Drugi slajd</a:t></a:r></a:p></p:sld>`,
    });
    const { text } = await extractContent({ mediaType: OFFICE.pptx, path: "a.pptx" }, data);
    expect(text.indexOf("Canthal tilt")).toBeLessThan(text.indexOf("Drugi slajd"));
    expect(text).toContain("Canthal tilt\n> 4°");
    expect(text).toContain("FWHR | 1.9");
    expect(text).toContain("[notatki prelegenta: notatka prelegenta]");
    expect(text.match(/notatki/g)).toHaveLength(1);
  });

  it("zwraca obrazy osadzone na slajdach w kolejności", async () => {
    const png = Buffer.from("PNGDATA");
    const data = await zipBuffer({
      "ppt/presentation.xml": `<p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst>`,
      "ppt/_rels/presentation.xml.rels": rels([["rId1", "slide", "slides/slide1.xml"]]),
      "ppt/slides/slide1.xml": `<p:sld><a:blip r:embed="rIdB"/><a:blip r:embed="rIdA"/></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": rels([
        ["rIdA", "image", "../media/a.png"],
        ["rIdB", "image", "../media/b.png"],
      ]),
      "ppt/media/a.png": png,
      "ppt/media/b.png": Buffer.from("B"),
    });
    const { images } = await extractContent({ mediaType: OFFICE.pptx, path: "a.pptx" }, data);
    expect(images.map((i) => i.label)).toEqual(["slajd 1, obraz 1", "slajd 1, obraz 2"]);
    expect(images[1].data.toString()).toBe("PNGDATA");
  });
});

describe("Excel", () => {
  it("komórki na właściwych kolumnach, kolejność arkuszy wg skoroszytu, bez fonetyki, z PRAWDA/FAŁSZ", async () => {
    const data = await zipBuffer({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Progi" sheetId="1" r:id="rId2"/><sheet name="Inne" sheetId="2" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "worksheet", "worksheets/sheet2.xml"],
      ]),
      "xl/sharedStrings.xml": `<sst><si><t>Cecha</t></si><si><r><t>Pró</t></r><r><t>g</t></r><rPh><t>XX</t></rPh></si><si><t xml:space="preserve">FWHR_x000D_</t></si></sst>`,
      "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1.9</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inny</t></is></c></row></sheetData></worksheet>`,
    });
    const { text } = await extractContent({ mediaType: OFFICE.xlsx, path: "a.xlsx" }, data);
    expect(text.indexOf("Arkusz: Progi")).toBeLessThan(text.indexOf("Arkusz: Inne"));
    expect(text).toContain("Cecha |  | Próg");
    expect(text).toContain("FWHR |  | 1.9 | PRAWDA");
    expect(text).not.toContain("XX");
    expect(text).toContain("inny");
  });
});

describe("tabele Worda, wykresy, SmartArt i formaty liczb", () => {
  it("Word: wiersz tabeli w jednej linii, puste komórki zachowują kolumny", () => {
    const text = htmlToText(
      "<table><tr><td><p>Cecha</p></td><td><p>Ideał</p></td><td><p>Słabo</p></td></tr><tr><td><p>Tilt</p></td><td><p></p></td><td><p>&lt; 0°</p></td></tr></table>",
    );
    expect(text).toContain("Cecha | Ideał | Słabo");
    expect(text).toContain("Tilt | | < 0°");
  });

  it("PowerPoint: tekst wykresu (tytuł, serie) i diagramu SmartArt ze slajdu", async () => {
    const data = await zipBuffer({
      "ppt/presentation.xml": `<p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst>`,
      "ppt/_rels/presentation.xml.rels": rels([["rId1", "slide", "slides/slide1.xml"]]),
      "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Proces glow-up</a:t></a:r></a:p><c:chart r:id="rC"/><dgm:relIds r:dm="rD" r:lo="rL"/></p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": rels([
        ["rC", "chart", "../charts/chart3.xml"],
        ["rD", "diagramData", "../diagrams/data1.xml"],
        ["rL", "diagramLayout", "../diagrams/layout1.xml"],
      ]),
      "ppt/charts/chart3.xml": `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>FWHR wg ocen</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Średnia</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>8/10</c:v></c:pt><c:pt idx="1"><c:v>5/10</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>2.1</c:v></c:pt><c:pt idx="1"><c:v>1.8</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
      "ppt/diagrams/data1.xml": `<dgm:dataModel><dgm:ptLst><dgm:pt><dgm:t><a:p><a:r><a:t>1. Mewing 6 miesięcy</a:t></a:r></a:p></dgm:t></dgm:pt><dgm:pt><dgm:t><a:p><a:r><a:t>2. Body fat poniżej 12%</a:t></a:r></a:p></dgm:t></dgm:pt></dgm:ptLst></dgm:dataModel>`,
    });
    const { text } = await extractContent({ mediaType: OFFICE.pptx, path: "a.pptx" }, data);
    expect(text).toContain("Proces glow-up");
    expect(text).toContain("tytuł: FWHR wg ocen");
    expect(text).toContain("Średnia: 8/10 = 2.1; 5/10 = 1.8");
    expect(text).toContain("1. Mewing 6 miesięcy | 2. Body fat poniżej 12%");
  });

  it("Excel: procenty, daty i liczby bez szumu zmiennoprzecinkowego wg stylów komórek", async () => {
    const data = await zipBuffer({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Progi" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
      "xl/styles.xml": `<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot; dni&quot;"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Body fat</t></is></c><c r="B1" s="1"><v>0.12</v></c><c r="C1" s="2"><v>45123</v></c><c r="D1" s="3"><v>0.30000000000000004</v></c><c r="E1" t="str"><v>tekst</v></c></row></sheetData></worksheet>`,
    });
    const { text } = await extractContent({ mediaType: OFFICE.xlsx, path: "a.xlsx" }, data);
    expect(text).toContain("Body fat | 12% | 2023-07-16 | 0.3 | tekst");
  });
});
