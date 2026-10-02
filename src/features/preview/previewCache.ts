import { previewSpreadsheet, readDownload } from "../../lib/desktop";
import type {
  DownloadRecord,
  WorkbookCell,
  WorkbookColumn,
  WorkbookPreview,
  WorkbookRow,
  WorkbookSheet,
} from "../../types";
import type { Border, Cell, Color, Fill, Worksheet } from "exceljs";

export const PDF_PREVIEW_BYTE_LIMIT = 128 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_BYTE_LIMIT = 64 * 1024 * 1024;

const PDF_CACHE_BYTE_LIMIT = 256 * 1024 * 1024;
const SPREADSHEET_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const SPREADSHEET_CACHE_ENTRY_LIMIT = 6;
const MAX_SPREADSHEET_ARCHIVE_ENTRIES = 2_048;
const MAX_SPREADSHEET_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_SPREADSHEET_COMPRESSION_RATIO = 100;
const MAX_SPREADSHEET_ROWS = 250;
const MAX_SPREADSHEET_COLUMNS = 50;
const MAX_SPREADSHEET_ROW_SCAN = 10_000;
const MAX_SPREADSHEET_COLUMN_SCAN = 2_000;
const STYLED_EXCEL_EXTENSIONS = new Set(["xlsx", "xlsm", "xltx", "xltm"]);

class PreviewSafetyError extends Error {}

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
  if (readyEntries.length <= SPREADSHEET_CACHE_ENTRY_LIMIT && total <= SPREADSHEET_CACHE_BYTE_LIMIT) {
    return;
  }
  const oldest = [...spreadsheetCache.entries()]
    .filter(([, entry]) => entry.ready)
    .sort(([, first], [, second]) => first.accessedAt - second.accessedAt);
  for (const [id, entry] of oldest) {
    if (readyEntries.length <= SPREADSHEET_CACHE_ENTRY_LIMIT && total <= SPREADSHEET_CACHE_BYTE_LIMIT) {
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
  const serialised = JSON.stringify(preview);
  return serialised ? serialised.length * 2 : 0;
}

async function loadSpreadsheetPreview(record: DownloadRecord): Promise<WorkbookPreview | null> {
  if (record.sizeBytes > SPREADSHEET_PREVIEW_BYTE_LIMIT) {
    throw new Error(
      `This spreadsheet is ${formatBytes(record.sizeBytes)}. In-app preview supports spreadsheets up to 64 MB; you can still open it in Windows.`,
    );
  }
  if (STYLED_EXCEL_EXTENSIONS.has(record.extension.toLowerCase())) {
    try {
      const styled = await loadStyledExcelPreview(record);
      if (styled) {
        return styled;
      }
    } catch (error) {
      if (error instanceof PreviewSafetyError) {
        throw error;
      }
      // Calamine remains a useful fallback for unusual or partially damaged workbooks.
    }
  }
  const preview = await previewSpreadsheet(record.id);
  return preview ? normalizeLegacyWorkbook(preview as unknown) : null;
}

async function loadStyledExcelPreview(record: DownloadRecord): Promise<WorkbookPreview | null> {
  const bytes = await readDownload(record.id);
  if (!bytes) {
    return null;
  }
  assertSafeSpreadsheetArchive(bytes);
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);

  const visibleWorksheets = workbook.worksheets.filter((worksheet) => worksheet.state === "visible");
  const activeTab = workbook.views[0]?.activeTab ?? 0;
  const activeWorksheet = workbook.worksheets[activeTab];
  const activeSheet = Math.max(
    0,
    visibleWorksheets.findIndex((worksheet) => worksheet.id === activeWorksheet?.id),
  );

  return {
    activeSheet,
    sheets: visibleWorksheets.map(buildWorksheetPreview),
  };
}

function assertSafeSpreadsheetArchive(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocdSize = 22;
  const eocdSignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new PreviewSafetyError("This spreadsheet archive is invalid or unsupported.");
  }
  const entries = view.getUint16(eocd + 10, true);
  const centralDirectorySize = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);
  if (
    entries > MAX_SPREADSHEET_ARCHIVE_ENTRIES ||
    centralDirectoryOffset + centralDirectorySize > bytes.byteLength
  ) {
    throw new PreviewSafetyError("This spreadsheet is too complex for safe in-app preview.");
  }
  let offset = centralDirectoryOffset;
  let compressedBytes = 0;
  let expandedBytes = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (
      offset + 46 > bytes.byteLength ||
      view.getUint32(offset, true) !== centralDirectorySignature
    ) {
      throw new PreviewSafetyError("This spreadsheet archive is invalid or unsupported.");
    }
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || expanded === 0xffffffff) {
      throw new PreviewSafetyError("ZIP64 spreadsheets are not supported for in-app preview.");
    }
    compressedBytes += compressed;
    expandedBytes += expanded;
    if (
      expandedBytes > MAX_SPREADSHEET_EXPANDED_BYTES ||
      (compressedBytes > 0 && expandedBytes / compressedBytes > MAX_SPREADSHEET_COMPRESSION_RATIO)
    ) {
      throw new PreviewSafetyError("This spreadsheet expands beyond the safe in-app preview limit.");
    }
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
}

