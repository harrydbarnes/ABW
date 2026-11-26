import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  DownloadRecord,
  WorkbookCell,
  WorkbookImage,
  WorkbookPreview,
  WorkbookSheet,
} from "../../types";
import { loadSpreadsheetImages, loadSpreadsheetSheet } from "../../lib/desktop";
import { loadCachedSpreadsheetPreview, toColumnLabel } from "./previewCache";
import {
  formatSelectionAsCsv,
  formatSummaryNumber,
  parseSpreadsheetNumber,
} from "./previewUtils";

const ROW_HEADER_WIDTH_PX = 38;
const COLUMN_HEADER_HEIGHT_PX = 28;
const VIRTUAL_ROW_OVERSCAN = 12;
const VIRTUAL_COL_THRESHOLD = 30;
const VIRTUAL_COL_OVERSCAN = 6;

type CellCoord = {
  row: number;
  col: number;
};

type CellSelection = {
  anchor: CellCoord;
  focus: CellCoord;
};

interface CellMatch {
  row: number;
  col: number;
}

const DEMO_PREVIEW: WorkbookPreview = {
  activeSheet: 0,
  sheets: [
    createDemoSheet("Overview", [
      ["Channel", "Owner", "Apr", "May", "Jun", "Q2 total", "Status"],
      ["Paid social", "Alex Morris", "£42,000", "£45,500", "£48,000", "£135,500", "Booked"],
      ["Connected TV", "Priya Shah", "£72,000", "£70,000", "£76,000", "£218,000", "Pending"],
      ["Audio", "Ben Howard", "£18,600", "£21,400", "£19,800", "£59,800", "Booked"],
      ["Display", "Alex Morris", "£12,500", "£14,000", "£14,000", "£40,500", "Approved"],
      ["Out of home", "Jo Clarke", "£31,000", "£38,000", "£40,000", "£109,000", "Review"],
      ["TOTAL", "", "£176,100", "£188,900", "£197,800", "£562,800", ""],
      ["", "", "", "", "", "", ""],
      ["Notes", "", "", "", "", "", ""],
      ["Forecast includes pacing adjustments approved on 18 May.", "", "", "", "", "", ""],
      ["Budgets include platform and production fees.", "", "", "", "", "", ""],
    ]),
    createDemoSheet("Placements", [
      ["Placement", "Market", "Start", "End", "Budget"],
      ["CTV prime", "UK", "01 Apr", "30 Jun", "£218,000"],
      ["Paid social video", "UK", "07 Apr", "30 Jun", "£135,500"],
    ]),
    createDemoSheet("Approvals", [
      ["Item", "Approver", "Decision"],
      ["CTV allocation", "Finance", "Pending"],
      ["Display allocation", "Client", "Approved"],
    ]),
  ],
};

const SheetRow = memo(function SheetRow({
  row,
  rowIndex,
  columns,
  startCol,
  endCol,
  leftSpacerWidth,
  rightSpacerWidth,
  stylesPalette,
  matchCols,
  activeMatchCol,
  selMinCol,
  selMaxCol,
}: {
  row: WorkbookSheet["rows"][number];
  rowIndex: number;
  columns: WorkbookSheet["columns"];
  startCol: number;
  endCol: number;
  leftSpacerWidth: number;
  rightSpacerWidth: number;
  stylesPalette: CSSProperties[];
  matchCols: Set<number> | undefined;
  activeMatchCol: number;
  selMinCol: number;
  selMaxCol: number;
}) {
  const renderedCells = [];
  for (let cellIndex = startCol; cellIndex < endCol; cellIndex += 1) {
    const cell = row.cells[cellIndex];
    if (!cell || cell.coveredByMerge) {
      continue;
    }
    const isActiveMatch = cellIndex === activeMatchCol;
    const isMatch = !isActiveMatch && Boolean(matchCols?.has(cellIndex));
    const isSelected = selMinCol >= 0 && cellIndex >= selMinCol && cellIndex <= selMaxCol;
    const className = [
      isActiveMatch ? "sheet-match active" : isMatch ? "sheet-match" : "",
      isSelected ? "cell-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    renderedCells.push(
      <td
        className={className || undefined}
        colSpan={cell.colSpan}
        data-cell-key={isMatch || isActiveMatch ? `${rowIndex}:${cellIndex}` : undefined}
        data-col={cellIndex}
        data-row={rowIndex}
        key={columns[cellIndex]?.index ?? cellIndex}
        rowSpan={cell.rowSpan}
        style={
          cell.styleIndex !== undefined
            ? stylesPalette[cell.styleIndex]
            : cell.style
        }
      >
        {cell.value ?? ""}
      </td>,
    );
  }
  return (
    <tr style={{ height: row.heightPx }}>
      <th className="row-number">{row.index}</th>
      {leftSpacerWidth > 0 ? <td aria-hidden="true" className="sheet-virtual-col-spacer" /> : null}
      {renderedCells}
      {rightSpacerWidth > 0 ? <td aria-hidden="true" className="sheet-virtual-col-spacer" /> : null}
    </tr>
  );
});

