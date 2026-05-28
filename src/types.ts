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
  customDictionary: string[];
}

export interface WorkbookSheet {
  name: string;
  rows: string[][];
}

export interface WorkbookPreview {
  sheets: WorkbookSheet[];
}

export type FileFilter = "all" | FileKind;
