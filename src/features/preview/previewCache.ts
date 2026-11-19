import { previewSpreadsheet, readDownload } from "../../lib/desktop";
import type { DownloadRecord, WorkbookPreview } from "../../types";
import {
  applyTint,
  cssColor,
  formatExcelNumber,
  hasZipHeader,
  normalizeLegacyWorkbook,
  parseStyledExcelBuffer,
  PreviewSafetyError,
  toColumnLabel,
} from "./excelFormatting";

export { applyTint, cssColor, formatExcelNumber, parseStyledExcelBuffer, toColumnLabel };

export const PDF_PREVIEW_BYTE_LIMIT = 128 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024;

const PDF_CACHE_BYTE_LIMIT = 256 * 1024 * 1024;
const SPREADSHEET_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const SPREADSHEET_CACHE_ENTRY_LIMIT = 6;
const STYLED_EXCEL_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);

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
  ready: boolean;
  sizeBytes: number;
};

const pdfCache = new Map<string, PdfCacheEntry>();
const spreadsheetCache = new Map<string, SpreadsheetCacheEntry>();

export function loadCachedPdfBytes(record: DownloadRecord): Promise<Uint8Array | null> {
  if (record.sizeBytes > PDF_PREVIEW_BYTE_LIMIT) {
    return Promise.reject(
      new Error(
        `This PDF is ${formatBytes(record.sizeBytes)}. In-app preview supports PDFs up to 128 MB; you can still open it in Windows.`,
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

export function loadCachedSpreadsheetPreview(
  record: DownloadRecord,
): Promise<WorkbookPreview | null> {
  const cached = spreadsheetCache.get(record.id);
  if (cached) {
    cached.accessedAt = Date.now();
    return cached.ready ? Promise.resolve(cached.preview) : cached.promise;
  }
  const entry: SpreadsheetCacheEntry = {
    accessedAt: Date.now(),
    preview: null,
    promise: loadSpreadsheetPreview(record),
    ready: false,
    sizeBytes: 0,
  };
  entry.promise = entry.promise
    .then((preview) => {
      entry.preview = preview;
      entry.ready = true;
      entry.sizeBytes = estimatePreviewSize(preview);
      evictSpreadsheetCache();
      return preview;
    })
    .catch((error) => {
      spreadsheetCache.delete(record.id);
      throw error;
    });
  spreadsheetCache.set(record.id, entry);
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

function evictSpreadsheetCache() {
  let readyEntries = [...spreadsheetCache.values()].filter((entry) => entry.ready);
  let total = readyEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (
    readyEntries.length <= SPREADSHEET_CACHE_ENTRY_LIMIT &&
    total <= SPREADSHEET_CACHE_BYTE_LIMIT
  ) {
    return;
  }
  const oldest = [...spreadsheetCache.entries()]
    .filter(([, entry]) => entry.ready)
    .sort(([, first], [, second]) => first.accessedAt - second.accessedAt);
  for (const [id, entry] of oldest) {
    if (
      readyEntries.length <= SPREADSHEET_CACHE_ENTRY_LIMIT &&
      total <= SPREADSHEET_CACHE_BYTE_LIMIT
    ) {
      break;
    }
    spreadsheetCache.delete(id);
    total -= entry.sizeBytes;
    readyEntries = readyEntries.filter((candidate) => candidate !== entry);
  }
}

function estimatePreviewSize(preview: WorkbookPreview | null): number {
  if (!preview) {
    return 0;
  }
  let bytes = 0;
  for (const sheet of preview.sheets) {
    bytes += sheet.rows.length * sheet.columns.length * 64;
    if (sheet.images) {
      for (const image of sheet.images) {
        bytes += image.dataUrl.length * 2;
      }
    }
  }
  return bytes;
}

async function loadSpreadsheetPreview(record: DownloadRecord): Promise<WorkbookPreview | null> {
  if (record.sizeBytes > SPREADSHEET_PREVIEW_BYTE_LIMIT) {
    throw new Error(
      `This spreadsheet is ${formatBytes(record.sizeBytes)}. In-app preview supports spreadsheets up to 64 MB; you can still open it in Windows.`,
    );
  }
  const extension = record.extension.toLowerCase();
  if (STYLED_EXCEL_EXTENSIONS.has(extension) || extension === "xls") {
    try {
      const styled = await loadStyledExcelPreview(record, extension === "xls");
      if (styled) {
        return styled;
      }
    } catch (error) {
      if (error instanceof PreviewSafetyError) {
        throw error;
      }
      // Calamine remains a useful fallback for legacy BIFF .xls or unusual workbooks.
    }
  }
  const preview = await previewSpreadsheet(record.id);
  return preview ? normalizeLegacyWorkbook(preview as unknown) : null;
}

async function loadStyledExcelPreview(
  record: DownloadRecord,
  requireZipHeader = false,
): Promise<WorkbookPreview | null> {
  const bytes = await readDownload(record.id);
  if (!bytes) {
    return null;
  }
  if (requireZipHeader && !hasZipHeader(bytes)) {
    return null;
  }
  return parseStyledExcelBuffer(bytes);
}