export default memo(function SpreadsheetPreview({
  record,
  demo,
}: {
  record: DownloadRecord;
  demo: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const sheetScrollRef = useRef<Map<number, { top: number; left: number }>>(new Map());
  const isSelectingRef = useRef(false);
  const [preview, setPreview] = useState<WorkbookPreview | null>(demo ? DEMO_PREVIEW : null);
  const [active, setActive] = useState(demo ? DEMO_PREVIEW.activeSheet : 0);
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(!demo);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const [copiedNotice, setCopiedNotice] = useState<"tsv" | "csv" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const deferredQuery = useDeferredValue(findQuery);
  const [matchCursor, setMatchCursor] = useState(0);
  const [showImages, setShowImages] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesByKey, setImagesByKey] = useState<Record<string, WorkbookImage[]>>({});
  const [viewport, setViewport] = useState({ scrollTop: 0, scrollLeft: 0, height: 600, width: 800 });
  const activeRecordIdRef = useRef(record.id);
  activeRecordIdRef.current = record.id;

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) {
        return;
      }
      event.preventDefault();
      const rawStep = Math.round(-event.deltaY * 0.12);
      const delta = rawStep === 0 ? (event.deltaY < 0 ? 5 : -5) : Math.max(-15, Math.min(15, rawStep));
      setZoom((current) => Math.min(160, Math.max(60, current + delta)));
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const stopSelection = () => {
      isSelectingRef.current = false;
    };
    window.addEventListener("mouseup", stopSelection);
    return () => window.removeEventListener("mouseup", stopSelection);
  }, []);

  useEffect(() => {
    setSelection(null);
    setCopiedNotice(null);
  }, [active, record.id]);

  useEffect(() => {
    if (!copiedNotice) {
      return;
    }
    const timer = window.setTimeout(() => setCopiedNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedNotice]);

  useEffect(() => {
    let live = true;
    setProblem(null);
    setSheetLoading(false);
    setSheetError(null);
    setFindQuery("");
    setMatchCursor(0);
    setShowImages(false);
    setImagesLoading(false);
    setImagesByKey({});
    setViewport({
      scrollTop: 0,
      scrollLeft: 0,
      height: scrollerRef.current?.clientHeight || 600,
      width: scrollerRef.current?.clientWidth || 800,
    });
    sheetScrollRef.current.clear();
    if (demo) {
      setPreview(DEMO_PREVIEW);
      setActive(DEMO_PREVIEW.activeSheet);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadCachedSpreadsheetPreview(record)
      .then((result) => {
        if (live) {
          setPreview(result);
          setActive(result?.activeSheet ?? 0);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (live) {
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Spreadsheet preview could not be rendered.";
          setProblem(message);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [demo, record.id]);

  const sheets = preview?.sheets ?? [];
  const sheet = sheets[Math.min(active, Math.max(sheets.length - 1, 0))];
  const stylesPalette = preview?.styles ?? [];
  const imageCacheKey = `${record.id}:${active}`;
  const currentImages = imagesByKey[imageCacheKey] ?? [];

  useEffect(() => {
    if (demo || !preview || !sheet?.deferred) {
      setSheetLoading(false);
      setSheetError(null);
      return;
    }
    let live = true;
    const targetSheetIndex = active;
    setSheetLoading(true);
    setSheetError(null);
    void loadSpreadsheetSheet(record.id, targetSheetIndex)
      .then((loaded) => {
        if (!live) {
          return;
        }
        if (!loaded) {
          setSheetError("Unable to load this worksheet.");
          setSheetLoading(false);
          return;
        }
        setPreview((current) => {
          if (!current) {
            return current;
          }
          current.sheets[targetSheetIndex] = loaded;
          return {
            ...current,
            sheets: [...current.sheets],
          };
        });
        setSheetLoading(false);
      })
      .catch((error: unknown) => {
        if (!live) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Unable to load this worksheet.";
        setSheetError(message);
        setSheetLoading(false);
      });
    return () => {
      live = false;
    };
  }, [active, demo, preview, record.id, sheet?.deferred]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !sheet) {
      return;
    }
    let rafId = 0;
    const syncViewport = () => {
      const nextTop = scroller.scrollTop;
      const nextLeft = scroller.scrollLeft;
      const nextHeight = scroller.clientHeight || 600;
      const nextWidth = scroller.clientWidth || 800;
      setViewport((current) =>
        Math.abs(current.scrollTop - nextTop) < 1 &&
        Math.abs(current.scrollLeft - nextLeft) < 1 &&
        Math.abs(current.height - nextHeight) < 1 &&
        Math.abs(current.width - nextWidth) < 1
          ? current
          : { scrollTop: nextTop, scrollLeft: nextLeft, height: nextHeight, width: nextWidth },
      );
    };
    const onScroll = () => {
      if (rafId) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        syncViewport();
      });
    };
    syncViewport();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onScroll);
      observer.observe(scroller);
    }
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [active, loading, problem, record.id, sheet]);

  const { rowOffsets, totalRowsHeight, mergeOwnerStart } = useMemo(() => {
    if (!sheet) {
      return {
        rowOffsets: [0],
        totalRowsHeight: 0,
        mergeOwnerStart: [] as number[],
      };
    }
    const offsets = new Array<number>(sheet.rows.length + 1);
    offsets[0] = 0;
    const owners = new Array<number>(sheet.rows.length);
    for (let r = 0; r < sheet.rows.length; r += 1) {
      offsets[r + 1] = offsets[r] + sheet.rows[r].heightPx;
      owners[r] = r;
    }
    for (let r = 0; r < sheet.rows.length; r += 1) {
      const cells = sheet.rows[r].cells;
      for (let c = 0; c < cells.length; c += 1) {
        const span = cells[c].rowSpan ?? 1;
        if (span > 1) {
          const maxR = Math.min(sheet.rows.length - 1, r + span - 1);
          for (let k = r + 1; k <= maxR; k += 1) {
            if (r < owners[k]) {
              owners[k] = r;
            }
          }
        }
      }
    }
    return {
      rowOffsets: offsets,
      totalRowsHeight: offsets[sheet.rows.length],
      mergeOwnerStart: owners,
    };
  }, [sheet]);

  const { startRow, endRow, topSpacerHeight, bottomSpacerHeight } = useMemo(() => {
    if (!sheet || sheet.rows.length === 0) {
      return { startRow: 0, endRow: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 };
    }
    const rowCount = sheet.rows.length;
    const scale = zoom / 100;
    const unscaledTop = Math.max(0, viewport.scrollTop / scale - COLUMN_HEADER_HEIGHT_PX);
    const unscaledBottom = Math.max(
      unscaledTop,
      (viewport.scrollTop + viewport.height) / scale - COLUMN_HEADER_HEIGHT_PX,
    );

    let lo = 0;
    let hi = rowCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid + 1] <= unscaledTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let start = Math.max(0, lo - VIRTUAL_ROW_OVERSCAN);
    while (start > 0 && mergeOwnerStart[start] < start) {
      start = mergeOwnerStart[start];
    }

    lo = start;
    hi = rowCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowOffsets[mid] < unscaledBottom) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let end = Math.min(rowCount, lo + VIRTUAL_ROW_OVERSCAN);
    for (let r = start; r < end; r += 1) {
      const cells = sheet.rows[r].cells;
      for (let c = 0; c < cells.length; c += 1) {
        const span = cells[c].rowSpan ?? 1;
        if (span > 1) {
          end = Math.max(end, Math.min(rowCount, r + span));
        }
      }
    }

    return {
      startRow: start,
      endRow: end,
      topSpacerHeight: rowOffsets[start],
      bottomSpacerHeight: totalRowsHeight - rowOffsets[end],
    };
  }, [mergeOwnerStart, rowOffsets, sheet, totalRowsHeight, viewport.height, viewport.scrollTop, zoom]);

  const { colOffsets, totalColsWidth, colMergeOwnerStart } = useMemo(() => {
    if (!sheet) {
      return {
        colOffsets: [0],
        totalColsWidth: 0,
        colMergeOwnerStart: [] as number[],
      };
    }
    const colCount = sheet.columns.length;
    const offsets = new Array<number>(colCount + 1);
    offsets[0] = 0;
    const owners = new Array<number>(colCount);
    for (let c = 0; c < colCount; c += 1) {
      offsets[c + 1] = offsets[c] + sheet.columns[c].widthPx;
      owners[c] = c;
    }
    for (let r = 0; r < sheet.rows.length; r += 1) {
      const cells = sheet.rows[r].cells;
      for (let c = 0; c < cells.length; c += 1) {
        const span = cells[c].colSpan ?? 1;
        if (span > 1) {
          const maxC = Math.min(colCount - 1, c + span - 1);
          for (let k = c + 1; k <= maxC; k += 1) {
            if (c < owners[k]) {
              owners[k] = c;
            }
          }
        }
      }
    }
    return {
      colOffsets: offsets,
      totalColsWidth: offsets[colCount],
      colMergeOwnerStart: owners,
    };
  }, [sheet]);

  const { startCol, endCol, leftSpacerWidth, rightSpacerWidth } = useMemo(() => {
    if (!sheet || sheet.columns.length === 0) {
      return { startCol: 0, endCol: 0, leftSpacerWidth: 0, rightSpacerWidth: 0 };
    }
    const colCount = sheet.columns.length;
    if (colCount <= VIRTUAL_COL_THRESHOLD) {
      return { startCol: 0, endCol: colCount, leftSpacerWidth: 0, rightSpacerWidth: 0 };
    }
    const scale = zoom / 100;
    const unscaledLeft = Math.max(0, viewport.scrollLeft / scale - ROW_HEADER_WIDTH_PX);
    const unscaledRight = Math.max(
      unscaledLeft,
      (viewport.scrollLeft + viewport.width) / scale - ROW_HEADER_WIDTH_PX,
    );

    let lo = 0;
    let hi = colCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colOffsets[mid + 1] <= unscaledLeft) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let start = Math.max(0, lo - VIRTUAL_COL_OVERSCAN);
    while (start > 0 && colMergeOwnerStart[start] < start) {
      start = colMergeOwnerStart[start];
    }

    lo = start;
    hi = colCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colOffsets[mid] < unscaledRight) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let end = Math.min(colCount, lo + VIRTUAL_COL_OVERSCAN);
    for (let r = startRow; r < endRow; r += 1) {
      const cells = sheet.rows[r].cells;
      for (let c = start; c < end; c += 1) {
        const span = cells[c]?.colSpan ?? 1;
        if (span > 1) {
          end = Math.max(end, Math.min(colCount, c + span));
        }
      }
    }

    return {
      startCol: start,
      endCol: end,
      leftSpacerWidth: colOffsets[start],
      rightSpacerWidth: totalColsWidth - colOffsets[end],
    };
  }, [
    colMergeOwnerStart,
    colOffsets,
    endRow,
    sheet,
    startRow,
    totalColsWidth,
    viewport.scrollLeft,
    viewport.width,
    zoom,
  ]);

  const { matches, matchesByRow } = useMemo(() => {
    const trimmed = deferredQuery.trim().toLowerCase();
    const byRow = new Map<number, Set<number>>();
    if (!sheet || !trimmed) {
      return { matches: [] as CellMatch[], matchesByRow: byRow };
    }
    const found: CellMatch[] = [];
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
      const cells = sheet.rows[rowIndex].cells;
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const cell = cells[cellIndex];
        if (!cell.coveredByMerge && cell.value && cell.value.toLowerCase().includes(trimmed)) {
          found.push({ row: rowIndex, col: cellIndex });
          let cols = byRow.get(rowIndex);
          if (!cols) {
            cols = new Set<number>();
            byRow.set(rowIndex, cols);
          }
          cols.add(cellIndex);
        }
      }
    }
    return { matches: found, matchesByRow: byRow };
  }, [deferredQuery, sheet]);

  const activeMatch = matches.length
    ? matches[Math.min(matchCursor, matches.length - 1)] ?? null
    : null;
  const activeMatchKey = activeMatch ? `${activeMatch.row}:${activeMatch.col}` : null;

  useEffect(() => {
    setMatchCursor(0);
  }, [deferredQuery, active]);

  useEffect(() => {
    if (!activeMatchKey || !activeMatch || !scrollerRef.current) {
      return;
    }
    const scroller = scrollerRef.current;
    const target = scroller.querySelector<HTMLElement>(`td[data-cell-key="${activeMatchKey}"]`);
    if (target) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    const scale = zoom / 100;
    const rowY = (COLUMN_HEADER_HEIGHT_PX + (rowOffsets[activeMatch.row] ?? 0)) * scale;
    const colX = (ROW_HEADER_WIDTH_PX + (colOffsets[activeMatch.col] ?? 0)) * scale;
    scroller.scrollTop = Math.max(0, rowY - scroller.clientHeight / 3);
    scroller.scrollLeft = Math.max(0, colX - scroller.clientWidth / 3);
    window.requestAnimationFrame(() => {
      const mounted = scrollerRef.current?.querySelector<HTMLElement>(
        `td[data-cell-key="${activeMatchKey}"]`,
      );
      mounted?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }, [activeMatch, activeMatchKey, colOffsets, rowOffsets, zoom]);

  const normalizedBounds = useMemo(() => {
    if (!selection) {
      return null;
    }
    return {
      minRow: Math.min(selection.anchor.row, selection.focus.row),
      maxRow: Math.max(selection.anchor.row, selection.focus.row),
      minCol: Math.min(selection.anchor.col, selection.focus.col),
      maxCol: Math.max(selection.anchor.col, selection.focus.col),
    };
  }, [selection]);

  const isMultiCellSelection = Boolean(
    normalizedBounds &&
      (normalizedBounds.minRow !== normalizedBounds.maxRow ||
        normalizedBounds.minCol !== normalizedBounds.maxCol),
  );

  const selectionSummary = useMemo(() => {
    if (!sheet || !normalizedBounds) {
      return null;
    }
    let nonEmptyCount = 0;
    let numericCount = 0;
    let sum = 0;

    for (let r = normalizedBounds.minRow; r <= normalizedBounds.maxRow; r += 1) {
      const row = sheet.rows[r];
      for (let c = normalizedBounds.minCol; c <= normalizedBounds.maxCol; c += 1) {
        const cell = row?.cells[c];
        const value = cell && !cell.coveredByMerge ? cell.value ?? "" : "";
        if (value.trim() !== "") {
          nonEmptyCount += 1;
          const numeric = parseSpreadsheetNumber(value);
          if (numeric !== null) {
            numericCount += 1;
            sum += numeric;
          }
        }
      }
    }

    const startLabel = `${sheet.columns[normalizedBounds.minCol]?.label ?? toColumnLabel(normalizedBounds.minCol + 1)}${sheet.rows[normalizedBounds.minRow]?.index ?? normalizedBounds.minRow + 1}`;
    const endLabel = `${sheet.columns[normalizedBounds.maxCol]?.label ?? toColumnLabel(normalizedBounds.maxCol + 1)}${sheet.rows[normalizedBounds.maxRow]?.index ?? normalizedBounds.maxRow + 1}`;

    return {
      rangeLabel: startLabel === endLabel ? startLabel : `${startLabel}:${endLabel}`,
      nonEmptyCount,
      numericCount,
      sum,
      average: numericCount > 0 ? sum / numericCount : null,
    };
  }, [normalizedBounds, sheet]);

  const copySelection = useCallback(
    async (format: "tsv" | "csv" = "tsv") => {
      if (!sheet || !normalizedBounds) {
        return;
      }
      const rows: string[][] = [];
      for (let r = normalizedBounds.minRow; r <= normalizedBounds.maxRow; r += 1) {
        const row = sheet.rows[r];
        const rowValues: string[] = [];
        for (let c = normalizedBounds.minCol; c <= normalizedBounds.maxCol; c += 1) {
          const cell = row?.cells[c];
          rowValues.push(cell && !cell.coveredByMerge ? cell.value ?? "" : "");
        }
        rows.push(rowValues);
      }
      const text =
        format === "csv"
          ? formatSelectionAsCsv(rows)
          : rows.map((rowValues) => rowValues.join("\t")).join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setCopiedNotice(format);
      } catch {
        // Clipboard API unavailable
      }
    },
    [normalizedBounds, sheet],
  );

  const startSelection = useCallback((rowIndex: number, cellIndex: number, shiftKey: boolean) => {
    isSelectingRef.current = true;
    const coord = { row: rowIndex, col: cellIndex };
    setSelection((current) =>
      shiftKey && current ? { anchor: current.anchor, focus: coord } : { anchor: coord, focus: coord },
    );
  }, []);

  const extendSelection = useCallback((rowIndex: number, cellIndex: number) => {
    if (!isSelectingRef.current) {
      return;
    }
    setSelection((current) =>
      current
        ? {
            anchor: current.anchor,
            focus: { row: rowIndex, col: cellIndex },
          }
        : null,
    );
  }, []);

  function openFindBar() {
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }

  function stepMatch(delta: number) {
    if (!matches.length) {
      return;
    }
    setMatchCursor((current) => (current + delta + matches.length) % matches.length);
  }

  async function toggleShowImages() {
    if (showImages) {
      setShowImages(false);
      return;
    }
    if (demo || !sheet?.hasImages) {
      return;
    }
    if (imageCacheKey in imagesByKey) {
      setShowImages(true);
      return;
    }
    const targetRecordId = record.id;
    const targetSheet = active;
    const targetKey = imageCacheKey;
    setImagesLoading(true);
    try {
      const loaded = await loadSpreadsheetImages(targetRecordId, targetSheet);
      if (activeRecordIdRef.current !== targetRecordId) {
        return;
      }
      setImagesByKey((current) => ({ ...current, [targetKey]: loaded }));
      setShowImages(true);
    } catch {
      // Keep grid interactive even if optional images fail to load.
    } finally {
      if (activeRecordIdRef.current === targetRecordId) {
        setImagesLoading(false);
      }
    }
  }

  function switchSheet(nextIndex: number) {
    if (nextIndex === active) {
      return;
    }
    if (scrollerRef.current) {
      sheetScrollRef.current.set(active, {
        top: scrollerRef.current.scrollTop,
        left: scrollerRef.current.scrollLeft,
      });
    }
    setActive(nextIndex);
    window.requestAnimationFrame(() => {
      const saved = sheetScrollRef.current.get(nextIndex);
      if (scrollerRef.current) {
        const nextTop = saved?.top ?? 0;
        const nextLeft = saved?.left ?? 0;
        scrollerRef.current.scrollTop = nextTop;
        scrollerRef.current.scrollLeft = nextLeft;
        setViewport({
          scrollTop: nextTop,
          scrollLeft: nextLeft,
          height: scrollerRef.current.clientHeight || 600,
          width: scrollerRef.current.clientWidth || 800,
        });
      }
    });
  }

  function handleViewKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "f") {
      event.preventDefault();
      openFindBar();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === "c") {
      const target = event.target;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      const nativeSelection = window.getSelection()?.toString() ?? "";
      if (!isTextInput && !nativeSelection && selectionSummary) {
        event.preventDefault();
        void copySelection();
      }
      return;
    }
    if (event.key === "Escape") {
      if (findOpen) {
        event.preventDefault();
        setFindOpen(false);
        setFindQuery("");
      } else if (selection) {
        setSelection(null);
      }
    }
  }

  if (problem) {
    return (
      <div className="preview-error preview-status">
        <strong>Preview unavailable</strong>
        <p>{problem}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="document-loading preview-status">
        <span className="preview-spinner" aria-hidden="true" />
        <div>
          <strong>Loading spreadsheet preview</strong>
          <p>Reading the workbook once. The preview is cached when you come back to this file.</p>
        </div>
      </div>
    );
  }

  if (!sheet) {
    return <div className="unsupported-preview">This workbook has no visible worksheets.</div>;
  }

  const totalTableWidth = ROW_HEADER_WIDTH_PX + totalColsWidth;
  const renderedColCount =
    endCol - startCol + (leftSpacerWidth > 0 ? 1 : 0) + (rightSpacerWidth > 0 ? 1 : 0) + 1;

  return (
    <div
      className="spreadsheet-view"
      onKeyDown={handleViewKeyDown}
      ref={containerRef}
      tabIndex={0}
    >
      <div className="document-toolbar">
        <span>
          {sheet.rows.length} visible rows{sheet.truncatedRows ? " (preview limit)" : ""} ·{" "}
          {sheet.columns.length} visible columns{sheet.truncatedColumns ? " (preview limit)" : ""}
        </span>
        <div className="toolbar-actions">
          {sheet.hasImages ? (
            <button
              className="secondary toolbar-find-btn"
              disabled={imagesLoading}
              onClick={() => void toggleShowImages()}
              title={showImages ? "Hide embedded images" : "Load and display embedded images"}
              type="button"
            >
              {imagesLoading ? "Loading…" : showImages ? "Hide images" : "Show images"}
            </button>
          ) : null}
          <button
            className="secondary toolbar-find-btn"
            onClick={() => (findOpen ? setFindOpen(false) : openFindBar())}
            title="Find in sheet (Ctrl+F)"
            type="button"
          >
            Find
          </button>
          <div className="zoom-control">
            <button
              className="zoom-reset"
              disabled={zoom === 100}
              onClick={() => setZoom(100)}
              title="Reset zoom to 100%"
              type="button"
            >
              Reset
            </button>
            <button onClick={() => setZoom((current) => Math.max(current - 10, 60))}>-</button>
            <span>{zoom}%</span>
            <button onClick={() => setZoom((current) => Math.min(current + 10, 160))}>+</button>
          </div>
        </div>
      </div>
      {findOpen ? (
        <div className="sheet-find-bar" role="search" aria-label="Find in worksheet">
          <input
            aria-label="Find text in worksheet"
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Find in sheet..."
            ref={findInputRef}
            value={findQuery}
          />
          <span className="sheet-find-count">
            {findQuery.trim()
              ? matches.length
                ? `${Math.min(matchCursor + 1, matches.length)} of ${matches.length}`
                : "0 matches"
              : ""}
          </span>
          <button
            disabled={!matches.length}
            onClick={() => stepMatch(-1)}
            title="Previous match (Shift+Enter)"
            type="button"
          >
            Prev
          </button>
          <button
            disabled={!matches.length}
            onClick={() => stepMatch(1)}
            title="Next match (Enter)"
            type="button"
          >
            Next
          </button>
          <button
            className="sheet-find-close"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
            }}
            type="button"
          >
            Close
          </button>
        </div>
      ) : null}
      <div
        className={`sheet-scroller ${isMultiCellSelection ? "sheet-range-selecting" : ""}`}
        ref={scrollerRef}
      >
        {sheetError ? (
          <div className="preview-error preview-status">
            <strong>Worksheet unavailable</strong>
            <p>{sheetError}</p>
          </div>
        ) : sheetLoading || sheet.deferred ? (
          <div className="document-loading preview-status">
            <span className="preview-spinner" aria-hidden="true" />
            <div>
              <strong>Loading worksheet</strong>
              <p>Reading {sheet.name || "worksheet"}...</p>
            </div>
          </div>
        ) : (
        <div
          className="sheet-stage"
          style={{
            zoom: `${zoom}%`,
            width: totalTableWidth,
            minHeight: COLUMN_HEADER_HEIGHT_PX + totalRowsHeight,
          }}
        >
          <table className="sheet" style={{ width: totalTableWidth }}>
            <colgroup>
              <col className="row-number-column" />
              {leftSpacerWidth > 0 ? <col style={{ width: leftSpacerWidth }} /> : null}
              {sheet.columns.slice(startCol, endCol).map((column) => (
                <col key={column.index} style={{ width: column.widthPx }} />
              ))}
              {rightSpacerWidth > 0 ? <col style={{ width: rightSpacerWidth }} /> : null}
            </colgroup>
            <thead>
              <tr>
                <th className="row-number" />
                {leftSpacerWidth > 0 ? (
                  <th aria-hidden="true" className="sheet-virtual-col-spacer" />
                ) : null}
                {sheet.columns.slice(startCol, endCol).map((column) => (
                  <th key={column.index}>{column.label}</th>
                ))}
                {rightSpacerWidth > 0 ? (
                  <th aria-hidden="true" className="sheet-virtual-col-spacer" />
                ) : null}
              </tr>
            </thead>
            <tbody
              onMouseDown={(event) => {
                if (event.button !== 0) {
                  return;
                }
                const cell = (event.target as HTMLElement | null)?.closest<HTMLTableCellElement>("td[data-row][data-col]");
                if (!cell) {
                  return;
                }
                const rowIndex = Number(cell.dataset.row);
                const cellIndex = Number(cell.dataset.col);
                if (Number.isFinite(rowIndex) && Number.isFinite(cellIndex)) {
                  startSelection(rowIndex, cellIndex, event.shiftKey);
                }
              }}
              onMouseOver={(event) => {
                if (!isSelectingRef.current) {
                  return;
                }
                const cell = (event.target as HTMLElement | null)?.closest<HTMLTableCellElement>("td[data-row][data-col]");
                if (!cell) {
                  return;
                }
                const rowIndex = Number(cell.dataset.row);
                const cellIndex = Number(cell.dataset.col);
                if (Number.isFinite(rowIndex) && Number.isFinite(cellIndex)) {
                  extendSelection(rowIndex, cellIndex);
                }
              }}
            >
              {topSpacerHeight > 0 ? (
                <tr aria-hidden="true" className="sheet-virtual-spacer" style={{ height: topSpacerHeight }}>
                  <td colSpan={renderedColCount} style={{ height: topSpacerHeight, lineHeight: 0 }} />
                </tr>
              ) : null}
              {sheet.rows.slice(startRow, endRow).map((row, offset) => {
                const rowIndex = startRow + offset;
                const inSelectedRow = Boolean(
                  normalizedBounds &&
                    rowIndex >= normalizedBounds.minRow &&
                    rowIndex <= normalizedBounds.maxRow,
                );
                return (
                  <SheetRow
                    activeMatchCol={activeMatch?.row === rowIndex ? activeMatch.col : -1}
                    columns={sheet.columns}
                    endCol={endCol}
                    key={row.index}
                    leftSpacerWidth={leftSpacerWidth}
                    matchCols={matchesByRow.get(rowIndex)}
                    rightSpacerWidth={rightSpacerWidth}
                    row={row}
                    rowIndex={rowIndex}
                    selMaxCol={inSelectedRow && normalizedBounds ? normalizedBounds.maxCol : -1}
                    selMinCol={inSelectedRow && normalizedBounds ? normalizedBounds.minCol : -1}
                    startCol={startCol}
                    stylesPalette={stylesPalette}
                  />
                );
              })}
              {bottomSpacerHeight > 0 ? (
                <tr aria-hidden="true" className="sheet-virtual-spacer" style={{ height: bottomSpacerHeight }}>
                  <td colSpan={renderedColCount} style={{ height: bottomSpacerHeight, lineHeight: 0 }} />
                </tr>
              ) : null}
            </tbody>
          </table>
          {showImages
            ? currentImages.map((image, index) => (
                <img
                  alt=""
                  className="sheet-image"
                  key={`${index}-${image.leftPx}-${image.topPx}`}
                  src={image.dataUrl}
                  style={{
                    left: ROW_HEADER_WIDTH_PX + image.leftPx,
                    top: COLUMN_HEADER_HEIGHT_PX + image.topPx,
                    width: image.widthPx,
                    height: image.heightPx,
                  }}
                />
              ))
            : null}
        </div>
        )}
      </div>
      {selectionSummary ? (
        <div className="sheet-status-bar" role="status" aria-live="polite">
          <div className="sheet-status-metrics">
            <span className="sheet-range-pill">{selectionSummary.rangeLabel}</span>
            <span>Count: <strong>{selectionSummary.nonEmptyCount}</strong></span>
            {selectionSummary.numericCount > 0 ? (
              <>
                <span>Sum: <strong>{formatSummaryNumber(selectionSummary.sum)}</strong></span>
                {selectionSummary.average !== null ? (
                  <span>Average: <strong>{formatSummaryNumber(selectionSummary.average)}</strong></span>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="sheet-status-actions">
            <button
              className="sheet-copy-btn"
              onClick={() => void copySelection("tsv")}
              title="Copy selected cell(s) as tab-separated values (Ctrl+C)"
              type="button"
            >
              {copiedNotice === "tsv" ? "Copied!" : "Copy"}
            </button>
            <button
              className="sheet-copy-btn"
              onClick={() => void copySelection("csv")}
              title="Copy selected cell(s) as CSV"
              type="button"
            >
              {copiedNotice === "csv" ? "Copied CSV!" : "Copy CSV"}
            </button>
          </div>
        </div>
      ) : null}
      <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
        {sheets.map((item, index) => (
          <button
            aria-selected={active === index}
            className={active === index ? "active" : ""}
            key={`${index}-${item.name}`}
            onClick={() => switchSheet(index)}
            role="tab"
          >
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
});

function createDemoSheet(name: string, values: string[][]): WorkbookSheet {
  const width = values.reduce((largest, row) => Math.max(largest, row.length), 0);
  return {
    name,
    columns: Array.from({ length: width }, (_, index) => ({
      index: index + 1,
      label: toColumnLabel(index + 1),
      widthPx: index === 0 ? 176 : index === 1 ? 128 : 104,
    })),
    rows: values.map((row, rowIndex) => ({
      index: rowIndex + 1,
      heightPx: 30,
      cells: Array.from({ length: width }, (_, cellIndex) => {
        const value = row[cellIndex] ?? "";
        const isNumeric = /^£?[\d,]+(?:\.\d+)?$/.test(value);
        const style: NonNullable<WorkbookCell["style"]> = {};
        if (isNumeric) {
          style.textAlign = "right";
        }
        if (rowIndex === 0) {
          style.backgroundColor = "#d9e1f2";
          style.color = "#1f2d46";
          style.fontWeight = 700;
          style.borderTop = "1px solid #263244";
          style.borderBottom = "2px solid #263244";
        } else if (row[0] === "TOTAL") {
          style.backgroundColor = "#fff2cc";
          style.color = "#1f2d46";
          style.fontWeight = 700;
          style.borderTop = "1px solid #263244";
          style.borderBottom = "3px double #263244";
        } else if (row[0] === "Notes") {
          style.backgroundColor = "#fce4d6";
          style.color = "#1e4089";
          style.fontWeight = 700;
        } else if (value === "Booked" || value === "Approved") {
          style.backgroundColor = "#e2efda";
          style.color = "#1d5b2c";
          style.fontWeight = 600;
          style.textAlign = "center";
        } else if (value === "Pending" || value === "Review") {
          style.backgroundColor = "#fff2cc";
          style.color = "#7a5200";
          style.fontWeight = 600;
          style.textAlign = "center";
        }
        return {
          value,
          style: Object.keys(style).length > 0 ? style : undefined,
        };
      }),
    })),
  };
}
