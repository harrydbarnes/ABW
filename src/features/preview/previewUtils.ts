import type { WorkbookPreview } from "../../types";

export const PDF_PREVIEW_BYTE_LIMIT = 128 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024;
export const PDF_CACHE_BYTE_LIMIT = 16 * 1024 * 1024;
export const PDF_CACHE_ENTRY_BYTE_LIMIT = 4 * 1024 * 1024;
export const SPREADSHEET_CACHE_BYTE_LIMIT = 24 * 1024 * 1024;
export const SPREADSHEET_CACHE_ENTRY_LIMIT = 6;

export type PdfFitMode = "width" | "page" | "manual";

export function nextPdfRotation(rotation: number): number {
  const normalized = ((Math.trunc(rotation) % 360) + 360) % 360;
  return (normalized + 90) % 360;
}

export function computePdfScale({
  fitMode,
  manualZoomPercent,
  pageWidth,
  pageHeight,
  containerWidth,
  containerHeight,
  horizontalPadding = 56,
  verticalPadding = 56,
  minZoomPercent = 40,
  maxZoomPercent = 260,
}: {
  fitMode: PdfFitMode;
  manualZoomPercent: number;
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  containerHeight: number;
  horizontalPadding?: number;
  verticalPadding?: number;
  minZoomPercent?: number;
  maxZoomPercent?: number;
}): number {
  const clamp = (scale: number) =>
    Math.max(minZoomPercent / 100, Math.min(maxZoomPercent / 100, scale));

  if (fitMode === "width" && containerWidth > 0) {
    const availableWidth = Math.max(240, containerWidth - horizontalPadding);
    return clamp(availableWidth / Math.max(1, pageWidth));
  }

  if (fitMode === "page" && containerWidth > 0 && containerHeight > 0) {
    const availableWidth = Math.max(240, containerWidth - horizontalPadding);
    const availableHeight = Math.max(200, containerHeight - verticalPadding);
    const widthScale = availableWidth / Math.max(1, pageWidth);
    const heightScale = availableHeight / Math.max(1, pageHeight);
    return clamp(Math.min(widthScale, heightScale));
  }

  return clamp(manualZoomPercent / 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function clampPdfPage(raw: string | number, totalPages: number): number {
  const maxPage = Math.max(1, Math.floor(totalPages) || 1);
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(maxPage, Math.floor(parsed));
}

export function estimatePreviewSize(preview: WorkbookPreview | null): number {
  if (!preview) {
    return 0;
  }
  let bytes = 64 + (preview.styles?.length ?? 0) * 128;
  for (const sheet of preview.sheets) {
    bytes += 128 + sheet.name.length * 2 + sheet.columns.length * 48;
    for (const row of sheet.rows) {
      bytes += 48 + row.cells.length * 64;
      for (const cell of row.cells) {
        bytes += (cell.value?.length ?? 0) * 2;
        if (cell.styleIndex !== undefined) {
          bytes += 8;
        }
      }
    }
  }
  return bytes;
}

export function toColumnLabel(index: number): string {
  let label = "";
  let remainder = index;
  while (remainder > 0) {
    const letter = (remainder - 1) % 26;
    label = String.fromCharCode(65 + letter) + label;
    remainder = Math.floor((remainder - letter - 1) / 26);
  }
  return label;
}

export interface LruCacheEntry {
  accessedAt: number;
  ready: boolean;
  sizeBytes: number;
}

export function evictLruEntries<T extends LruCacheEntry>(
  cache: Map<string, T>,
  maxBytes: number,
  maxEntries: number = Number.POSITIVE_INFINITY,
): string[] {
  const readyEntries: Array<[string, T]> = [];
  let totalBytes = 0;
  for (const [id, entry] of cache.entries()) {
    totalBytes += entry.sizeBytes;
    if (entry.ready) {
      readyEntries.push([id, entry]);
    }
  }
  if (readyEntries.length <= maxEntries && totalBytes <= maxBytes) {
    return [];
  }
  readyEntries.sort(([, first], [, second]) => first.accessedAt - second.accessedAt);
  let readyCount = readyEntries.length;
  const evicted: string[] = [];
  for (const [id, entry] of readyEntries) {
    if (readyCount <= maxEntries && totalBytes <= maxBytes) {
      break;
    }
    cache.delete(id);
    evicted.push(id);
    totalBytes -= entry.sizeBytes;
    readyCount -= 1;
  }
  return evicted;
}

export interface PdfHeadLike {
  totalSize: number;
  initialChunk: Uint8Array;
  tailOffset?: number;
  tailChunk?: Uint8Array;
  complete: boolean;
}

export interface PreviewCacheRecord {
  id: string;
  sizeBytes: number;
}

export function createPreviewCache<
  TRecord extends PreviewCacheRecord = PreviewCacheRecord,
  TPdfHead extends PdfHeadLike = PdfHeadLike,
  TSpreadsheet extends WorkbookPreview = WorkbookPreview,
>({
  readPdfHead,
  readSpreadsheet,
}: {
  readPdfHead: (id: string) => Promise<TPdfHead | null>;
  readSpreadsheet: (record: TRecord) => Promise<TSpreadsheet | null>;
}) {
  type PdfEntry = LruCacheEntry & {
    head: TPdfHead | null;
    promise: Promise<TPdfHead | null>;
  };
  type SpreadsheetEntry = LruCacheEntry & {
    preview: TSpreadsheet | null;
    promise: Promise<TSpreadsheet | null>;
  };

  const pdfCache = new Map<string, PdfEntry>();
  const spreadsheetCache = new Map<string, SpreadsheetEntry>();

  function evictById(id: string) {
    pdfCache.delete(id);
    spreadsheetCache.delete(id);
  }

  function loadPdfHead(record: TRecord): Promise<TPdfHead | null> {
    if (record.sizeBytes > PDF_PREVIEW_BYTE_LIMIT) {
      return Promise.reject(
        new Error(
          `This PDF is ${formatBytes(record.sizeBytes)}. In-app preview supports PDFs up to 128 MB; you can still open it in Windows.`,
        ),
      );
    }
    if (record.sizeBytes > PDF_CACHE_ENTRY_BYTE_LIMIT) {
      return readPdfHead(record.id);
    }
    const cached = pdfCache.get(record.id);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.ready ? Promise.resolve(cached.head) : cached.promise;
    }
    const entry: PdfEntry = {
      accessedAt: Date.now(),
      head: null,
      promise: readPdfHead(record.id),
      ready: false,
      sizeBytes: record.sizeBytes,
    };
    entry.promise = entry.promise
      .then((head) => {
        const totalChunkBytes =
          (head?.initialChunk.byteLength ?? 0) + (head?.tailChunk?.byteLength ?? 0);
        if (!head || totalChunkBytes > PDF_CACHE_ENTRY_BYTE_LIMIT) {
          pdfCache.delete(record.id);
          return head;
        }
        entry.head = head;
        entry.ready = true;
        entry.sizeBytes = totalChunkBytes;
        evictLruEntries(pdfCache, PDF_CACHE_BYTE_LIMIT);
        return head;
      })
      .catch((error) => {
        pdfCache.delete(record.id);
        throw error;
      });
    pdfCache.set(record.id, entry);
    return entry.promise;
  }

  function loadSpreadsheetPreview(record: TRecord): Promise<TSpreadsheet | null> {
    const cached = spreadsheetCache.get(record.id);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.ready ? Promise.resolve(cached.preview) : cached.promise;
    }
    const entry: SpreadsheetEntry = {
      accessedAt: Date.now(),
      preview: null,
      promise: readSpreadsheet(record),
      ready: false,
      sizeBytes: 0,
    };
    entry.promise = entry.promise
      .then((preview) => {
        entry.preview = preview;
        entry.ready = true;
        entry.sizeBytes = estimatePreviewSize(preview);
        evictLruEntries(
          spreadsheetCache,
          SPREADSHEET_CACHE_BYTE_LIMIT,
          SPREADSHEET_CACHE_ENTRY_LIMIT,
        );
        return preview;
      })
      .catch((error) => {
        spreadsheetCache.delete(record.id);
        throw error;
      });
    spreadsheetCache.set(record.id, entry);
    return entry.promise;
  }

  return {
    evictById,
    loadPdfHead,
    loadSpreadsheetPreview,
    pdfCacheSize: () => pdfCache.size,
    spreadsheetCacheSize: () => spreadsheetCache.size,
  };
}
