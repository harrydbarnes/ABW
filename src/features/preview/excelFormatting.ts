import type {
  WorkbookCell,
  WorkbookColumn,
  WorkbookImage,
  WorkbookPreview,
  WorkbookRow,
  WorkbookSheet,
} from "../../types";
import type { Border, Cell, Color, Fill, Workbook, Worksheet } from "exceljs";

const MAX_SPREADSHEET_ARCHIVE_ENTRIES = 2_048;
const MAX_SPREADSHEET_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_SPREADSHEET_COMPRESSION_RATIO = 100;
const MAX_SPREADSHEET_ROWS = 250;
const MAX_SPREADSHEET_COLUMNS = 50;
const MAX_SPREADSHEET_ROW_SCAN = 10_000;
const MAX_SPREADSHEET_COLUMN_SCAN = 2_000;

export class PreviewSafetyError extends Error {}

type MergeSpan = {
  colSpan: number;
  rowSpan: number;
  endRow: number;
  endColumn: number;
};

export function hasZipHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export async function parseStyledExcelBuffer(bytes: Uint8Array): Promise<WorkbookPreview> {
  assertSafeSpreadsheetArchive(bytes);
  const exceljs = await import("exceljs");
  const WorkbookConstructor =
    exceljs.Workbook ??
    (exceljs as { default?: { Workbook?: typeof exceljs.Workbook } }).default?.Workbook;
  if (!WorkbookConstructor) {
    throw new Error("ExcelJS Workbook constructor is unavailable.");
  }
  const workbook = new WorkbookConstructor();
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);

  const themeColors = extractWorkbookThemeColors(workbook);
  const visibleWorksheets = workbook.worksheets.filter(
    (worksheet) => !worksheet.state || worksheet.state === "visible",
  );
  const activeTab = workbook.views?.[0]?.activeTab ?? 0;
  const activeWorksheet = workbook.worksheets[activeTab];
  const activeSheet = Math.max(
    0,
    visibleWorksheets.findIndex((worksheet) => worksheet.id === activeWorksheet?.id),
  );

  return {
    activeSheet,
    sheets: visibleWorksheets.map((worksheet) =>
      buildWorksheetPreview(worksheet, workbook, themeColors),
    ),
  };
}

