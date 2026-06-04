import type { CSSProperties } from "react";

export type FileKind = "pdf" | "spreadsheet" | "document" | "other";

export interface DownloadRecord {
  id: string;
  fileName: string;
  extension: string;
  kind: FileKind;
  downloadedAt: string;
  sizeBytes: number;
  sourceUrl: string | null;
  sourceLabel: string;
  demo?: boolean;
}

export interface Settings {
  spellCheck: boolean;
  launchWrikeOnStart: boolean;
  downloadNotifications: boolean;
  theme: AppThemeId;
  customDictionary: string[];
  startupTabUrls: string[];
  pinnedDownloadIds: string[];
  lastWrikeSession: WrikeSession | null;
}

export interface WrikeSessionTab {
  id: string;
  title: string;
  url: string | null;
  mode: "standard" | "readOnly";
}

export interface WrikeSession {
  tabs: WrikeSessionTab[];
  activeTabId: string;
  split: {
    leftTabId: string;
    rightTabId: string;
  } | null;
  savedAt: string;
}

export interface WorkbookSheet {
  name: string;
  columns: WorkbookColumn[];
  rows: WorkbookRow[];
}

export interface WorkbookColumn {
  index: number;
  label: string;
  widthPx: number;
}

export interface WorkbookRow {
  index: number;
  heightPx: number;
  cells: WorkbookCell[];
}

export interface WorkbookCell {
  value: string;
  style?: CSSProperties;
  colSpan?: number;
  rowSpan?: number;
  coveredByMerge?: boolean;
}

export interface WorkbookPreview {
  sheets: WorkbookSheet[];
  activeSheet: number;
}

export type FileFilter = "all" | FileKind;

export const APP_THEMES = [
  { id: "default", label: "Default" },
  { id: "midnight", label: "Midnight" },
  { id: "halloween", label: "Halloween" },
  { id: "winter-holiday", label: "Winter holiday" },
  { id: "winter-white", label: "Winter white" },
  { id: "merlot", label: "Merlot" },
  { id: "blue-skies", label: "Blue skies" },
  { id: "blueberry-pie", label: "Blueberry pie" },
  { id: "imperial-purple", label: "Imperial purple" },
  { id: "cappuccino", label: "Cappuccino" },
  { id: "blue-steel", label: "Blue steel" },
  { id: "aquamarine", label: "Aquamarine" },
  { id: "legendary-leopard", label: "Legendary leopard" },
  { id: "velvet-cosmos", label: "Velvet cosmos" },
  { id: "monochrome", label: "Monochrome" },
  { id: "pumpkin-spice", label: "Pumpkin spice" },
  { id: "flamingo", label: "Flamingo" },
  { id: "cool-confetti", label: "Cool confetti" },
  { id: "woodland-grass", label: "Woodland grass" },
] as const;

export type AppThemeId = (typeof APP_THEMES)[number]["id"];
