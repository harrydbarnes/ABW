import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { readDownloadRange } from "../../lib/desktop";
import type { DownloadRecord } from "../../types";
import { formatBytes, loadCachedPdfHead } from "./previewCache";
import {
  clampPdfPage,
  computePdfScale,
  nextPdfRotation,
  type PdfFitMode,
} from "./previewUtils";

type PdfJs = typeof import("pdfjs-dist");
type PDFLoadingTask = ReturnType<PdfJs["getDocument"]>;

let pdfJsPromise: Promise<PdfJs> | null = null;
const MAX_CANVAS_DIMENSION = 8_192;
const MAX_CANVAS_PIXELS = 16_777_216;
const PDF_RANGE_CHUNK_BYTES = 131_072;
const MIN_ZOOM_PERCENT = 40;
const MAX_ZOOM_PERCENT = 260;

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

export default memo(function PdfPreview({
  demo,
  record,
}: {
  demo: boolean;
  record: DownloadRecord;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const canvasWrap = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [pages, setPages] = useState(1);
  const [zoom, setZoom] = useState(135);
  const [fitMode, setFitMode] = useState<PdfFitMode>("width");
  const [rotation, setRotation] = useState(0);
  const [displayedZoom, setDisplayedZoom] = useState(100);
  const fitModeRef = useRef<PdfFitMode>("width");
  const displayedZoomRef = useRef(100);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [rendering, setRendering] = useState(!demo);
  const [problem, setProblem] = useState<string | null>(null);

  fitModeRef.current = fitMode;
  displayedZoomRef.current = displayedZoom;

  useEffect(() => {
    setPageDraft(String(page));
  }, [page]);

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) {
        return;
      }
      event.preventDefault();
      const rawStep = Math.round(-event.deltaY * 0.14);
      const delta = rawStep === 0 ? (event.deltaY < 0 ? 6 : -6) : Math.max(-20, Math.min(20, rawStep));
      const baseZoom = fitModeRef.current === "manual" ? null : displayedZoomRef.current;
      setFitMode("manual");
      setZoom((current) =>
        Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, (baseZoom ?? current) + delta)),
      );
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const element = canvasWrap.current;
    if (!element) {
      return;
    }
    const updateSize = (width: number, height: number) => {
      if (width <= 0 || height <= 0) {
        return;
      }
      setContainerSize((current) =>
        Math.abs(current.width - width) >= 4 || Math.abs(current.height - height) >= 4
          ? { width, height }
          : current,
      );
    };
    const rect = element.getBoundingClientRect();
    updateSize(Math.round(rect.width) || element.clientWidth, Math.round(rect.height) || element.clientHeight);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    let timer = 0;
    const observer = new ResizeObserver((entries) => {
      const entryRect = entries[0]?.contentRect;
      const width = entryRect?.width ?? element.clientWidth;
      const height = entryRect?.height ?? element.clientHeight;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        updateSize(width, height);
      }, 90);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [record.id, demo]);

  useEffect(() => {
    setPage(1);
    setPageDraft("1");
    setPages(1);
    setFitMode("width");
    setRotation(0);
    setPdfDocument(null);
    setProblem(null);
    setRendering(!demo);
  }, [record.id, demo]);

  useEffect(() => {
    if (demo) {
      return;
    }
    let live = true;
    let loadingTask: PDFLoadingTask | null = null;
    let rangeTransport: InstanceType<PdfJs["PDFDataRangeTransport"]> | null = null;
    setRendering(true);
    setProblem(null);

    void Promise.all([loadPdfJs(), loadCachedPdfHead(record)])
      .then(async ([pdfjs, head]) => {
        if (!live) {
          return;
        }
        if (!head) {
          throw new Error("This PDF could not be read for preview.");
        }
        if (head.complete) {
          loadingTask = pdfjs.getDocument({ data: head.initialChunk.slice() });
        } else {
          class TauriPdfRangeTransport extends pdfjs.PDFDataRangeTransport {
            private aborted = false;
            private readonly inFlight = new Map<string, Promise<Uint8Array>>();
            private readonly tailOffset: number;
            private readonly tailChunk: Uint8Array | undefined;

            constructor(
              length: number,
              initialData: Uint8Array,
              tailOffset?: number,
              tailChunk?: Uint8Array,
            ) {
              super(length, initialData, false);
              this.tailOffset = tailOffset ?? length;
              this.tailChunk = tailChunk;
            }

            override requestDataRange(begin: number, end: number) {
              if (this.aborted) {
                return;
              }
              if (
                this.tailChunk &&
                begin >= this.tailOffset &&
                end <= this.tailOffset + this.tailChunk.byteLength
              ) {
                this.onDataRange(
                  begin,
                  this.tailChunk.slice(begin - this.tailOffset, end - this.tailOffset),
                );
                return;
              }
              const key = `${begin}:${end}`;
              const existing = this.inFlight.get(key);
              const pending =
                existing ??
                readDownloadRange(record.id, begin, end).finally(() => {
                  this.inFlight.delete(key);
                });
              if (!existing) {
                this.inFlight.set(key, pending);
              }
              void pending
                .then((chunk) => {
                  if (!this.aborted) {
                    this.onDataRange(begin, existing ? chunk.slice() : chunk);
                  }
                })
                .catch((error: unknown) => {
                  if (!this.aborted && live) {
                    const message =
                      error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : "Unable to read PDF byte range.";
                    setProblem(message);
                    setRendering(false);
                    this.abort();
                    void loadingTask?.destroy();
                  }
                });
            }

            override abort() {
              this.aborted = true;
              this.inFlight.clear();
            }
          }

          rangeTransport = new TauriPdfRangeTransport(
            head.totalSize,
            head.initialChunk.slice(),
            head.tailOffset,
            head.tailChunk?.slice(),
          );
          loadingTask = pdfjs.getDocument({
            range: rangeTransport,
            rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
            disableAutoFetch: true,
            disableStream: true,
          });
        }

        const loaded = await loadingTask.promise;
        if (!live) {
          void loadingTask.destroy();
          return;
        }
        setPdfDocument(loaded);
        setPages(loaded.numPages);
      })
      .catch((error: unknown) => {
        if (live) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "PDF preview could not be rendered.";
          setProblem(message);
          setRendering(false);
        }
      });

    return () => {
      live = false;
      setPdfDocument(null);
      rangeTransport?.abort();
      if (loadingTask) {
        void loadingTask.destroy();
      }
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
    };
  }, [demo, record.id]);

  useEffect(() => {
    if (demo || !pdfDocument || !canvas.current) {
      return;
    }
    let live = true;
    let renderTask: RenderTask | null = null;
    let activePage: PDFPageProxy | null = null;
    let prefetchHandle: number | null = null;
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let usedIdleCallback = false;

    setRendering(true);
    setProblem(null);

    void pdfDocument
      .getPage(Math.min(page, pdfDocument.numPages))
      .then(async (pdfPage) => {
        activePage = pdfPage;
        if (!live) {
          pdfPage.cleanup();
          return;
        }
        const targetPage = Math.min(page, pdfDocument.numPages);
        if (targetPage !== page) {
          setPage(targetPage);
        }

        const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
        const targetScale = computePdfScale({
          fitMode,
          manualZoomPercent: zoom,
          pageWidth: baseViewport.width,
          pageHeight: baseViewport.height,
          containerWidth: containerSize.width,
          containerHeight: containerSize.height,
          minZoomPercent: MIN_ZOOM_PERCENT,
          maxZoomPercent: MAX_ZOOM_PERCENT,
        });
        setDisplayedZoom(Math.round(targetScale * 100));

        const requestedViewport = pdfPage.getViewport({ scale: targetScale, rotation });
        const displayScale = Math.min(
          1,
          MAX_CANVAS_DIMENSION / requestedViewport.width,
          MAX_CANVAS_DIMENSION / requestedViewport.height,
        );
        const viewport = pdfPage.getViewport({
          scale: targetScale * displayScale,
          rotation,
        });
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
        if (!live) {
          return;
        }
        setRendering(false);

        const nextPage = targetPage + 1;
        if (nextPage <= pdfDocument.numPages) {
          const schedulePrefetch = () => {
            if (!live) {
              return;
            }
            void pdfDocument.getPage(nextPage).catch(() => {});
          };
          if (win.requestIdleCallback) {
            usedIdleCallback = true;
            prefetchHandle = win.requestIdleCallback(schedulePrefetch, { timeout: 300 });
          } else {
            prefetchHandle = window.setTimeout(schedulePrefetch, 120);
          }
        }
      })
      .catch((error: unknown) => {
        if ((error as { name?: string })?.name === "RenderingCancelledException") {
          return;
        }
        if (live) {
          const message =
            error instanceof Error && error.message
              ? error.message
              : typeof error === "string" && error
                ? error
                : "PDF preview could not be rendered.";
          setProblem(message);
          setRendering(false);
        }
      });

    return () => {
      live = false;
      if (prefetchHandle !== null) {
        if (usedIdleCallback && win.cancelIdleCallback) {
          win.cancelIdleCallback(prefetchHandle);
        } else {
          window.clearTimeout(prefetchHandle);
        }
      }
      renderTask?.cancel();
      activePage?.cleanup();
    };
  }, [containerSize, demo, fitMode, page, pdfDocument, rotation, zoom]);

  function commitPageDraft() {
    const nextPage = clampPdfPage(pageDraft, pages);
    setPage(nextPage);
    setPageDraft(String(nextPage));
  }

  function stepZoom(delta: number) {
    const base = fitMode === "manual" ? zoom : displayedZoom;
    setFitMode("manual");
    setZoom(Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, base + delta)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (demo || event.nativeEvent.isComposing) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        stepZoom(15);
      } else if (event.key === "-") {
        event.preventDefault();
        stepZoom(-15);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (event.key === "PageDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setPage((current) => Math.min(pages, current + 1));
    } else if (event.key === "PageUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setPage((current) => Math.max(1, current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setPage(1);
    } else if (event.key === "End") {
      event.preventDefault();
      setPage(pages);
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      setRotation((current) => nextPdfRotation(current));
    }
  }

  const shownZoom = fitMode === "manual" ? zoom : displayedZoom;

  return (
    <div className="pdf-view" onKeyDown={handleKeyDown} ref={rootRef} tabIndex={0}>
      <div className="document-toolbar">
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            Previous
          </button>
          <span className="page-jump">
            Page
            <input
              aria-label="Current page number"
              className="page-jump-input"
              disabled={demo || pages <= 1}
              inputMode="numeric"
              onBlur={commitPageDraft}
              onChange={(event) => setPageDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitPageDraft();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  setPageDraft(String(page));
                  event.currentTarget.blur();
                }
              }}
              value={pageDraft}
            />
            of {pages}
          </span>
          <button
            disabled={page >= pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
          >
            Next
          </button>
          {!demo && record.sizeBytes > 0 ? (
            <span className="pdf-meta-note">{formatBytes(record.sizeBytes)}</span>
          ) : null}
        </div>
        <div className="zoom-control">
          <button
            aria-pressed={fitMode === "width"}
            className={fitMode === "width" ? "active" : undefined}
            disabled={demo}
            onClick={() => setFitMode((current) => (current === "width" ? "manual" : "width"))}
            title="Fit page width to pane"
          >
            Fit width
          </button>
          <button
            aria-pressed={fitMode === "page"}
            className={fitMode === "page" ? "active" : undefined}
            disabled={demo}
            onClick={() => setFitMode((current) => (current === "page" ? "manual" : "page"))}
            title="Fit full page inside pane"
          >
            Fit page
          </button>
          <button
            disabled={demo}
            onClick={() => setRotation((current) => nextPdfRotation(current))}
            title="Rotate 90° clockwise (R)"
          >
            Rotate{rotation ? ` ${rotation}°` : ""}
          </button>
          <button disabled={demo} onClick={() => stepZoom(-15)} title="Zoom out (Ctrl+-)">
            -
          </button>
          <span>{shownZoom}%</span>
          <button disabled={demo} onClick={() => stepZoom(15)} title="Zoom in (Ctrl++)">
            +
          </button>
        </div>
      </div>
      {problem ? (
        <div className="preview-error preview-status">
          <strong>Preview unavailable</strong>
          <p>{problem}</p>
        </div>
      ) : null}
      <div
        className="pdf-canvas"
        onClick={() => rootRef.current?.focus({ preventScroll: true })}
        ref={canvasWrap}
      >
        {demo ? (
          <DemoPdf fileName={record.fileName} />
        ) : (
          <canvas ref={canvas} aria-label="PDF page preview" />
        )}
        {rendering && !problem ? (
          <div className="rendering-badge" role="status">
            Rendering page...
          </div>
        ) : null}
      </div>
    </div>
  );
});

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
