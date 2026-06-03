import { previewSpreadsheet, readDownload } from "../../lib/desktop";
import type { DownloadRecord, WorkbookPreview } from "../../types";

export const PDF_PREVIEW_BYTE_LIMIT = 512 * 1024 * 1024;

const PDF_CACHE_BYTE_LIMIT = 512 * 1024 * 1024;

type PdfCacheEntry = {
  accessedAt: number;
  bytes: Uint8Array | null;
  promise: Promise<Uint8Array | null>;
  sizeBytes: number;
};

type SpreadsheetCacheEntry = {
  accessedAt: number;
  promise: Promise<WorkbookPreview | null>;
  preview: WorkbookPreview | null;
};

const pdfCache = new Map<string, PdfCacheEntry>();
const spreadsheetCache = new Map<string, SpreadsheetCacheEntry>();

export function loadCachedPdfBytes(record: DownloadRecord): Promise<Uint8Array | null> {
  if (record.sizeBytes > PDF_PREVIEW_BYTE_LIMIT) {
    return Promise.reject(
      new Error(
        `This PDF is ${formatBytes(record.sizeBytes)}. In-app preview supports PDFs up to 512 MB.`,
      ),
    );
  }
  const cached = pdfCache.get(record.id);
  if (cached) {
    cached.accessedAt = Date.now();
    return cached.bytes ? Promise.resolve(cached.bytes) : cached.promise;
  }
  const entry: PdfCacheEntry = {
    accessedAt: Date.now(),
    bytes: null,
    promise: readDownload(record.id),
    sizeBytes: record.sizeBytes,
  };
  entry.promise = entry.promise
    .then((bytes) => {
      entry.bytes = bytes;
      entry.sizeBytes = bytes?.byteLength ?? record.sizeBytes;
      evictPdfCache();
      return bytes;
    })
    .catch((error) => {
      pdfCache.delete(record.id);
      throw error;
    });
  pdfCache.set(record.id, entry);
  return entry.promise;
}

export function loadCachedSpreadsheetPreview(id: string): Promise<WorkbookPreview | null> {
  const cached = spreadsheetCache.get(id);
  if (cached) {
    cached.accessedAt = Date.now();
    return cached.preview ? Promise.resolve(cached.preview) : cached.promise;
  }
  const entry: SpreadsheetCacheEntry = {
    accessedAt: Date.now(),
    preview: null,
    promise: previewSpreadsheet(id),
  };
  entry.promise = entry.promise
    .then((preview) => {
      entry.preview = preview;
      return preview;
    })
    .catch((error) => {
      spreadsheetCache.delete(id);
      throw error;
    });
  spreadsheetCache.set(id, entry);
  return entry.promise;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function evictPdfCache() {
  let total = [...pdfCache.values()].reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (total <= PDF_CACHE_BYTE_LIMIT) {
    return;
  }
  const oldest = [...pdfCache.entries()].sort(
    ([, first], [, second]) => first.accessedAt - second.accessedAt,
  );
  for (const [id, entry] of oldest) {
    if (total <= PDF_CACHE_BYTE_LIMIT) {
      break;
    }
    if (!entry.bytes) {
      continue;
    }
    pdfCache.delete(id);
    total -= entry.sizeBytes;
  }
}
