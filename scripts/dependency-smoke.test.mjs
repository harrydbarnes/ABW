import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
// PDF.js's Node build supplies polyfills unavailable in some supported Node releases.
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");

test("ExcelJS reads and writes cells and UUID-dependent conditional formatting", { timeout: 30_000 }, async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Dependency check");
  sheet.getCell("A1").value = "ABW";
  sheet.getCell("B1").value = 42;
  sheet.getCell("B2").value = 84;
  sheet.addConditionalFormatting({
    ref: "B1:B2",
    rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "min" }, { type: "max" }] }],
  });

  const bytes = await workbook.xlsx.writeBuffer();
  assert.match(sheet.conditionalFormattings[0].rules[0].x14Id, /^\{[0-9A-F-]{36}\}$/);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  assert.equal(restored.worksheets.length, 1);
  assert.equal(restored.worksheets[0].getCell("A1").value, "ABW");
  assert.equal(restored.worksheets[0].getCell("B1").value, 42);
  assert.equal(restored.worksheets[0].getCell("B2").value, 84);
  assert.equal(restored.worksheets[0].conditionalFormattings[0].ref, "B1:B2");
  assert.equal(restored.worksheets[0].conditionalFormattings[0].rules[0].type, "dataBar");
});

function pdfFixture() {
  const stream = "0 0 0 rg 10 10 80 80 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("PDF.js loads its worker, renders at multiple zoom levels, and tears down", { timeout: 30_000 }, async () => {
  const task = getDocument({ data: pdfFixture() });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    for (const scale of [1, 1.35, 2]) {
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      assert.deepEqual([...context.getImageData(50 * scale, 50 * scale, 1, 1).data], [0, 0, 0, 255]);
      assert.deepEqual([...context.getImageData(2 * scale, 2 * scale, 1, 1).data], [255, 255, 255, 255]);
    }
  } finally {
    await task.destroy();
  }
});

test("PDF.js rejects invalid input and still tears down", { timeout: 30_000 }, async () => {
  const task = getDocument({ data: new TextEncoder().encode("not a PDF") });
  try {
    await assert.rejects(task.promise, { name: "InvalidPDFException" });
  } finally {
    await task.destroy();
  }
});