export function assertSafeSpreadsheetArchive(bytes: Uint8Array) {
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

function buildWorksheetPreview(
  worksheet: Worksheet,
  workbook: Workbook,
  themeColors: Record<number, string>,
): WorkbookSheet {
  const imageBounds = getWorksheetImageBounds(worksheet);
  const maxColScan = Math.min(
    Math.max(worksheet.columnCount, imageBounds.maxColumn),
    MAX_SPREADSHEET_COLUMN_SCAN,
  );
  const maxRowScan = Math.min(
    Math.max(worksheet.rowCount, imageBounds.maxRow),
    MAX_SPREADSHEET_ROW_SCAN,
  );
  const rawColumnIndexes = collectVisibleIndexes(
    maxColScan,
    MAX_SPREADSHEET_COLUMNS,
    (index) => !worksheet.getColumn(index).hidden,
  );
  const rawRowIndexes = collectVisibleIndexes(
    maxRowScan,
    MAX_SPREADSHEET_ROWS,
    (index) => !worksheet.getRow(index).hidden,
  );
  const { rowIndexes, columnIndexes } = trimTrailingEmptyGrid(
    worksheet,
    rawRowIndexes,
    rawColumnIndexes,
    imageBounds,
    themeColors,
  );

  const columns: WorkbookColumn[] = columnIndexes.map((index) => {
    const column = worksheet.getColumn(index);
    return {
      index,
      label: toColumnLabel(index),
      widthPx: clamp(Math.round((column.width ?? 11.5) * 7.2 + 12), 40, 360),
    };
  });
  const mergeState = buildMergeState(worksheet, rowIndexes, columnIndexes);
  const rows: WorkbookRow[] = rowIndexes.map((index) => {
    const row = worksheet.findRow(index);
    return {
      index,
      heightPx: clamp(Math.round(((row?.height ?? 15.75) * 96) / 72), 20, 180),
      cells: columnIndexes.map((columnIndex) => {
        const key = cellKey(index, columnIndex);
        const span = mergeState.spans.get(key);
        const coveredByMerge = mergeState.covered.has(key);
        const cell = row?.findCell(columnIndex);
        if (!cell) {
          return {
            value: "",
            colSpan: span?.colSpan,
            rowSpan: span?.rowSpan,
            coveredByMerge,
          };
        }
        return {
          value: formatCellValue(cell),
          style: cellStyle(worksheet, cell, span, themeColors),
          colSpan: span?.colSpan,
          rowSpan: span?.rowSpan,
          coveredByMerge,
        };
      }),
    };
  });

  propagateSharedBorders(rows);
  const images = extractWorksheetImages(worksheet, workbook, columns, rows);

  return images.length > 0
    ? { name: worksheet.name, columns, rows, images }
    : { name: worksheet.name, columns, rows };
}

function getWorksheetImageBounds(worksheet: Worksheet): { maxRow: number; maxColumn: number } {
  let maxRow = 0;
  let maxColumn = 0;
  for (const image of worksheet.getImages?.() ?? []) {
    const range = image.range as {
      tl?: { row?: number; col?: number; nativeRow?: number; nativeCol?: number };
      br?: { row?: number; col?: number; nativeRow?: number; nativeCol?: number };
    };
    const brRow = range?.br?.row ?? range?.br?.nativeRow ?? range?.tl?.row ?? range?.tl?.nativeRow;
    const brCol = range?.br?.col ?? range?.br?.nativeCol ?? range?.tl?.col ?? range?.tl?.nativeCol;
    if (typeof brRow === "number" && Number.isFinite(brRow)) {
      maxRow = Math.max(maxRow, Math.ceil(brRow) + 1);
    }
    if (typeof brCol === "number" && Number.isFinite(brCol)) {
      maxColumn = Math.max(maxColumn, Math.ceil(brCol) + 1);
    }
  }
  return { maxRow, maxColumn };
}

function trimTrailingEmptyGrid(
  worksheet: Worksheet,
  rowIndexes: number[],
  columnIndexes: number[],
  imageBounds: { maxRow: number; maxColumn: number },
  themeColors: Record<number, string>,
): { rowIndexes: number[]; columnIndexes: number[] } {
  if (rowIndexes.length === 0 || columnIndexes.length === 0) {
    return { rowIndexes, columnIndexes };
  }
  const mergedBounds = { maxRow: imageBounds.maxRow, maxColumn: imageBounds.maxColumn };
  for (const merge of worksheet.model.merges ?? []) {
    const range = parseCellRange(merge);
    if (range) {
      mergedBounds.maxRow = Math.max(mergedBounds.maxRow, range.endRow);
      mergedBounds.maxColumn = Math.max(mergedBounds.maxColumn, range.endColumn);
    }
  }
  const hasCellContentOrStyle = (row: number, column: number) => {
    const cell = worksheet.findRow(row)?.findCell(column);
    if (!cell) {
      return false;
    }
    if (cell.value !== null && cell.value !== undefined && cell.text.trim() !== "") {
      return true;
    }
    if (fillColor(cell.fill, themeColors)) {
      return true;
    }
    const border = cell.border;
    return Boolean(
      border?.top?.style ||
        border?.right?.style ||
        border?.bottom?.style ||
        border?.left?.style,
    );
  };

  let lastRowPos = rowIndexes.length - 1;
  while (lastRowPos > 0) {
    const rowIndex = rowIndexes[lastRowPos];
    if (
      rowIndex <= mergedBounds.maxRow ||
      columnIndexes.some((colIndex) => hasCellContentOrStyle(rowIndex, colIndex))
    ) {
      break;
    }
    lastRowPos -= 1;
  }
  const trimmedRows = rowIndexes.slice(0, lastRowPos + 1);

  let lastColPos = columnIndexes.length - 1;
  while (lastColPos > 0) {
    const colIndex = columnIndexes[lastColPos];
    if (
      colIndex <= mergedBounds.maxColumn ||
      trimmedRows.some((rowIndex) => hasCellContentOrStyle(rowIndex, colIndex))
    ) {
      break;
    }
    lastColPos -= 1;
  }
  const trimmedColumns = columnIndexes.slice(0, lastColPos + 1);

  return { rowIndexes: trimmedRows, columnIndexes: trimmedColumns };
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
  spans: Map<string, MergeSpan>;
} {
  const covered = new Set<string>();
  const spans = new Map<string, MergeSpan>();
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
      endRow: range.endRow,
      endColumn: range.endColumn,
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

function cellStyle(
  worksheet: Worksheet,
  cell: Cell,
  span: MergeSpan | undefined,
  themeColors: Record<number, string>,
): WorkbookCell["style"] {
  const style: NonNullable<WorkbookCell["style"]> = {};
  const fill = fillColor(cell.fill, themeColors);
  const color = cssColor(cell.font?.color, themeColors);
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
  } else if (isNumericOrDateCell(cell)) {
    style.textAlign = "right";
  }
  if (cell.alignment?.vertical) {
    style.verticalAlign = normalizeVerticalAlignment(cell.alignment.vertical);
  }
  style.whiteSpace = cell.alignment?.wrapText ? "normal" : "nowrap";

  const rightBorderCell =
    span && span.endColumn !== Number(cell.col)
      ? worksheet.getCell(Number(cell.row), span.endColumn)
      : cell;
  const bottomBorderCell =
    span && span.endRow !== Number(cell.row)
      ? worksheet.getCell(span.endRow, Number(cell.col))
      : cell;

  addBorder(style, "Top", cell.border?.top, themeColors);
  addBorder(
    style,
    "Right",
    rightBorderCell.border?.right ?? cell.border?.right,
    themeColors,
  );
  addBorder(
    style,
    "Bottom",
    bottomBorderCell.border?.bottom ?? cell.border?.bottom,
    themeColors,
  );
  addBorder(style, "Left", cell.border?.left, themeColors);

  return Object.keys(style).length > 1 || style.whiteSpace === "normal" ? style : undefined;
}

function propagateSharedBorders(rows: WorkbookRow[]) {
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
    const cells = rows[rowIdx].cells;
    for (let colIdx = 0; colIdx < cells.length; colIdx += 1) {
      const current = cells[colIdx];
      if (!current || current.coveredByMerge || !current.style) {
        continue;
      }
      if (current.style.borderTop && rowIdx > 0) {
        const above = rows[rowIdx - 1].cells[colIdx];
        if (above && !above.coveredByMerge && !above.style?.borderBottom) {
          above.style = { ...(above.style ?? {}), borderBottom: current.style.borderTop };
        }
      }
      if (current.style.borderLeft && colIdx > 0) {
        const left = cells[colIdx - 1];
        if (left && !left.coveredByMerge && !left.style?.borderRight) {
          left.style = { ...(left.style ?? {}), borderRight: current.style.borderLeft };
        }
      }
    }
  }
}

