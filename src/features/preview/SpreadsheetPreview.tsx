import { useEffect, useState } from "react";
import type { DownloadRecord, WorkbookPreview, WorkbookSheet } from "../../types";
import { loadCachedSpreadsheetPreview } from "./previewCache";

const DEMO_PREVIEW: WorkbookPreview = {
  activeSheet: 0,
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

export default function SpreadsheetPreview({
  record,
  demo,
}: {
  record: DownloadRecord;
  demo: boolean;
}) {
  const [preview, setPreview] = useState<WorkbookPreview | null>(demo ? DEMO_PREVIEW : null);
  const [active, setActive] = useState(demo ? DEMO_PREVIEW.activeSheet : 0);
  const [zoom, setZoom] = useState(100);
  const [loading, setLoading] = useState(!demo);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setProblem(null);
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
      .catch(() => {
        if (live) {
          setProblem("Spreadsheet preview could not be rendered.");
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [demo, record.id]);

  const sheets = preview?.sheets ?? [];
  const sheet = sheets[Math.min(active, Math.max(sheets.length - 1, 0))];

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

  return (
    <div className="spreadsheet-view">
      <div className="document-toolbar">
        <span>
          {sheet.rows.length} visible rows · {sheet.columns.length} visible columns
        </span>
        <div className="zoom-control">
          <button onClick={() => setZoom((current) => Math.max(current - 10, 60))}>-</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((current) => Math.min(current + 10, 160))}>+</button>
        </div>
      </div>
      <div className="sheet-scroller">
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
            {sheet.rows.map((row) => (
              <tr key={row.index} style={{ height: row.heightPx }}>
                <th className="row-number">{row.index}</th>
                {row.cells.map((cell, cellIndex) =>
                  cell.coveredByMerge ? null : (
                    <td
                      colSpan={cell.colSpan}
                      key={sheet.columns[cellIndex]?.index ?? cellIndex}
                      rowSpan={cell.rowSpan}
                      style={cell.style}
                    >
                      {cell.value}
                    </td>
                  ),
                )}
              </tr>
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
            onClick={() => setActive(index)}
            role="tab"
          >
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}

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
        style:
          rowIndex === 0
            ? { backgroundColor: "#f7f9fd", color: "#35445c", fontWeight: 650 }
            : row[0] === "TOTAL"
              ? { fontWeight: 650 }
              : row[0] === "Notes"
                ? { color: "#1e4089", fontWeight: 650 }
                : undefined,
      })),
    })),
  };
}

function toColumnLabel(index: number) {
  let label = "";
  let remainder = index;
  while (remainder > 0) {
    const letter = (remainder - 1) % 26;
    label = String.fromCharCode(65 + letter) + label;
    remainder = Math.floor((remainder - letter - 1) / 26);
  }
  return label;
}