function buildWorksheetPreview(worksheet: Worksheet): WorkbookSheet {
  const columnIndexes = collectVisibleIndexes(
    Math.min(worksheet.columnCount, MAX_SPREADSHEET_COLUMN_SCAN),
    MAX_SPREADSHEET_COLUMNS,
    (index) => !worksheet.getColumn(index).hidden,
  );
  const rowIndexes = collectVisibleIndexes(
    Math.min(worksheet.rowCount, MAX_SPREADSHEET_ROW_SCAN),
    MAX_SPREADSHEET_ROWS,
    (index) => !worksheet.getRow(index).hidden,
  );
  const columns: WorkbookColumn[] = columnIndexes.map((index) => {
    const column = worksheet.getColumn(index);
    return {
      index,
      label: toColumnLabel(index),
      widthPx: clamp(Math.round((column.width ?? 12) * 7 + 12), 38, 320),
    };
  });
  const mergeState = buildMergeState(worksheet, rowIndexes, columnIndexes);
  const rows: WorkbookRow[] = rowIndexes.map((index) => {
    const row = worksheet.getRow(index);
    return {
      index,
      heightPx: clamp(Math.round(((row.height ?? 15) * 96) / 72), 20, 180),
      cells: columnIndexes.map((columnIndex) => {
        const key = cellKey(index, columnIndex);
        const cell = worksheet.getCell(index, columnIndex);
        const span = mergeState.spans.get(key);
        return {
          value: cell.text,
          style: cellStyle(cell),
          colSpan: span?.colSpan,
          rowSpan: span?.rowSpan,
          coveredByMerge: mergeState.covered.has(key),
        };
      }),
    };
  });

  return { name: worksheet.name, columns, rows };
}

function collectVisibleIndexes(
  maximum: number,
  limit: number,
  isVisible: (index: number) => boolean,
): number[] {
  const indexes: number[] = [];
  for (let index = 1; index <= maximum && indexes.length < limit; index += 1) {
    if (isVisible(index)) {
      indexes.push(index);
    }
  }
  return indexes;
}

function buildMergeState(
  worksheet: Worksheet,
  rowIndexes: number[],
  columnIndexes: number[],
): {
  covered: Set<string>;
  spans: Map<string, { colSpan: number; rowSpan: number }>;
} {
  const covered = new Set<string>();
  const spans = new Map<string, { colSpan: number; rowSpan: number }>();
  const visibleRows = new Set(rowIndexes);
  const visibleColumns = new Set(columnIndexes);

  for (const merge of worksheet.model.merges ?? []) {
    const range = parseCellRange(merge);
    if (!range || !visibleRows.has(range.startRow) || !visibleColumns.has(range.startColumn)) {
      continue;
    }
    const mergedRows = rowIndexes.filter(
      (index) => index >= range.startRow && index <= range.endRow,
    );
    const mergedColumns = columnIndexes.filter(
      (index) => index >= range.startColumn && index <= range.endColumn,
    );
    if (mergedRows.length === 0 || mergedColumns.length === 0) {
      continue;
    }
    spans.set(cellKey(range.startRow, range.startColumn), {
      colSpan: mergedColumns.length,
      rowSpan: mergedRows.length,
    });
    for (const row of mergedRows) {
      for (const column of mergedColumns) {
        if (row !== range.startRow || column !== range.startColumn) {
          covered.add(cellKey(row, column));
        }
      }
    }
  }
  return { covered, spans };
}

function parseCellRange(value: string) {
  const [start, end = start] = value.replace(/\$/g, "").split(":");
  const startAddress = parseCellAddress(start);
  const endAddress = parseCellAddress(end);
  if (!startAddress || !endAddress) {
    return null;
  }
  return {
    startRow: startAddress.row,
    startColumn: startAddress.column,
    endRow: endAddress.row,
    endColumn: endAddress.column,
  };
}

function parseCellAddress(value: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(value);
  if (!match) {
    return null;
  }
  let column = 0;
  for (const letter of match[1].toUpperCase()) {
    column = column * 26 + letter.charCodeAt(0) - 64;
  }
  return { column, row: Number(match[2]) };
}