function unwrapRawCellValue(value: unknown): unknown {
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const candidate = value as {
      result?: unknown;
      formula?: string;
      sharedFormula?: string;
      richText?: Array<{ text?: string }>;
      text?: string;
    };
    if ("result" in candidate || "formula" in candidate || "sharedFormula" in candidate) {
      return candidate.result ?? "";
    }
    if (Array.isArray(candidate.richText)) {
      return candidate.richText.map((part) => part.text ?? "").join("");
    }
    if (typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return value;
}

function isNumericOrDateCell(cell: Cell): boolean {
  const raw = unwrapRawCellValue(cell.value);
  return (typeof raw === "number" && Number.isFinite(raw)) || raw instanceof Date;
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getCachedNumberFormatter(
  useGrouping: boolean,
  minimumFractionDigits: number,
  maximumFractionDigits: number,
): Intl.NumberFormat {
  const key = `${useGrouping ? 1 : 0}:${minimumFractionDigits}:${maximumFractionDigits}`;
  let formatter = numberFormatCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-GB", {
      useGrouping,
      minimumFractionDigits,
      maximumFractionDigits,
    });
    numberFormatCache.set(key, formatter);
  }
  return formatter;
}

export function formatExcelNumber(value: number, numFmt?: string): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const rawFormat = (numFmt ?? "").trim();
  if (!rawFormat || /^general$/i.test(rawFormat) || rawFormat === "@") {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(Number(value.toPrecision(12)));
  }

  const sections = splitFormatSections(rawFormat);
  let section = sections[0] ?? rawFormat;
  let isNegative = value < 0;
  let hasExplicitNegativeSection = false;

  if (value === 0 && sections.length >= 3) {
    const zeroSection = stripFormatConditions(sections[2]);
    if (!/[0#]/.test(zeroSection)) {
      const currency = extractCurrencySymbol(zeroSection) || extractCurrencySymbol(sections[0]);
      if (zeroSection.includes("-")) {
        return currency ? `${currency}-` : "-";
      }
      const literal = cleanFormatLiterals(zeroSection);
      return literal || "0";
    }
    section = sections[2];
    isNegative = false;
  } else if (value < 0 && sections.length >= 2) {
    section = sections[1];
    hasExplicitNegativeSection = true;
  }

  const cleaned = stripFormatConditions(section);
  const wrapParens = /\([^)]*[0#][^)]*\)/.test(cleaned);
  const isPercent = cleaned.includes("%");
  const currency = extractCurrencySymbol(cleaned);

  let scaled = Math.abs(value);
  if (isPercent) {
    scaled *= 100;
  }

  const numberPatternMatch = cleaned.match(/[0#,]+(?:\.[0#]+)?/);
  const numberPattern = numberPatternMatch ? numberPatternMatch[0] : "0";
  const [intPattern, decPattern = ""] = numberPattern.split(".");
  const trailingCommas = intPattern.match(/,+$/)?.[0].length ?? 0;
  if (trailingCommas > 0) {
    scaled /= 1000 ** trailingCommas;
  }
  const intCore = intPattern.replace(/,+$/, "");
  const useGrouping = intCore.includes(",");
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const maxDecimals = decPattern.length;

  const formattedNumber = getCachedNumberFormatter(
    useGrouping,
    minDecimals,
    Math.max(minDecimals, maxDecimals),
  ).format(Object.is(scaled, -0) ? 0 : scaled);

  let suffix = "";
  if (isPercent) {
    suffix = "%";
  } else {
    const unitMatch = cleaned.match(/"([^"]+)"\s*$/);
    if (unitMatch && !/[£$€¥]/.test(unitMatch[1])) {
      suffix = unitMatch[1];
    }
  }

  const core = `${currency}${formattedNumber}${suffix}`;
  if (isNegative) {
    if (wrapParens) {
      return `(${core})`;
    }
    if (hasExplicitNegativeSection && cleaned.includes("-")) {
      return `-${core}`;
    }
    return `-${core}`;
  }
  return core;
}

function formatCellValue(cell: Cell): string {
  const raw = unwrapRawCellValue(cell.value);
  if (raw === null || raw === undefined) {
    return "";
  }
  if (typeof raw === "number") {
    if (isDateNumFmt(cell.numFmt) && raw > 1 && raw < 2958465) {
      return formatExcelDate(excelSerialToDate(raw), cell.numFmt);
    }
    return formatExcelNumber(raw, cell.numFmt);
  }
  if (raw instanceof Date) {
    return formatExcelDate(raw, cell.numFmt);
  }
  return cell.text;
}

function splitFormatSections(numFmt: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuotes = false;
  let inBrackets = false;
  for (let idx = 0; idx < numFmt.length; idx += 1) {
    const ch = numFmt[idx];
    if (ch === "\\" && idx + 1 < numFmt.length) {
      current += ch + numFmt[idx + 1];
      idx += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes) {
      if (ch === "[") inBrackets = true;
      else if (ch === "]") inBrackets = false;
      else if (ch === ";" && !inBrackets) {
        sections.push(current);
        current = "";
        continue;
      }
    }
    current += ch;
  }
  sections.push(current);
  return sections;
}

function stripFormatConditions(section: string): string {
  return section
    .replace(/\\./g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "")
    .replace(
      /\[(?:Red|Black|Blue|Green|White|Yellow|Magenta|Cyan|Color\s*\d+|[<>!=]+[^\]]+)\]/gi,
      "",
    );
}

function extractCurrencySymbol(section: string): string {
  const bracketCurrency = section.match(/\[\$([^\]-]+)(?:-[^\]]+)?\]/);
  if (bracketCurrency && bracketCurrency[1]) {
    return bracketCurrency[1];
  }
  const stripped = section.replace(/\[[^\]]*\]/g, "");
  const symbolMatch = stripped.match(/[£$€¥]/);
  return symbolMatch ? symbolMatch[0] : "";
}

