import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
// PDF.js's Node build supplies polyfills unavailable in some supported Node releases.
const { getDocument, PDFDataRangeTransport } = await import("pdfjs-dist/legacy/build/pdf.mjs");

function pdfFixture() {
  const stream1 = "0 0 0 rg 10 10 80 80 re f\n";
  const stream2 = "1 0 0 rg 10 10 80 80 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${stream1.length} >>\nstream\n${stream1}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R >>",
    `<< /Length ${stream2.length} >>\nstream\n${stream2}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test("PDF.js loads its worker, renders at multiple zoom levels, and tears down", { timeout: 30_000 }, async () => {
  const task = getDocument({ data: pdfFixture() });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);
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

test("PDF.js streams pages on demand via PDFDataRangeTransport", { timeout: 30_000 }, async () => {
  const bytes = pdfFixture();
  const requestedRanges = [];
  class MemoryRangeTransport extends PDFDataRangeTransport {
    #aborted = false;

    constructor(length, initialData) {
      super(length, initialData, false);
    }

    requestDataRange(begin, end) {
      if (this.#aborted) {
        return;
      }
      requestedRanges.push([begin, end]);
      const chunk = bytes.subarray(begin, Math.min(end, bytes.byteLength)).slice();
      queueMicrotask(() => {
        if (!this.#aborted) {
          this.onDataRange(begin, chunk);
        }
      });
    }

    abort() {
      this.#aborted = true;
    }
  }

  const transport = new MemoryRangeTransport(bytes.byteLength, bytes.subarray(0, 64).slice());
  const task = getDocument({
    range: transport,
    rangeChunkSize: 64,
    disableAutoFetch: true,
    disableStream: true,
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);
    const page2 = await document.getPage(2);
    const viewport = page2.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page2.render({ canvas, canvasContext: context, viewport }).promise;
    assert.deepEqual([...context.getImageData(50, 50, 1, 1).data], [255, 0, 0, 255]);
    assert.ok(requestedRanges.length > 0);
  } finally {
    transport.abort();
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
