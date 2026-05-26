import { useEffect, useState } from "react";
import { previewSpreadsheet } from "../../lib/desktop";
import type { WorkbookSheet } from "../../types";

const DEMO_SHEETS: WorkbookSheet[] = [
  {
    name: "Overview",
    rows: [
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
    ],
  },
  {
    name: "Placements",
    rows: [
      ["Placement", "Market", "Start", "End", "Budget"],
      ["CTV prime", "UK", "01 Apr", "30 Jun", "218,000"],
      ["Paid social video", "UK", "07 Apr", "30 Jun", "135,500"],
    ],
  },
  {
    name: "Approvals",
    rows: [
      ["Item", "Approver", "Decision"],
      ["CTV allocation", "Finance", "Pending"],
      ["Display allocation", "Client", "Approved"],
    ],
  },
];

export default function SpreadsheetPreview({ id, demo }: { id: string; demo: boolean }) {
  const [sheets, setSheets] = useState<WorkbookSheet[]>(demo ? DEMO_SHEETS : []);
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setActive(0);
    setProblem(null);
    if (demo) {
      setSheets(DEMO_SHEETS);
      return;
    }
    void previewSpreadsheet(id)
      .then((preview) => setSheets(preview?.sheets ?? []))
      .catch(() => setProblem("Spreadsheet preview could not be rendered."));
  }, [demo, id]);

  const sheet = sheets[Math.min(active, Math.max(sheets.length - 1, 0))];
  const width = sheet?.rows.reduce((columns, row) => Math.max(columns, row.length), 0) ?? 0;
  const columnLetters = Array.from({ length: width }, (_, index) => toColumnLabel(index));

  if (problem) {
    return <div className="preview-error">{problem}</div>;
  }

  if (!sheet) {
    return <div className="unsupported-preview">This workbook has no visible worksheets.</div>;
  }

  return (
    <div className="spreadsheet-view">
      <div className="document-toolbar">
        <span>{sheet.rows.length} rows visible</span>
        <div className="zoom-control">
          <button onClick={() => setZoom((current) => Math.max(current - 10, 60))}>-</button>
          <span>{zoom}%</span>
          <button onClick={() => setZoom((current) => Math.min(current + 10, 160))}>+</button>
        </div>
      </div>
      <div className="sheet-scroller">
        <table className="sheet" style={{ zoom: `${zoom}%` }}>
          <thead>
            <tr>
              <th className="row-number" />
              {columnLetters.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr
                className={[
                  rowIndex === 0 ? "heading-row" : "",
                  row[0] === "TOTAL" ? "total-row" : "",
                  row[0] === "Notes" ? "notes-row" : "",
                ].join(" ")}
                key={rowIndex}
              >
                <th className="row-number">{rowIndex + 1}</th>
                {columnLetters.map((_, cellIndex) => (
                  <td key={cellIndex}>{row[cellIndex] ?? ""}</td>
                ))}
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

function toColumnLabel(index: number) {
  let label = "";
  let remainder = index + 1;
  while (remainder > 0) {
    const letter = (remainder - 1) % 26;
    label = String.fromCharCode(65 + letter) + label;
    remainder = Math.floor((remainder - letter) / 26);
  }
  return label;
}