function cleanFormatLiterals(section: string): string {
  return section
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"/g, "")
    .trim();
}

function isDateNumFmt(numFmt?: string): boolean {
  if (!numFmt) return false;
  const cleaned = stripFormatConditions(splitFormatSections(numFmt)[0] ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "");
  if (/[0#]/.test(cleaned)) return false;
  return /[dmyhs]/i.test(cleaned);
}

function excelSerialToDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  return new Date(utcValue * 1000);
}

function formatExcelDate(date: Date, numFmt?: string): string {
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const fmt = (numFmt ?? "").toLowerCase();
  const day = String(date.getUTCDate()).padStart(2, "0");
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthShort = monthNames[date.getUTCMonth()] ?? "Jan";
  const monthNum = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yearFull = String(date.getUTCFullYear());
  const yearShort = yearFull.slice(-2);
  if (fmt.includes("mmm")) {
    if (fmt.includes("yyyy")) return `${day} ${monthShort} ${yearFull}`;
    if (fmt.includes("yy")) return `${day} ${monthShort} ${yearShort}`;
    return `${day} ${monthShort}`;
  }
  return `${day}/${monthNum}/${yearFull}`;
}

function fillColor(fill: Fill | undefined, themeColors: Record<number, string>): string | undefined {
  if (fill?.type !== "pattern" || fill.pattern !== "solid") {
    return undefined;
  }
  return cssColor(fill.fgColor, themeColors);
}

export function cssColor(
  color: Partial<Color> | undefined,
  themeColors: Record<number, string> = OFFICE_THEME_COLORS,
): string | undefined {
  const value = color as
    | { argb?: string; theme?: number; tint?: number; indexed?: number }
    | undefined;
  if (!value) {
    return undefined;
  }
  let baseHex: string | undefined;
  if (value.argb) {
    const argb = value.argb.replace(/^#/, "");
    if (argb.length === 8 && argb.slice(0, 2) === "00") {
      return undefined;
    }
    baseHex = `#${argb.slice(-6).toLowerCase()}`;
  } else if (typeof value.theme === "number") {
    baseHex = themeColors[value.theme] ?? OFFICE_THEME_COLORS[value.theme];
  } else if (typeof value.indexed === "number") {
    baseHex = EXCEL_INDEXED_COLORS[value.indexed];
  }
  if (!baseHex) {
    return undefined;
  }
  if (typeof value.tint === "number" && value.tint !== 0) {
    return applyTint(baseHex, value.tint);
  }
  return baseHex;
}

export function applyTint(hex: string, tint: number): string {
  const raw = hex.replace(/^#/, "");
  if (raw.length !== 6) return hex;
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  if (tint < 0) {
    l = l * (1 + tint);
  } else {
    l = l * (1 - tint) + tint;
  }
  l = Math.min(1, Math.max(0, l));

  const hue2rgb = (p: number, q: number, t: number) => {
    let tc = t;
    if (tc < 0) tc += 1;
    if (tc > 1) tc -= 1;
    if (tc < 1 / 6) return p + (q - p) * 6 * tc;
    if (tc < 1 / 2) return q;
    if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
    return p;
  };

  let rOut = l;
  let gOut = l;
  let bOut = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rOut = hue2rgb(p, q, h + 1 / 3);
    gOut = hue2rgb(p, q, h);
    bOut = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel * 255)))
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(rOut)}${toHex(gOut)}${toHex(bOut)}`;
}

function extractWorkbookThemeColors(workbook: unknown): Record<number, string> {
  const palette: Record<number, string> = { ...OFFICE_THEME_COLORS };
  const themeXml = (workbook as { _themes?: { theme1?: string } })?._themes?.theme1;
  if (typeof themeXml !== "string" || !themeXml) {
    return palette;
  }
  const tagMap: Array<[string, number]> = [
    ["lt1", 0],
    ["dk1", 1],
    ["lt2", 2],
    ["dk2", 3],
    ["accent1", 4],
    ["accent2", 5],
    ["accent3", 6],
    ["accent4", 7],
    ["accent5", 8],
    ["accent6", 9],
    ["hlink", 10],
    ["folHlink", 11],
  ];
  for (const [tag, index] of tagMap) {
    const blockMatch = new RegExp(`<(?:a:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:a:)?${tag}>`, "i").exec(
      themeXml,
    );
    if (!blockMatch) continue;
    const block = blockMatch[1];
    const srgbMatch = /<(?:a:)?srgbClr\b[^>]*\bval=["']([0-9a-fA-F]{6})["']/i.exec(block);
    const sysMatch = /<(?:a:)?sysClr\b[^>]*\blastClr=["']([0-9a-fA-F]{6})["']/i.exec(block);
    const hex = srgbMatch?.[1] ?? sysMatch?.[1];
    if (hex) {
      palette[index] = `#${hex.toLowerCase()}`;
    }
  }
  return palette;
}

