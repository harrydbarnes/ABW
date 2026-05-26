import { lazy, Suspense, useEffect, useState } from "react";
import { openDownload, openSourceTask, readDownload } from "../../lib/desktop";
import type { DownloadRecord } from "../../types";

const SpreadsheetPreview = lazy(() => import("./SpreadsheetPreview"));
const PdfPreview = lazy(() => import("./PdfPreview"));

export default function PreviewPanel({ record }: { record: DownloadRecord | null }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBytes(null);
    setError(null);
    if (!record || record.demo || record.kind !== "pdf") {
      return () => {
        live = false;
      };
    }
    void readDownload(record.id)
      .then((result) => {
        if (live) {
          setBytes(result);
        }
      })
      .catch(() => {
        if (live) {
          setError("This file could not be read for preview.");
        }
      });
    return () => {
      live = false;
    };
  }, [record]);

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
      {error ? <div className="preview-error">{error}</div> : null}
      <Suspense fallback={<div className="document-loading">Preparing preview...</div>}>
        {record.kind === "spreadsheet" ? (
          <SpreadsheetPreview id={record.id} demo={!!record.demo} />
        ) : record.kind === "pdf" ? (
          <PdfPreview bytes={bytes} demo={!!record.demo} fileName={record.fileName} />
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
