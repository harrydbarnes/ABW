import type { DownloadRecord, Settings } from "../types";

export const DEMO_DOWNLOADS: DownloadRecord[] = [
  {
    id: "demo-xlsx",
    fileName: "Q2 Media Plan.xlsx",
    extension: "xlsx",
    kind: "spreadsheet",
    downloadedAt: "2026-05-26T10:42:00+01:00",
    sizeBytes: 284_500,
    sourceUrl: "https://www.wrike.com/open.htm?id=124500",
    sourceLabel: "Spring campaign delivery",
    demo: true,
  },
  {
    id: "demo-pdf",
    fileName: "Rights clearance.pdf",
    extension: "pdf",
    kind: "pdf",
    downloadedAt: "2026-05-26T09:17:00+01:00",
    sizeBytes: 1_842_120,
    sourceUrl: "https://www.wrike.com/open.htm?id=124499",
    sourceLabel: "Legal approvals",
    demo: true,
  },
  {
    id: "demo-budget",
    fileName: "Production budget.xlsx",
    extension: "xlsx",
    kind: "spreadsheet",
    downloadedAt: "2026-05-23T16:08:00+01:00",
    sizeBytes: 118_302,
    sourceUrl: "https://www.wrike.com/open.htm?id=124312",
    sourceLabel: "Summer launch budget",
    demo: true,
  },
  {
    id: "demo-brief",
    fileName: "Creative brief.pdf",
    extension: "pdf",
    kind: "pdf",
    downloadedAt: "2026-05-21T11:26:00+01:00",
    sizeBytes: 528_924,
    sourceUrl: "https://www.wrike.com/open.htm?id=124007",
    sourceLabel: "Creative handoff",
    demo: true,
  },
];

export const DEFAULT_SETTINGS: Settings = {
  spellCheck: true,
  launchWrikeOnStart: true,
  downloadNotifications: true,
  theme: "default",
  customDictionary: [],
};