function addBorder(
  style: NonNullable<WorkbookCell["style"]>,
  side: "Top" | "Right" | "Bottom" | "Left",
  border: Partial<Border> | undefined,
  themeColors: Record<number, string>,
) {
  if (!border?.style) {
    return;
  }
  const width =
    border.style === "double"
      ? 3
      : border.style.includes("medium")
        ? 2
        : border.style === "thick"
          ? 3
          : 1;
  const lineStyle =
    border.style === "double"
      ? "double"
      : border.style.includes("dash")
        ? "dashed"
        : border.style === "dotted" || border.style === "hair"
          ? "dotted"
          : "solid";
  style[`border${side}`] = `${width}px ${lineStyle} ${cssColor(border.color, themeColors) ?? "#263244"}`;
}

function extractWorksheetImages(
  worksheet: Worksheet,
  workbook: Workbook,
  columns: WorkbookColumn[],
  rows: WorkbookRow[],
): WorkbookImage[] {
  const rawImages = worksheet.getImages?.() ?? [];
  if (rawImages.length === 0 || columns.length === 0 || rows.length === 0) {
    return [];
  }
  const images: WorkbookImage[] = [];
  for (const entry of rawImages) {
    const media = workbook.getImage?.(Number(entry.imageId)) as
      | { buffer?: Uint8Array | ArrayBuffer; base64?: string; extension?: string }
      | undefined;
    if (!media) continue;
    const mime = imageMimeType(media.extension);
    if (!mime) continue;
    const base64 = media.base64
      ? media.base64.replace(/^data:[^;]+;base64,/, "")
      : media.buffer
        ? bytesToBase64(
            media.buffer instanceof Uint8Array ? media.buffer : new Uint8Array(media.buffer),
          )
        : "";
    if (!base64) continue;

    const range = entry.range as {
      tl?: { col?: number; row?: number; nativeCol?: number; nativeRow?: number };
      br?: { col?: number; row?: number; nativeCol?: number; nativeRow?: number };
      ext?: { width?: number; height?: number };
    };
    const tlCol = range?.tl?.col ?? range?.tl?.nativeCol ?? 0;
    const tlRow = range?.tl?.row ?? range?.tl?.nativeRow ?? 0;
    const leftPx = coordinateToPixelOffset(tlCol, columns, (c) => c.widthPx);
    const topPx = coordinateToPixelOffset(tlRow, rows, (r) => r.heightPx);

    let widthPx = range?.ext?.width ? Math.round(range.ext.width) : 0;
    let heightPx = range?.ext?.height ? Math.round(range.ext.height) : 0;

    const brCol = range?.br?.col ?? range?.br?.nativeCol;
    const brRow = range?.br?.row ?? range?.br?.nativeRow;
    if (!widthPx && typeof brCol === "number") {
      widthPx = Math.max(24, coordinateToPixelOffset(brCol, columns, (c) => c.widthPx) - leftPx);
    }
    if (!heightPx && typeof brRow === "number") {
      heightPx = Math.max(18, coordinateToPixelOffset(brRow, rows, (r) => r.heightPx) - topPx);
    }
    if (!widthPx) widthPx = 120;
    if (!heightPx) heightPx = 44;

    images.push({
      dataUrl: `data:${mime};base64,${base64}`,
      leftPx: Math.max(0, Math.round(leftPx)),
      topPx: Math.max(0, Math.round(topPx)),
      widthPx: clamp(widthPx, 16, 720),
      heightPx: clamp(heightPx, 16, 360),
    });
  }
  return images;
}

