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
  WorkbookPreview,
  WorkbookSheet,
} from "../../types";
import { loadCachedSpreadsheetPreview, toColumnLabel } from "./previewCache";

const ROW_HEADER_WIDTH_PX = 38;
const COLUMN_HEADER_HEIGHT_PX = 28;

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

function parseSpreadsheetNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const negativeParens = /^\((.+)\)$/.test(trimmed);
  const unwrapped = negativeParens ? trimmed.slice(1, -1).trim() : trimmed;
  const cleaned = unwrapped.replace(/[£$€¥,\s%]/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }
  return negativeParens ? -Math.abs(value) : value;
}

function formatSummaryNumber(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
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
  stylesPalette,
  matchCols,
  activeMatchCol,
  selMinCol,
  selMaxCol,
  onStartSelection,
  onExtendSelection,
}: {
  row: WorkbookSheet["rows"][number];
  rowIndex: number;
  columns: WorkbookSheet["columns"];
  stylesPalette: CSSProperties[];
  matchCols: Set<number> | undefined;
  activeMatchCol: number;
  selMinCol: number;
  selMaxCol: number;
  onStartSelection: (rowIndex: number, cellIndex: number, shiftKey: boolean) => void;
  onExtendSelection: (rowIndex: number, cellIndex: number) => void;
}) {
  return (
    <tr style={{ height: row.heightPx }}>
      <th className="row-number">{row.index}</th>
      {row.cells.map((cell, cellIndex) => {
        if (cell.coveredByMerge) {
          return null;
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
        return (
          <td
            className={className || undefined}
            colSpan={cell.colSpan}
            data-cell-key={isMatch || isActiveMatch ? `${rowIndex}:${cellIndex}` : undefined}
            key={columns[cellIndex]?.index ?? cellIndex}
            onMouseDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              onStartSelection(rowIndex, cellIndex, event.shiftKey);
            }}
            onMouseEnter={() => onExtendSelection(rowIndex, cellIndex)}
            rowSpan={cell.rowSpan}
            style={
              cell.styleIndex !== undefined
                ? stylesPalette[cell.styleIndex]
                : cell.style
            }
          >
            {cell.value}
          </td>
        );
      })}
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
  const [problem, setProblem] = useState<string | null>(null);
  const [selection, setSelection] = useState<CellSelection | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const deferredQuery = useDeferredValue(findQuery);
  const [matchCursor, setMatchCursor] = useState(0);

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
    setCopiedNotice(false);
  }, [active, record.id]);

  useEffect(() => {
    if (!copiedNotice) {
      return;
    }
    const timer = window.setTimeout(() => setCopiedNotice(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedNotice]);

  useEffect(() => {
    let live = true;
    setProblem(null);
    setFindQuery("");
    setMatchCursor(0);
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
    if (!activeMatchKey || !scrollerRef.current) {
      return;
    }
    const target = scrollerRef.current.querySelector<HTMLElement>(
      `td[data-cell-key="${activeMatchKey}"]`,
    );
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMatchKey]);

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
    const rowsText: string[] = [];

    for (let r = normalizedBounds.minRow; r <= normalizedBounds.maxRow; r += 1) {
      const row = sheet.rows[r];
      const rowValues: string[] = [];
      for (let c = normalizedBounds.minCol; c <= normalizedBounds.maxCol; c += 1) {
        const cell = row?.cells[c];
        const value = cell && !cell.coveredByMerge ? cell.value : "";
        rowValues.push(value);
        if (value.trim() !== "") {
          nonEmptyCount += 1;
          const numeric = parseSpreadsheetNumber(value);
          if (numeric !== null) {
            numericCount += 1;
            sum += numeric;
          }
        }
      }
      rowsText.push(rowValues.join("\t"));
    }

    const startLabel = `${sheet.columns[normalizedBounds.minCol]?.label ?? toColumnLabel(normalizedBounds.minCol + 1)}${sheet.rows[normalizedBounds.minRow]?.index ?? normalizedBounds.minRow + 1}`;
    const endLabel = `${sheet.columns[normalizedBounds.maxCol]?.label ?? toColumnLabel(normalizedBounds.maxCol + 1)}${sheet.rows[normalizedBounds.maxRow]?.index ?? normalizedBounds.maxRow + 1}`;

    return {
      rangeLabel: startLabel === endLabel ? startLabel : `${startLabel}:${endLabel}`,
      nonEmptyCount,
      numericCount,
      sum,
      average: numericCount > 0 ? sum / numericCount : null,
      tsv: rowsText.join("\n"),
    };
  }, [normalizedBounds, sheet]);

  const copySelection = useCallback(async () => {
    if (!selectionSummary) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selectionSummary.tsv);
      setCopiedNotice(true);
    } catch {
      // Clipboard API unavailable
    }
  }, [selectionSummary]);

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
        scrollerRef.current.scrollTop = saved?.top ?? 0;
        scrollerRef.current.scrollLeft = saved?.left ?? 0;
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

  const totalTableWidth =
    ROW_HEADER_WIDTH_PX + sheet.columns.reduce((sum, column) => sum + column.widthPx, 0);

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
        <div
          className="sheet-stage"
          style={{
            zoom: `${zoom}%`,
            width: totalTableWidth,
          }}
        >
          <table className="sheet" style={{ width: totalTableWidth }}>
            <colgroup>
              <col className="row-number-column" />
              {sheet.columns.map((column) => (
                <col key={column.index} style={{ width: column.widthPx }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="row-number" />
                {sheet.columns.map((column) => (
                  <th key={column.index}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, rowIndex) => {
                const inSelectedRow = Boolean(
                  normalizedBounds &&
                    rowIndex >= normalizedBounds.minRow &&
                    rowIndex <= normalizedBounds.maxRow,
                );
                return (
                  <SheetRow
                    activeMatchCol={activeMatch?.row === rowIndex ? activeMatch.col : -1}
                    columns={sheet.columns}
                    key={row.index}
                    matchCols={matchesByRow.get(rowIndex)}
                    onExtendSelection={extendSelection}
                    onStartSelection={startSelection}
                    row={row}
                    rowIndex={rowIndex}
                    selMaxCol={inSelectedRow && normalizedBounds ? normalizedBounds.maxCol : -1}
                    selMinCol={inSelectedRow && normalizedBounds ? normalizedBounds.minCol : -1}
                    stylesPalette={stylesPalette}
                  />
                );
              })}
            </tbody>
          </table>
          {sheet.images?.map((image, index) => (
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
          ))}
        </div>
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
              onClick={() => void copySelection()}
              title="Copy selected cell(s) (Ctrl+C)"
              type="button"
            >
              {copiedNotice ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}
      <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
        {sheets.map((item, index) => (
          <button
            aria-selected={active === index}
            className={active === index ? "active" : ""}
            key={item.name}
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
