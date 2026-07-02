import { lazy, Suspense, useEffect, useState } from "react";
import { openDownload, openSourceTask } from "../../lib/desktop";
import type { DownloadRecord } from "../../types";
import { formatBytes, loadCachedPdfBytes, PDF_PREVIEW_BYTE_LIMIT } from "./previewCache";

const SpreadsheetPreview = lazy(() => import("./SpreadsheetPreview"));
const PdfPreview = lazy(() => import("./PdfPreview"));

export default function PreviewPanel({ record }: { record: DownloadRecord | null }) {
  const [pdfState, setPdfState] = useState<
    | { status: "idle"; bytes: null; error: null }
    | { status: "loading"; bytes: null; error: null }
    | { status: "ready"; bytes: Uint8Array | null; error: null }
    | { status: "error"; bytes: null; error: string }
  >({ status: "idle", bytes: null, error: null });

  useEffect(() => {
    let live = true;
    if (!record || record.demo || record.kind !== "pdf") {
      setPdfState({ status: "idle", bytes: null, error: null });
      return () => {
        live = false;
      };
    }
    if (record.sizeBytes > PDF_PREVIEW_BYTE_LIMIT) {
      setPdfState({
        status: "error",
        bytes: null,
        error: `This PDF is ${formatBytes(record.sizeBytes)}. Open it in Windows; in-app preview supports PDFs up to 128 MB.`,
      });
      return () => {
        live = false;
      };
    }
    setPdfState({ status: "loading", bytes: null, error: null });
    void loadCachedPdfBytes(record)
      .then((result) => {
        if (live) {
          setPdfState({ status: "ready", bytes: result, error: null });
        }
      })
      .catch((problem: unknown) => {
        if (live) {
          const message =
            problem instanceof Error
              ? problem.message
              : typeof problem === "string"
                ? problem
                : "This PDF could not be read for preview.";
          setPdfState({ status: "error", bytes: null, error: message });
        }
      });
    return () => {
      live = false;
    };
  }, [record?.id, record?.kind, record?.sizeBytes, record?.demo]);

  if (!record) {
    return (
      <section className="preview-panel preview-empty">
        <h2>Select a file</h2>
        <p>Choose a downloaded PDF or spreadsheet to preview it here.</p>
      </section>
    );
  }

  return (
    <section className="preview-panel" aria-label={`Preview of ${record.fileName}`}>
      <header className="preview-header">
        <div className="preview-title">
          <h2>{record.fileName}</h2>
          <button className="inline-link" onClick={() => void openSourceTask(record)}>
            {record.sourceLabel}
          </button>
        </div>
        <div className="preview-actions">
          <button className="secondary" onClick={() => void openSourceTask(record)}>
            Open task
          </button>
          <button className="primary" onClick={() => void openDownload(record.id)}>
            Open in Windows
          </button>
        </div>
      </header>
      <Suspense fallback={<div className="document-loading">Preparing preview...</div>}>
        {record.kind === "spreadsheet" ? (
          <SpreadsheetPreview record={record} demo={!!record.demo} />
        ) : record.kind === "pdf" ? (
          pdfState.status === "loading" || (pdfState.status === "idle" && !record.demo) ? (
            <PreviewLoading
              title="Loading PDF preview"
              detail={
                record.sizeBytes > 100 * 1024 * 1024
                  ? `${formatBytes(record.sizeBytes)} can take a moment the first time. It will be cached after loading.`
                  : "This file will be cached after the first load."
              }
            />
          ) : pdfState.status === "error" ? (
            <PreviewError message={pdfState.error} />
          ) : (
            <PdfPreview bytes={pdfState.bytes} demo={!!record.demo} fileName={record.fileName} />
          )
        ) : (
          <div className="unsupported-preview">
            <h3>No in-app preview available</h3>
            <p>Open this document in its Windows application to continue.</p>
          </div>
        )}
      </Suspense>
    </section>
  );
}

function PreviewLoading({ detail, title }: { detail: string; title: string }) {
  return (
    <div className="document-loading preview-status">
      <span className="preview-spinner" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  return (
    <div className="preview-error preview-status">
      <strong>Preview unavailable</strong>
      <p>{message}</p>
    </div>
  );
}
