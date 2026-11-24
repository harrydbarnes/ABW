import { lazy, memo, Suspense } from "react";
import { openDownload, openSourceTask } from "../../lib/desktop";
import type { DownloadRecord } from "../../types";
import { formatBytes, PDF_PREVIEW_BYTE_LIMIT } from "./previewCache";

const SpreadsheetPreview = lazy(() => import("./SpreadsheetPreview"));
const PdfPreview = lazy(() => import("./PdfPreview"));
const ImagePreview = lazy(() => import("./ImagePreview"));

const IMAGE_PREVIEW_BYTE_LIMIT = 32 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

export default memo(function PreviewPanel({
  record,
  onOpenSourceTask,
  onRevealDownload,
  onDeleteDownload,
}: {
  record: DownloadRecord | null;
  onOpenSourceTask?: (record: DownloadRecord) => void;
  onRevealDownload?: (id: string) => void;
  onDeleteDownload?: (record: DownloadRecord) => void;
}) {
  function handleOpenTask(target: DownloadRecord) {
    if (onOpenSourceTask) {
      onOpenSourceTask(target);
      return;
    }
    void openSourceTask(target);
  }

  if (!record) {
    return (
      <section className="preview-panel preview-empty">
        <h2>Select a file</h2>
        <p>Choose a downloaded PDF or spreadsheet to preview it here.</p>
      </section>
    );
  }

  const isImage =
    record.kind === "image" || IMAGE_EXTENSIONS.has(record.extension.trim().toLowerCase());
  const pdfTooLarge = record.kind === "pdf" && !record.demo && record.sizeBytes > PDF_PREVIEW_BYTE_LIMIT;
  const imageTooLarge = isImage && !record.demo && record.sizeBytes > IMAGE_PREVIEW_BYTE_LIMIT;

  return (
    <section className="preview-panel" aria-label={`Preview of ${record.fileName}`}>
      <header className="preview-header">
        <div className="preview-title">
          <h2 title={record.fileName}>{record.fileName}</h2>
          <button
            className="inline-link"
            onClick={() => handleOpenTask(record)}
            title={record.sourceLabel}
          >
            {record.sourceLabel}
          </button>
        </div>
        <div className="preview-actions">
          <button className="secondary" onClick={() => handleOpenTask(record)}>
            Open task
          </button>
          {onRevealDownload ? (
            <button
              className="secondary"
              disabled={!!record.demo}
              onClick={() => onRevealDownload(record.id)}
            >
              Show in folder
            </button>
          ) : null}
          {onDeleteDownload ? (
            <button
              className="secondary danger"
              disabled={!!record.demo}
              onClick={() => onDeleteDownload(record)}
            >
              Remove
            </button>
          ) : null}
          <button className="primary" onClick={() => void openDownload(record.id)}>
            Open in Windows
          </button>
        </div>
      </header>
      <Suspense fallback={<div className="document-loading">Preparing preview...</div>}>
        {record.kind === "spreadsheet" ? (
          <SpreadsheetPreview record={record} demo={!!record.demo} />
        ) : record.kind === "pdf" ? (
          pdfTooLarge ? (
            <PreviewError
              message={`This PDF is ${formatBytes(record.sizeBytes)}. Open it in Windows; in-app preview supports PDFs up to 128 MB.`}
            />
          ) : (
            <PdfPreview demo={!!record.demo} record={record} />
          )
        ) : isImage ? (
          imageTooLarge ? (
            <PreviewError
              message={`This image is ${formatBytes(record.sizeBytes)}. Open it in Windows; in-app image preview supports files up to 32 MB.`}
            />
          ) : (
            <ImagePreview demo={!!record.demo} record={record} />
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
});

function PreviewError({ message }: { message: string }) {
  return (
    <div className="preview-error preview-status">
      <strong>Preview unavailable</strong>
      <p>{message}</p>
    </div>
  );
}
