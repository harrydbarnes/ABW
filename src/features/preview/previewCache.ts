import { previewSpreadsheet, readDownloadHead, type PdfHeadResult } from "../../lib/desktop";
import type { DownloadRecord, WorkbookPreview } from "../../types";
import {
  createPreviewCache,
  formatBytes,
  PDF_PREVIEW_BYTE_LIMIT,
  SPREADSHEET_PREVIEW_BYTE_LIMIT,
  toColumnLabel,
} from "./previewUtils";

export { formatBytes, PDF_PREVIEW_BYTE_LIMIT, SPREADSHEET_PREVIEW_BYTE_LIMIT, toColumnLabel };

const previewCache = createPreviewCache<DownloadRecord, PdfHeadResult, WorkbookPreview>({
  readPdfHead: readDownloadHead,
  readSpreadsheet: loadSpreadsheetPreview,
});

export function evictPreviewById(id: string) {
  previewCache.evictById(id);
}

export function getPreviewCacheStats() {
  return previewCache.getStats();
}

export function clearAllPreviewCaches() {
  previewCache.clear();
}

export function loadCachedPdfHead(record: DownloadRecord): Promise<PdfHeadResult | null> {
  return previewCache.loadPdfHead(record);
}

export function loadCachedSpreadsheetPreview(
  record: DownloadRecord,
): Promise<WorkbookPreview | null> {
  return previewCache.loadSpreadsheetPreview(record);
}

async function loadSpreadsheetPreview(record: DownloadRecord): Promise<WorkbookPreview | null> {
  if (record.sizeBytes > SPREADSHEET_PREVIEW_BYTE_LIMIT) {
    throw new Error(
      `This spreadsheet is ${formatBytes(record.sizeBytes)}. In-app preview supports spreadsheets up to 64 MB; you can still open it in Windows.`,
    );
  }
  return previewSpreadsheet(record.id);
}
