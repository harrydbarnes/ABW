import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");
type PDFLoadingTask = ReturnType<PdfJs["getDocument"]>;

let pdfJsPromise: Promise<PdfJs> | null = null;
const MAX_CANVAS_DIMENSION = 8_192;
const MAX_CANVAS_PIXELS = 16_777_216;

function loadPdfJs() {
  pdfJsPromise ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  return pdfJsPromise;
}

export default function PdfPreview({
  bytes,
  demo,
  fileName,
}: {
  bytes: Uint8Array | null;
  demo: boolean;
  fileName: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(135);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [rendering, setRendering] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setPage(1);
    setPages(1);
    setPdfDocument(null);
    setProblem(null);
  }, [bytes, fileName]);

  useEffect(() => {
    if (demo || !bytes) {
      return;
    }
    let live = true;
    let loadingTask: PDFLoadingTask | null = null;
    let loadedDocument: PDFDocumentProxy | null = null;
    setRendering(true);
    setProblem(null);
    void loadPdfJs()
      .then(async (pdfjs) => {
        loadingTask = pdfjs.getDocument({ data: bytes.slice() });
        const loaded = await loadingTask.promise;
        loadedDocument = loaded;
        if (!live) {
          await loaded.destroy();
          return;
        }
        setPdfDocument(loaded);
        setPages(loaded.numPages);
        setRendering(false);
      })
      .catch(() => {
        if (live) {
          setProblem("PDF preview could not be rendered.");
          setRendering(false);
        }
      });
    return () => {
      live = false;
      setPdfDocument(null);
      if (loadedDocument) {
        void loadedDocument.destroy();
      } else if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [bytes, demo]);

  useEffect(() => {
    if (demo || !pdfDocument || !canvas.current) {
      return;
    }
    let live = true;
    let renderTask: RenderTask | null = null;
    setRendering(true);
    setProblem(null);
    void pdfDocument
      .getPage(Math.min(page, pdfDocument.numPages))
      .then(async (pdfPage) => {
        const targetPage = Math.min(page, pdfDocument.numPages);
        if (targetPage !== page) {
          setPage(targetPage);
        }
        const requestedViewport = pdfPage.getViewport({ scale: zoom / 100 });
        const displayScale = Math.min(
          1,
          MAX_CANVAS_DIMENSION / requestedViewport.width,
          MAX_CANVAS_DIMENSION / requestedViewport.height,
        );
        const viewport = pdfPage.getViewport({ scale: (zoom / 100) * displayScale });
        const context = canvas.current?.getContext("2d");
        if (!context || !canvas.current) {
          return;
        }
        const pixelBudgetScale = Math.sqrt(
          MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height),
        );
        const outputScale = Math.min(
          window.devicePixelRatio || 1,
          2,
          pixelBudgetScale,
          MAX_CANVAS_DIMENSION / viewport.width,
          MAX_CANVAS_DIMENSION / viewport.height,
        );
        if (!Number.isFinite(outputScale) || outputScale <= 0) {
          throw new Error("PDF page dimensions are invalid.");
        }
        canvas.current.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.current.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.current.style.width = `${Math.floor(viewport.width)}px`;
        canvas.current.style.height = `${Math.floor(viewport.height)}px`;
        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
        renderTask = pdfPage.render({
          canvas: canvas.current,
          canvasContext: context,
          transform,
          viewport,
        });
        await renderTask.promise;
        if (live) {
          setRendering(false);
        }
      })
      .catch(() => {
        if (live) {
          setProblem("PDF preview could not be rendered.");
          setRendering(false);
        }
      });
    return () => {
      live = false;
      renderTask?.cancel();
    };
  }, [demo, page, pdfDocument, zoom]);

  return (
    <div className="pdf-view">
      <div className="document-toolbar">
        <div className="pagination">
          <button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button disabled={page === pages} onClick={() => setPage((value) => value + 1)}>
            Next
          </button>
        </div>
        <div className="zoom-control">
          <button onClick={() => setZoom((current) => Math.max(current - 10, 80))}>-</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((current) => Math.min(current + 10, 260))}>+</button>
        </div>
      </div>
      {problem ? (
        <div className="preview-error preview-status">
          <strong>Preview unavailable</strong>
          <p>{problem}</p>
        </div>
      ) : null}
      <div className="pdf-canvas">
        {demo ? <DemoPdf fileName={fileName} /> : <canvas ref={canvas} aria-label="PDF page preview" />}
        {rendering && !problem ? (
          <div className="rendering-badge" role="status">
            Rendering page...
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DemoPdf({ fileName }: { fileName: string }) {
  const rightsDocument = fileName === "Rights clearance.pdf";
  return (
    <article className="demo-pdf-page">
      <h3>{rightsDocument ? "Rights clearance" : "Creative brief"}</h3>
      <p className="pdf-subtitle">
        {rightsDocument
          ? "Spring campaign / broadcast and digital usage"
          : "Summer launch / creative direction and delivery"}
      </p>
      <hr />
      <h4>{rightsDocument ? "Approval summary" : "Brief summary"}</h4>
      <div className="pdf-table">
        <span>{rightsDocument ? "Territory" : "Audience"}</span>
        <strong>{rightsDocument ? "United Kingdom" : "Home improvers, UK"}</strong>
        <span>{rightsDocument ? "Term" : "Delivery"}</span>
        <strong>{rightsDocument ? "12 months" : "12 June 2026"}</strong>
        <span>{rightsDocument ? "Channels" : "Formats"}</span>
        <strong>{rightsDocument ? "Broadcast, social, online video" : "Video, social, display"}</strong>
      </div>
      <p>
        {rightsDocument
          ? "Usage is approved subject to the final transmission schedule and the attached music clearance confirmation."
          : "Develop a confident, clear campaign story with adaptable assets for paid and owned placements."}
      </p>
    </article>
  );
}
