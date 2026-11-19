import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import type { DownloadRecord, WorkbookPreview, WorkbookSheet } from "../../types";
import { loadCachedSpreadsheetPreview, toColumnLabel } from "./previewCache";

const DEMO_STYLES: CSSProperties[] = [
  { backgroundColor: "#f7f9fd", color: "#35445c", fontWeight: 650 },
  { fontWeight: 650 },
  { color: "#1e4089", fontWeight: 650 },
];

const DEMO_PREVIEW: WorkbookPreview = {
  activeSheet: 0,
  styles: DEMO_STYLES,
  sheets: [
    createDemoSheet("Overview", [
      ["Channel", "Owner", "Apr", "May", "Jun", "Q2 total", "Status"],
      ["Paid social", "Alex Morris", "42,000", "45,500", "48,000", "135,500", "Booked"],
      ["Connected TV", "Priya Shah", "72,000", "70,000", "76,000", "218,000", "Pending"],
      ["Audio", "Ben Howard", "18,600", "21,400", "19,800", "59,800", "Booked"],
      ["Display", "Alex Morris", "12,500", "14,000", "14,000", "40,500", "Approved"],
      ["Out of home", "Jo Clarke", "31,000", "38,000", "40,000", "109,000", "Review"],
      ["TOTAL", "", "176,100", "188,900", "197,800", "562,800", ""],
      ["", "", "", "", "", "", ""],
      ["Notes", "", "", "", "", "", ""],
      ["Forecast includes pacing adjustments approved on 18 May.", "", "", "", "", "", ""],
      ["Budgets include platform and production fees.", "", "", "", "", "", ""],
    ]),
    createDemoSheet("Placements", [
      ["Placement", "Market", "Start", "End", "Budget"],
      ["CTV prime", "UK", "01 Apr", "30 Jun", "218,000"],
      ["Paid social video", "UK", "07 Apr", "30 Jun", "135,500"],
    ]),
    createDemoSheet("Approvals", [
      ["Item", "Approver", "Decision"],
      ["CTV allocation", "Finance", "Pending"],
      ["Display allocation", "Client", "Approved"],
    ]),
  ],
};

interface CellMatch {
  row: number;
  col: number;
}

interface SelectedCell {
  row: number;
  col: number;
  label: string;
  value: string;
}

