import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPdfPage,
  computePdfScale,
  createPreviewCache,
  estimatePreviewSize,
  evictLruEntries,
  formatBytes,
  formatSelectionAsCsv,
  formatSummaryNumber,
  nextPdfRotation,
  parseSpreadsheetNumber,
  PDF_PREVIEW_BYTE_LIMIT,
  toColumnLabel,
} from "../src/features/preview/previewUtils.ts";
import {
  WRIKE_HOME,
  filterAndSortDownloads,
  hasRestorableSession,
  nextTabIndexForCycle,
  normalizeUrlInput,
  normalizedStartupUrls,
  tabIndexFromShortcutDigit,
} from "../src/lib/workspaceUtils.ts";

test("formatBytes formats KB and MB cleanly", () => {
  assert.equal(formatBytes(0), "1 KB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
});

test("clampPdfPage clamps invalid, negative, and oversized page inputs", () => {
  assert.equal(clampPdfPage("1", 10), 1);
  assert.equal(clampPdfPage("4", 10), 4);
  assert.equal(clampPdfPage("99", 10), 10);
  assert.equal(clampPdfPage("0", 10), 1);
  assert.equal(clampPdfPage("-3", 10), 1);
  assert.equal(clampPdfPage("abc", 10), 1);
  assert.equal(clampPdfPage(5, 0), 1);
});

test("nextPdfRotation and computePdfScale compute fit-width, fit-page, and manual scaling", () => {
  assert.equal(nextPdfRotation(0), 90);
  assert.equal(nextPdfRotation(90), 180);
  assert.equal(nextPdfRotation(270), 0);

  assert.equal(
    computePdfScale({
      fitMode: "width",
      manualZoomPercent: 100,
      pageWidth: 500,
      pageHeight: 1000,
      containerWidth: 1056,
      containerHeight: 600,
    }),
    2,
  );

  assert.equal(
    computePdfScale({
      fitMode: "page",
      manualZoomPercent: 100,
      pageWidth: 500,
      pageHeight: 1000,
      containerWidth: 1056,
      containerHeight: 556,
    }),
    0.5,
  );

  assert.equal(
    computePdfScale({
      fitMode: "manual",
      manualZoomPercent: 400,
      pageWidth: 500,
      pageHeight: 1000,
      containerWidth: 1056,
      containerHeight: 556,
    }),
    2.6,
  );
});

test("toColumnLabel matches Excel column lettering", () => {
  assert.equal(toColumnLabel(1), "A");
  assert.equal(toColumnLabel(26), "Z");
  assert.equal(toColumnLabel(27), "AA");
  assert.equal(toColumnLabel(702), "ZZ");
  assert.equal(toColumnLabel(703), "AAA");
});

test("estimatePreviewSize estimates non-zero memory footprint for populated sheets", () => {
  assert.equal(estimatePreviewSize(null), 0);
  const size = estimatePreviewSize({
    activeSheet: 0,
    styles: [{ fontWeight: 700 }],
    sheets: [
      {
        name: "Budget",
        truncatedRows: false,
        truncatedColumns: false,
        columns: [
          { index: 1, label: "A", widthPx: 110 },
          { index: 2, label: "B", widthPx: 110 },
        ],
        rows: [
          {
            index: 1,
            heightPx: 24,
            cells: [
              { value: "Item", styleIndex: 0, colSpan: 1, rowSpan: 1 },
              { value: "$100.00", colSpan: 1, rowSpan: 1 },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(size > 400);
});

test("evictLruEntries removes oldest ready entries until under entry and byte budgets", () => {
  const cache = new Map([
    ["oldest", { accessedAt: 100, ready: true, sizeBytes: 500 }],
    ["pending", { accessedAt: 50, ready: false, sizeBytes: 100 }],
    ["middle", { accessedAt: 200, ready: true, sizeBytes: 600 }],
    ["newest", { accessedAt: 300, ready: true, sizeBytes: 400 }],
  ]);

  const evicted = evictLruEntries(cache, 1000, 2);
  assert.deepEqual(evicted, ["oldest", "middle"]);
  assert.equal(cache.has("oldest"), false);
  assert.equal(cache.has("pending"), true);
  assert.equal(cache.has("middle"), false);
  assert.equal(cache.has("newest"), true);
});

test("URL normalization accepts web/blank URLs and rejects unsafe schemes", () => {
  assert.equal(normalizeUrlInput("  wrike.com/workspace.htm  "), "https://wrike.com/workspace.htm");
  assert.equal(normalizeUrlInput("about:blank"), "about:blank");
  assert.equal(normalizeUrlInput("javascript:alert(1)"), null);
  assert.equal(normalizeUrlInput("file:///C:/secret.txt"), null);
  assert.equal(normalizeUrlInput("   "), null);

  assert.deepEqual(normalizedStartupUrls(["", "javascript:void(0)"]), [WRIKE_HOME]);
  assert.deepEqual(normalizedStartupUrls(["wrike.com", "https://wrike.com/"]), [
    "https://wrike.com/",
  ]);
});

test("hasRestorableSession detects restorable sessions", () => {
  assert.equal(hasRestorableSession(null), false);
  assert.equal(
    hasRestorableSession({
      tabs: [{ id: "home", title: "Wrike", url: "javascript:bad", mode: "standard" }],
      activeTabId: "home",
      split: null,
      savedAt: "2026-07-01T00:00:00Z",
    }),
    false,
  );
  assert.equal(
    hasRestorableSession({
      tabs: [{ id: "home", title: "Wrike", url: WRIKE_HOME, mode: "standard" }],
      activeTabId: "home",
      split: null,
      savedAt: "2026-07-01T00:00:00Z",
    }),
    true,
  );
});

test("filterAndSortDownloads prioritizes pinned files then newest timestamp", () => {
  const downloads = [
    {
      id: "old",
      fileName: "budget.xlsx",
      extension: "xlsx",
      kind: "spreadsheet",
      downloadedAt: "2026-07-01T10:00:00Z",
      sizeBytes: 1024,
      sourceUrl: null,
      sourceLabel: "Finance Task",
    },
    {
      id: "new-pdf",
      fileName: "contract.pdf",
      extension: "pdf",
      kind: "pdf",
      downloadedAt: "2026-07-03T10:00:00Z",
      sizeBytes: 2048,
      sourceUrl: null,
      sourceLabel: "Legal Review",
    },
    {
      id: "newer",
      fileName: "forecast.xlsx",
      extension: "xlsx",
      kind: "spreadsheet",
      downloadedAt: "2026-07-04T10:00:00Z",
      sizeBytes: 4096,
      sourceUrl: null,
      sourceLabel: "Q3 Planning",
    },
  ];

  const sortedAll = filterAndSortDownloads(downloads, "all", "", ["old"]);
  assert.deepEqual(
    sortedAll.map((item) => item.id),
    ["old", "newer", "new-pdf"],
  );

  const filteredByKindAndSource = filterAndSortDownloads(downloads, "spreadsheet", "finance", []);
  assert.deepEqual(
    filteredByKindAndSource.map((item) => item.id),
    ["old"],
  );

  const mixed = [
    ...downloads,
    {
      id: "previewed-img",
      fileName: "snap.png",
      extension: "png",
      kind: "image",
      downloadedAt: "2026-07-05T10:00:00Z",
      sizeBytes: 512,
      sourceUrl: null,
      sourceLabel: "Creative",
      previewed: true,
    },
  ];
  assert.deepEqual(
    filterAndSortDownloads(mixed, "all", "", [], false).map((item) => item.id),
    ["newer", "new-pdf", "old"],
  );
  assert.deepEqual(
    filterAndSortDownloads(mixed, "all", "", [], true).map((item) => item.id),
    ["previewed-img", "newer", "new-pdf", "old"],
  );
  assert.deepEqual(
    filterAndSortDownloads(mixed, "previewed", "", [], false).map((item) => item.id),
    ["previewed-img"],
  );
});

test("tab cycling and shortcut digit helpers handle wraparound and bounds", () => {
  assert.equal(nextTabIndexForCycle(0, 3, -1), 2);
  assert.equal(nextTabIndexForCycle(2, 3, 1), 0);
  assert.equal(nextTabIndexForCycle(0, 0, 1), 0);

  assert.equal(tabIndexFromShortcutDigit(1, 4), 0);
  assert.equal(tabIndexFromShortcutDigit(4, 4), 3);
  assert.equal(tabIndexFromShortcutDigit(5, 4), null);
  assert.equal(tabIndexFromShortcutDigit(9, 4), 3);
  assert.equal(tabIndexFromShortcutDigit(0, 4), null);
});

test("createPreviewCache deduplicates in-flight loads, enforces limits, and evicts by id", async () => {
  let pdfCalls = 0;
  let sheetCalls = 0;
  const cache = createPreviewCache({
    readPdfHead: async (id) => {
      pdfCalls += 1;
      return id === "streamed"
        ? { totalSize: 2 * 1024 * 1024, initialChunk: new Uint8Array(64), complete: false }
        : { totalSize: 128, initialChunk: new Uint8Array(128), complete: true };
    },
    readSpreadsheet: async () => {
      sheetCalls += 1;
      return {
        activeSheet: 0,
        styles: [],
        sheets: [
          {
            name: "Sheet1",
            truncatedRows: false,
            truncatedColumns: false,
            columns: [{ index: 1, label: "A", widthPx: 100 }],
            rows: [{ index: 1, heightPx: 24, cells: [{ value: "ok", colSpan: 1, rowSpan: 1 }] }],
          },
        ],
      };
    },
  });

  await assert.rejects(
    cache.loadPdfHead({ id: "huge", sizeBytes: PDF_PREVIEW_BYTE_LIMIT + 1 }),
    /up to 128 MB/,
  );

  const [a, b] = await Promise.all([
    cache.loadPdfHead({ id: "small", sizeBytes: 128 }),
    cache.loadPdfHead({ id: "small", sizeBytes: 128 }),
  ]);
  assert.equal(pdfCalls, 1);
  assert.equal(a?.totalSize, 128);
  assert.equal(b?.totalSize, 128);
  assert.equal(cache.pdfCacheSize(), 1);

  await cache.loadPdfHead({ id: "streamed", sizeBytes: 2 * 1024 * 1024 });
  await cache.loadPdfHead({ id: "streamed", sizeBytes: 2 * 1024 * 1024 });
  assert.equal(pdfCalls, 2);
  assert.equal(cache.pdfCacheSize(), 2);

  await Promise.all([
    cache.loadSpreadsheetPreview({ id: "sheet-1", sizeBytes: 1024 }),
    cache.loadSpreadsheetPreview({ id: "sheet-1", sizeBytes: 1024 }),
  ]);
  assert.equal(sheetCalls, 1);
  assert.equal(cache.spreadsheetCacheSize(), 1);

  cache.evictById("small");
  cache.evictById("streamed");
  cache.evictById("sheet-1");
  assert.equal(cache.pdfCacheSize(), 0);
  assert.equal(cache.spreadsheetCacheSize(), 0);
});

test("parseSpreadsheetNumber, formatSummaryNumber, and formatSelectionAsCsv handle spreadsheet values", () => {
  assert.equal(parseSpreadsheetNumber("£42,000"), 42000);
  assert.equal(parseSpreadsheetNumber("($1,234.50)"), -1234.5);
  assert.equal(parseSpreadsheetNumber(" 18.75% "), 18.75);
  assert.equal(parseSpreadsheetNumber(""), null);
  assert.equal(parseSpreadsheetNumber("Pending"), null);
  assert.equal(formatSummaryNumber(1234.567), "1,234.57");

  assert.equal(
    formatSelectionAsCsv([
      ["Plain", 'Has "quotes"', "Has, comma"],
      ["Line1\nLine2", "£100", "OK"],
    ]),
    'Plain,"Has ""quotes""","Has, comma"\r\n"Line1\nLine2",£100,OK',
  );
});

test("createPreviewCache accounts for tailChunk byteLength when enforcing PDF cache entry budget", async () => {
  const cache = createPreviewCache({
    readPdfHead: async () => ({
      totalSize: 10 * 1024 * 1024,
      initialChunk: new Uint8Array(2.5 * 1024 * 1024),
      tailOffset: 7.5 * 1024 * 1024,
      tailChunk: new Uint8Array(2.5 * 1024 * 1024),
      complete: false,
    }),
    readSpreadsheet: async () => null,
  });

  await cache.loadPdfHead({ id: "oversized-chunks", sizeBytes: 4 * 1024 * 1024 });
  assert.equal(cache.pdfCacheSize(), 0);
});
