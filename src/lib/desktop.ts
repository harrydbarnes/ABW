import type {
  AppUpdateCheckResult,
  AppUpdateDownloadEvent,
  ClearDownloadsResult,
  DownloadRecord,
  DownloadsStorageStats,
  Settings,
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

export async function loadWrikeSession(): Promise<WrikeSession | null> {
  return desktopRuntime ? invokeDesktop<WrikeSession | null>("get_wrike_session") : null;
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

export async function saveWrikeSession(session: WrikeSession): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("update_last_wrike_session", { session });
  }
}

export async function readDownload(id: string): Promise<Uint8Array | null> {
  if (!desktopRuntime) {
    return null;
  }
  const bytes = await invokeDesktop<ArrayBuffer>("read_download", { id });
  return new Uint8Array(bytes);
}

export async function readDownloadHead(id: string): Promise<PdfHeadResult | null> {
  if (!desktopRuntime) {
    return null;
  }
  const buffer = await invokeDesktop<ArrayBuffer>("read_download_head", { id });
  if (buffer.byteLength < 8) {
    throw new Error("Invalid PDF header response.");
  }
  const view = new DataView(buffer);
  const totalSize = Number(view.getBigUint64(0, true));
  const initialChunk = new Uint8Array(buffer, 8);
  return {
    totalSize,
    initialChunk,
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

export async function previewSpreadsheet(id: string): Promise<WorkbookPreview | null> {
  if (!desktopRuntime) {
    return null;
  }
  return invokeDesktop<WorkbookPreview>("preview_spreadsheet", { id });
}

export async function openDownload(id: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("open_download", { id });
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

export async function openSourceTask(
  record: DownloadRecord,
  tabId?: string,
): Promise<string | null> {
  if (!record.sourceUrl) {
    return null;
  }
  if (desktopRuntime) {
    return invokeDesktop<string>("open_source_task", {
      url: record.sourceUrl,
      tabId: tabId ?? null,
    });
  }
  window.open(record.sourceUrl, "_blank", "noopener,noreferrer");
  return null;
}

export async function launchWrike(tabId: string, url?: string, pane?: WrikePane): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("launch_wrike", { tabId, url: url ?? null, pane: pane ?? null });
  }
}

export async function resizeWrikeTabs(layouts?: WrikeTabLayout[]): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("resize_wrike_tabs", { layouts: layouts ?? null });
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

export async function subscribeToWrikeShortcuts(
  notify: (shortcut: WrikeShortcutEvent) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  return listen<WrikeShortcutEvent>("wrike-shortcut", (event) => notify(event.payload));
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

function normalizeDictionary(words: string[]): string[] {
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, undefined, { sensitivity: "base" }));
}
