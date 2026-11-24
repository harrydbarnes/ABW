import type {
  AppUpdateCheckResult,
  AppUpdateDownloadEvent,
  ClearDownloadsResult,
  DownloadRecord,
  DownloadsStorageStats,
  Settings,
  WorkbookImage,
  WorkbookPreview,
  WrikeSession,
} from "../types";
import { DEFAULT_SETTINGS, DEMO_DOWNLOADS } from "../data/demo";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const desktopRuntime = "__TAURI_INTERNALS__" in window;

export type WrikeTabAction = "back" | "forward" | "reload";
export type WrikePane = "full" | "left" | "right";
export type WrikeTabLayout = {
  tabId: string;
  pane: WrikePane;
};

export type WrikeTabUpdate = {
  tabId: string;
  title: string;
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isTitleLoading: boolean;
};

export type WrikeShortcutAction =
  | "new-tab"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "select-tab"
  | "toggle-split"
  | "open-url";

export type WrikeShortcutEvent = {
  action: WrikeShortcutAction;
  index: number | null;
  url?: string | null;
};

export interface PdfHeadResult {
  totalSize: number;
  initialChunk: Uint8Array;
  tailOffset?: number;
  tailChunk?: Uint8Array;
  complete: boolean;
}

export function isDesktopRuntime(): boolean {
  return desktopRuntime;
}

function invokeDesktop<T>(command: string, payload?: Record<string, unknown>) {
  return invoke<T>(command, payload);
}

export async function loadDownloads(): Promise<DownloadRecord[]> {
  return desktopRuntime
    ? invokeDesktop<DownloadRecord[]>("list_downloads")
    : Promise.resolve(DEMO_DOWNLOADS);
}

export async function loadSettings(): Promise<Settings> {
  return desktopRuntime
    ? invokeDesktop<Settings>("get_settings")
    : Promise.resolve(DEFAULT_SETTINGS);
}

export async function loadStorageHealth(): Promise<string[]> {
  return desktopRuntime ? invokeDesktop<string[]>("storage_health") : [];
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  if (!desktopRuntime) {
    return {
      ...settings,
      customDictionary: normalizeDictionary(settings.customDictionary),
    };
  }
  return invokeDesktop<Settings>("update_settings", { settings });
}

export async function resetApp(): Promise<Settings> {
  if (!desktopRuntime) {
    return DEFAULT_SETTINGS;
  }
  return invokeDesktop<Settings>("reset_app");
}

export async function saveWrikeSession(session: WrikeSession): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("update_last_wrike_session", { session });
  }
}

export async function readDownloadHead(id: string): Promise<PdfHeadResult | null> {
  if (!desktopRuntime) {
    return null;
  }
  const buffer = await invokeDesktop<ArrayBuffer>("read_download_head", { id });
  if (buffer.byteLength < 20) {
    throw new Error("Invalid PDF header response.");
  }
  const view = new DataView(buffer);
  const totalLow = view.getUint32(0, true);
  const totalHigh = view.getUint32(4, true);
  const totalSize = totalHigh * 0x1_0000_0000 + totalLow;
  const headLen = view.getUint32(8, true);
  const tailLow = view.getUint32(12, true);
  const tailHigh = view.getUint32(16, true);
  const tailOffset = tailHigh * 0x1_0000_0000 + tailLow;
  if (20 + headLen > buffer.byteLength) {
    throw new Error("Invalid PDF header chunk length.");
  }
  const initialChunk = new Uint8Array(buffer, 20, headLen);
  const tailLen = buffer.byteLength - (20 + headLen);
  const tailChunk = tailLen > 0 ? new Uint8Array(buffer, 20 + headLen, tailLen) : undefined;
  return {
    totalSize,
    initialChunk,
    tailOffset: tailChunk ? tailOffset : undefined,
    tailChunk,
    complete: initialChunk.byteLength >= totalSize,
  };
}

export async function readDownloadRange(
  id: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (!desktopRuntime) {
    return new Uint8Array(0);
  }
  const buffer = await invokeDesktop<ArrayBuffer>("read_download_range", { id, start, end });
  return new Uint8Array(buffer);
}

export async function readDownloadImage(id: string): Promise<Uint8Array | null> {
  if (!desktopRuntime) {
    return null;
  }
  const buffer = await invokeDesktop<ArrayBuffer>("read_download_image", { id });
  return new Uint8Array(buffer);
}

export async function previewSpreadsheet(id: string): Promise<WorkbookPreview | null> {
  if (!desktopRuntime) {
    return null;
  }
  return invokeDesktop<WorkbookPreview>("preview_spreadsheet", { id });
}

export async function loadSpreadsheetImages(
  id: string,
  sheetIndex: number,
): Promise<WorkbookImage[]> {
  if (!desktopRuntime) {
    return [];
  }
  return invokeDesktop<WorkbookImage[]>("load_spreadsheet_images", { id, sheetIndex });
}

export async function openDownload(id: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("open_download", { id });
  }
}

export async function openDownloadsFolder(): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("open_downloads_folder");
  }
}

export async function revealDownload(id: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("reveal_download", { id });
  }
}