function cellStyle(cell: Cell): WorkbookCell["style"] {
  const style: NonNullable<WorkbookCell["style"]> = {};
  const fill = fillColor(cell.fill);
  const color = cssColor(cell.font?.color);
  if (fill) style.backgroundColor = fill;
  if (color) style.color = color;
  if (cell.font?.name) style.fontFamily = cell.font.name;
  if (cell.font?.size) style.fontSize = `${cell.font.size}pt`;
  if (cell.font?.bold) style.fontWeight = 700;
  if (cell.font?.italic) style.fontStyle = "italic";
  if (cell.font?.underline && cell.font.underline !== "none") {
    style.textDecoration = "underline";
  }
  if (cell.font?.strike) {
    style.textDecoration = style.textDecoration
      ? `${style.textDecoration} line-through`
      : "line-through";
  }
  if (cell.alignment?.horizontal) {
    style.textAlign = normalizeHorizontalAlignment(cell.alignment.horizontal);
  }
  if (cell.alignment?.vertical) {
    style.verticalAlign = normalizeVerticalAlignment(cell.alignment.vertical);
  }
  style.whiteSpace = cell.alignment?.wrapText ? "normal" : "nowrap";
  addBorder(style, "Top", cell.border?.top);
  addBorder(style, "Right", cell.border?.right);
  addBorder(style, "Bottom", cell.border?.bottom);
  addBorder(style, "Left", cell.border?.left);
  return Object.keys(style).length > 1 || style.whiteSpace === "normal" ? style : undefined;
}

function fillColor(fill: Fill | undefined): string | undefined {
  if (fill?.type !== "pattern" || fill.pattern !== "solid") {
    return undefined;
  }
  return cssColor(fill.fgColor);
}

function cssColor(color: Partial<Color> | undefined): string | undefined {
  const value = color as { argb?: string; theme?: number } | undefined;
  if (value?.argb) {
    const argb = value.argb.replace(/^#/, "");
    if (argb.length === 8 && argb.slice(0, 2) === "00") {
      return undefined;
    }
    return `#${argb.slice(-6)}`;
  }
  if (typeof value?.theme === "number") {
    return OFFICE_THEME_COLORS[value.theme];
  }
  return undefined;
}

function addBorder(
  style: NonNullable<WorkbookCell["style"]>,
  side: "Top" | "Right" | "Bottom" | "Left",
  border: Partial<Border> | undefined,
) {
  if (!border?.style) {
    return;
  }
  const width = border.style.includes("medium") ? 2 : border.style === "thick" ? 3 : 1;
  const lineStyle = border.style === "double" ? "double" : border.style.includes("dash") ? "dashed" : border.style === "dotted" ? "dotted" : "solid";
  style[`border${side}`] = `${width}px ${lineStyle} ${cssColor(border.color) ?? "#cbd2dc"}`;
}

function normalizeHorizontalAlignment(
  value: NonNullable<Cell["alignment"]>["horizontal"],
): "left" | "center" | "right" | "justify" {
  if (value === "right") return "right";
  if (value === "center" || value === "centerContinuous") return "center";
  if (value === "justify" || value === "distributed") return "justify";
  return "left";
}

function normalizeVerticalAlignment(
  value: NonNullable<Cell["alignment"]>["vertical"],
): "top" | "middle" | "bottom" {
  if (value === "top") return "top";
  if (value === "middle") return "middle";
  return "bottom";
}

function normalizeLegacyWorkbook(preview: unknown): WorkbookPreview {
  const candidate = preview as { sheets?: Array<{ name?: string; rows?: string[][] }> };
  return {
    activeSheet: 0,
    sheets: (candidate.sheets ?? []).map((sheet) => {
      const rows = sheet.rows ?? [];
      const width = rows.reduce((largest, row) => Math.max(largest, row.length), 0);
      return {
        name: sheet.name ?? "Sheet",
        columns: Array.from({ length: width }, (_, index) => ({
          index: index + 1,
          label: toColumnLabel(index + 1),
          widthPx: index === 0 ? 176 : 98,
        })),
        rows: rows.map((cells, index) => ({
          index: index + 1,
          heightPx: 31,
          cells: Array.from({ length: width }, (_, cellIndex) => ({
            value: cells[cellIndex] ?? "",
          })),
        })),
      };
    }),
  };
}

export function toColumnLabel(index: number) {
  let label = "";
  let remainder = index;
  while (remainder > 0) {
    const letter = (remainder - 1) % 26;
    label = String.fromCharCode(65 + letter) + label;
    remainder = Math.floor((remainder - letter - 1) / 26);
  }
  return label;
}

function cellKey(row: number, column: number) {
  return `${row}:${column}`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

const OFFICE_THEME_COLORS: Record<number, string> = {
  0: "#000000",
  1: "#ffffff",
  2: "#44546a",
  3: "#e7e6e6",
  4: "#5b9bd5",
  5: "#ed7d31",
  6: "#a5a5a5",
  7: "#ffc000",
  8: "#4472c4",
  9: "#70ad47",
  10: "#0563c1",
  11: "#954f72",
};
