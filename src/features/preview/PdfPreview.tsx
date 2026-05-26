import { useEffect, useRef, useState } from "react";

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
  const [zoom, setZoom] = useState(100);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (demo || !bytes || !canvas.current) {
      return;
    }
    let live = true;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    void Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
      .then(async ([pdfjs, worker]) => {
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const document = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (!live) {
          return;
        }
        setPages(document.numPages);
        const pdfPage = await document.getPage(Math.min(page, document.numPages));
        const viewport = pdfPage.getViewport({ scale: (zoom / 100) * 1.25 });
        const context = canvas.current?.getContext("2d");
        if (!context || !canvas.current) {
          return;
        }
        canvas.current.width = viewport.width;
        canvas.current.height = viewport.height;
        renderTask = pdfPage.render({ canvas: canvas.current, canvasContext: context, viewport });
        await renderTask.promise;
      })
      .catch(() => {
        if (live) {
          setProblem("PDF preview could not be rendered.");
        }
      });
    return () => {
      live = false;
      renderTask?.cancel();
    };
  }, [bytes, demo, page, zoom]);

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
          <button onClick={() => setZoom((current) => Math.max(current - 10, 60))}>-</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((current) => Math.min(current + 10, 180))}>+</button>
        </div>
      </div>
      {problem ? <div className="preview-error">{problem}</div> : null}
      <div className="pdf-canvas">
        {demo ? <DemoPdf fileName={fileName} /> : <canvas ref={canvas} aria-label="PDF page preview" />}
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