function coordinateToPixelOffset<T extends { index: number }>(
  zeroBasedCoord: number,
  items: T[],
  getSize: (item: T) => number,
): number {
  const targetOneBased = Math.max(1, zeroBasedCoord + 1);
  let offset = 0;
  for (const item of items) {
    const size = getSize(item);
    if (targetOneBased >= item.index + 1) {
      offset += size;
    } else if (targetOneBased > item.index) {
      offset += (targetOneBased - item.index) * size;
      break;
    } else {
      break;
    }
  }
  return offset;
}

function imageMimeType(extension?: string): string | null {
  const ext = (extension ?? "").toLowerCase().replace(/^\./, "");
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
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

export function normalizeLegacyWorkbook(preview: unknown): WorkbookPreview {
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

// OOXML theme index mapping: 0=lt1 (Light 1), 1=dk1 (Dark 1), 2=lt2 (Light 2), 3=dk2 (Dark 2), 4..9=accent1..6
const OFFICE_THEME_COLORS: Record<number, string> = {
  0: "#ffffff",
  1: "#000000",
  2: "#e7e6e6",
  3: "#44546a",
  4: "#4472c4",
  5: "#ed7d31",
  6: "#a5a5a5",
  7: "#ffc000",
  8: "#5b9bd5",
  9: "#70ad47",
  10: "#0563c1",
  11: "#954f72",
};

const EXCEL_INDEXED_COLORS: Record<number, string> = {
  0: "#000000",
  1: "#ffffff",
  2: "#ff0000",
  3: "#00ff00",
  4: "#0000ff",
  5: "#ffff00",
  6: "#ff00ff",
  7: "#00ffff",
  8: "#000000",
  9: "#ffffff",
  10: "#ff0000",
  11: "#00ff00",
  12: "#0000ff",
  13: "#ffff00",
  14: "#ff00ff",
  15: "#00ffff",
  16: "#800000",
  17: "#008000",
  18: "#000080",
  19: "#808000",
  20: "#800080",
  21: "#008080",
  22: "#c0c0c0",
  23: "#808080",
  24: "#9999ff",
  25: "#993366",
  26: "#ffffcc",
  27: "#ccffff",
  28: "#660066",
  29: "#ff8080",
  30: "#0066cc",
  31: "#ccccff",
  32: "#000080",
  33: "#ff00ff",
  34: "#ffff00",
  35: "#00ffff",
  36: "#800080",
  37: "#800000",
  38: "#008080",
  39: "#0000ff",
  40: "#00ccff",
  41: "#ccffff",
  42: "#ccffcc",
  43: "#ffff99",
  44: "#99ccff",
  45: "#ff99cc",
  46: "#cc99ff",
  47: "#ffcc99",
  48: "#3366ff",
  49: "#33cccc",
  50: "#99cc00",
  51: "#ffcc00",
  52: "#ff9900",
  53: "#ff6600",
  54: "#666699",
  55: "#969696",
  56: "#003366",
  57: "#339966",
  58: "#003300",
  59: "#333300",
  60: "#993300",
  61: "#993366",
  62: "#333399",
  63: "#333333",
};