const SheetRow = memo(function SheetRow({
  row,
  rowIndex,
  columns,
  stylesPalette,
  matchCols,
  activeMatchCol,
  selectedCol,
  onSelectCell,
}: {
  row: WorkbookSheet["rows"][number];
  rowIndex: number;
  columns: WorkbookSheet["columns"];
  stylesPalette: CSSProperties[];
  matchCols: Set<number> | undefined;
  activeMatchCol: number;
  selectedCol: number;
  onSelectCell: (rowIndex: number, cellIndex: number, value: string) => void;
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
        const isSelected = cellIndex === selectedCol;
        const className = [
          isActiveMatch ? "sheet-match active" : isMatch ? "sheet-match" : "",
          isSelected ? "sheet-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <td
            className={className || undefined}
            colSpan={cell.colSpan}
            data-cell-key={isMatch || isActiveMatch ? `${rowIndex}:${cellIndex}` : undefined}
            key={columns[cellIndex]?.index ?? cellIndex}
            onClick={() => onSelectCell(rowIndex, cellIndex, cell.value)}
            rowSpan={cell.rowSpan}
            style={cell.styleIndex !== undefined ? stylesPalette[cell.styleIndex] : undefined}
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
  onOpenInWindows,
}: {
  record: DownloadRecord;
  demo: boolean;
  onOpenInWindows?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const sheetScrollRef = useRef<Map<number, { top: number; left: number }>>(new Map());
  const copyFeedbackTimer = useRef(0);
  const [preview, setPreview] = useState<WorkbookPreview | null>(demo ? DEMO_PREVIEW : null);
  const [active, setActive] = useState(demo ? DEMO_PREVIEW.activeSheet : 0);
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(!demo);
  const [problem, setProblem] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const deferredQuery = useDeferredValue(findQuery);
  const [matchCursor, setMatchCursor] = useState(0);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  const [copiedNotice, setCopiedNotice] = useState(false);

  useEffect(() => {
    let live = true;
    setProblem(null);
    setFindQuery("");
    setMatchCursor(0);
    setSelectedCell(null);
    setCopiedNotice(false);
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

  useEffect(() => {
    return () => {
      window.clearTimeout(copyFeedbackTimer.current);
    };
  }, []);

  const sheets = preview?.sheets ?? [];
  const sheet = sheets[Math.min(active, Math.max(sheets.length - 1, 0))];
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
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
    setSelectedCell(null);
    setCopiedNotice(false);
    setActive(nextIndex);
    window.requestAnimationFrame(() => {
      const saved = sheetScrollRef.current.get(nextIndex);
      if (scrollerRef.current) {
        scrollerRef.current.scrollTop = saved?.top ?? 0;
        scrollerRef.current.scrollLeft = saved?.left ?? 0;
      }
    });
  }

  const selectCell = useCallback((rowIndex: number, cellIndex: number, value: string) => {
    const activeSheet = sheetRef.current;
    if (!activeSheet) {
      return;
    }
    const colLabel = activeSheet.columns[cellIndex]?.label ?? toColumnLabel(cellIndex + 1);
    const rowLabel = activeSheet.rows[rowIndex]?.index ?? rowIndex + 1;
    setSelectedCell({
      row: rowIndex,
      col: cellIndex,
      label: `${colLabel}${rowLabel}`,
      value,
    });
    setCopiedNotice(false);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  function copySelectedCell() {
    if (!selectedCell || !navigator.clipboard?.writeText) {
      return;
    }
    void navigator.clipboard
      .writeText(selectedCell.value)
      .then(() => {
        setCopiedNotice(true);
        window.clearTimeout(copyFeedbackTimer.current);
        copyFeedbackTimer.current = window.setTimeout(() => {
          setCopiedNotice(false);
        }, 1600);
      })
      .catch(() => {});
  }

  function handleViewKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = event.key.toLowerCase();
    if (event.ctrlKey && !event.metaKey && !event.altKey && key === "f") {
      event.preventDefault();
      openFindBar();
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && key === "c") {
      const target = event.target;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      const selection = window.getSelection();
      const hasRangeSelection = Boolean(selection && !selection.isCollapsed && selection.toString());
      if (!isTextInput && !hasRangeSelection && selectedCell) {
        event.preventDefault();
        copySelectedCell();
      }
    } else if (event.key === "Escape") {
      if (findOpen) {
        event.preventDefault();
        setFindOpen(false);
        setFindQuery("");
      } else if (selectedCell) {
        setSelectedCell(null);
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

  const isTruncated = Boolean(sheet.truncatedRows || sheet.truncatedColumns);

  return (
    <div className="spreadsheet-view" onKeyDown={handleViewKeyDown} ref={rootRef} tabIndex={0}>
      <div className="document-toolbar">
        <span className="spreadsheet-status">
          {selectedCell ? (
            <strong className="sheet-cell-badge" title="Press Ctrl+C to copy selected cell">
              {selectedCell.label}
              {copiedNotice ? " · Copied" : ""}
            </strong>
          ) : null}
          {sheet.rows.length} visible rows · {sheet.columns.length} visible columns
        </span>
        <div className="spreadsheet-toolbar-actions">
          {findOpen ? (
            <div className="sheet-find-bar" role="search" aria-label="Find in active sheet">
              <input
                aria-label="Find in active sheet"
                onChange={(event) => setFindQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    stepMatch(event.shiftKey ? -1 : 1);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setFindOpen(false);
                    setFindQuery("");
                  }
                }}
                placeholder="Find in sheet"
                ref={findInputRef}
                value={findQuery}
              />
              <span className="sheet-find-count">
                {findQuery.trim()
                  ? matches.length
                    ? `${Math.min(matchCursor + 1, matches.length)}/${matches.length}`
                    : "0"
                  : ""}
              </span>
              <button
                aria-label="Previous match"
                disabled={!matches.length}
                onClick={() => stepMatch(-1)}
                title="Previous match (Shift+Enter)"
              >
                ↑
              </button>
              <button
                aria-label="Next match"
                disabled={!matches.length}
                onClick={() => stepMatch(1)}
                title="Next match (Enter)"
              >
                ↓
              </button>
              <button
                aria-label="Close find bar"
                onClick={() => {
                  setFindOpen(false);
                  setFindQuery("");
                }}
                title="Close (Esc)"
              >
                ✕
              </button>
            </div>
          ) : (
            <button onClick={openFindBar} title="Find in sheet (Ctrl+F)">
              Find
            </button>
          )}
          <div className="zoom-control">
            <button onClick={() => setZoom((current) => Math.max(current - 10, 60))}>-</button>
            <span>{zoom}%</span>
            <button onClick={() => setZoom((current) => Math.min(current + 10, 160))}>+</button>
          </div>
        </div>
      </div>
      {isTruncated ? (
        <div className="sheet-truncation-banner" role="status">
          <span>
            Showing the first {sheet.rows.length} rows and {sheet.columns.length} columns for fast preview.
          </span>
          {onOpenInWindows && !demo ? (
            <button className="inline-link" onClick={onOpenInWindows}>
              Open full workbook in Windows
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="sheet-scroller" ref={scrollerRef}>
        <table className="sheet" style={{ zoom: `${zoom}%` }}>
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
            {sheet.rows.map((row, rowIndex) => (
              <SheetRow
                activeMatchCol={activeMatch?.row === rowIndex ? activeMatch.col : -1}
                columns={sheet.columns}
                key={row.index}
                matchCols={matchesByRow.get(rowIndex)}
                onSelectCell={selectCell}
                row={row}
                rowIndex={rowIndex}
                selectedCol={selectedCell?.row === rowIndex ? selectedCell.col : -1}
                stylesPalette={stylesPalette}
              />
            ))}
          </tbody>
        </table>
      </div>
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
      widthPx: index === 0 ? 176 : 98,
    })),
    rows: values.map((row, rowIndex) => ({
      index: rowIndex + 1,
      heightPx: 31,
      cells: Array.from({ length: width }, (_, cellIndex) => ({
        value: row[cellIndex] ?? "",
        styleIndex:
          rowIndex === 0 ? 0 : row[0] === "TOTAL" ? 1 : row[0] === "Notes" ? 2 : undefined,
      })),
    })),
  };
}