export async function deleteDownload(id: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("delete_download", { id });
  }
}

export async function getDownloadsStorageStats(): Promise<DownloadsStorageStats> {
  if (!desktopRuntime) {
    const totalBytes = DEMO_DOWNLOADS.reduce((sum, item) => sum + item.sizeBytes, 0);
    return {
      totalFiles: DEMO_DOWNLOADS.length,
      pinnedFiles: 0,
      totalBytes,
      unpinnedBytes: totalBytes,
    };
  }
  return invokeDesktop<DownloadsStorageStats>("downloads_storage_stats");
}

export async function clearUnpinnedDownloads(): Promise<ClearDownloadsResult> {
  if (!desktopRuntime) {
    return { removedCount: 0, freedBytes: 0 };
  }
  return invokeDesktop<ClearDownloadsResult>("clear_unpinned_downloads");
}

export async function sendTestNotification(): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("send_test_notification");
  }
}

export async function notifyUpdateAvailable(version: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("notify_update_available", { version });
  }
}

export async function setUpdateTaskbarBadge(available: boolean): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("set_update_badge", { available });
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  if (!desktopRuntime) {
    return {
      status: "up-to-date",
      currentVersion: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
      latestVersion: null,
      notes: null,
      pubDate: null,
    };
  }
  return invokeDesktop<AppUpdateCheckResult>("check_for_update");
}

export async function installAppUpdate(
  onEvent: (event: AppUpdateDownloadEvent) => void,
): Promise<void> {
  if (!desktopRuntime) {
    return;
  }
  const channel = new Channel<AppUpdateDownloadEvent>();
  channel.onmessage = onEvent;
  await invokeDesktop("install_update", { onEvent: channel });
}

export async function openSourceTask(record: DownloadRecord, tabId?: string): Promise<void> {
  if (!record.sourceUrl) {
    return;
  }
  if (desktopRuntime) {
    await invokeDesktop("open_source_task", { url: record.sourceUrl, tabId: tabId ?? null });
  } else {
    window.open(record.sourceUrl, "_blank", "noopener,noreferrer");
  }
}

export async function launchWrike(tabId: string, url?: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("launch_wrike", {
      tabId,
      url: url ?? null,
    });
  }
}

export async function suspendWrikeTab(tabId: string): Promise<boolean> {
  if (!desktopRuntime) {
    return false;
  }
  return invokeDesktop<boolean>("suspend_wrike_tab", { tabId });
}

export async function resumeWrikeTab(tabId: string): Promise<boolean> {
  if (!desktopRuntime) {
    return false;
  }
  return invokeDesktop<boolean>("resume_wrike_tab", { tabId });
}

export async function resizeWrikeTabs(
  layouts?: WrikeTabLayout[],
  topInset?: number,
  splitRatio?: number,
): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("resize_wrike_tabs", {
      layouts: layouts ?? null,
      topInset: topInset ?? null,
      splitRatio: splitRatio ?? null,
    });
  }
}

export async function hideWrike(tabIds: string[]): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("hide_wrike_tabs", { tabIds });
  }
}

export async function closeWrikeTab(tabId: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("close_wrike_tab", { tabId });
  }
}

export async function focusWrikeTab(tabId: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("focus_wrike_tab", { tabId });
  }
}

export async function wrikeTabAction(tabId: string, action: WrikeTabAction): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("wrike_tab_action", { tabId, action });
  }
}

export async function getWrikeTabState(tabId: string): Promise<WrikeTabUpdate | null> {
  if (!desktopRuntime) {
    return null;
  }
  return invokeDesktop<WrikeTabUpdate | null>("get_wrike_tab_state", { tabId });
}

export async function subscribeToWrikeTabUpdates(
  notify: (update: WrikeTabUpdate) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<WrikeTabUpdate>("wrike-tab-updated", (event) => notify(event.payload));
}

export async function subscribeToSettingsUpdates(
  notify: (settings: Settings) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<Settings>("settings-updated", (event) => notify(event.payload));
}

export async function subscribeToDownloads(refresh: () => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen("downloads-updated", refresh);
}

export async function subscribeToDownloadCompleted(
  notify: (record: DownloadRecord) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<DownloadRecord>("download-completed", (event) => notify(event.payload));
}

export async function subscribeToDownloadDeleted(
  notify: (id: string) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<string>("download-deleted", (event) => notify(event.payload));
}

export async function subscribeToDownloadErrors(notify: (message: string) => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<string>("download-capture-error", (event) => notify(event.payload));
}

export async function subscribeToOpenInNewTab(notify: (url: string) => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<string>("wrike-open-in-new-tab", (event) => notify(event.payload));
}

export async function subscribeToShareUrl(notify: (url: string) => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<string>("wrike-share-url", (event) => notify(event.payload));
}

export async function subscribeToWrikeShortcuts(
  notify: (shortcut: WrikeShortcutEvent) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<WrikeShortcutEvent>("wrike-shortcut", (event) => notify(event.payload));
}

function normalizeDictionary(words: string[]): string[] {
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, undefined, { sensitivity: "base" }));
}
