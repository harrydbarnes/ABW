import type { DownloadRecord, Settings, WorkbookPreview, WrikeSession } from "../types";
import { DEFAULT_SETTINGS, DEMO_DOWNLOADS } from "../data/demo";

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

export function isDesktopRuntime(): boolean {
  return desktopRuntime;
}

async function invokeDesktop<T>(command: string, payload?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
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
  const bytes = await invokeDesktop<number[]>("read_download", { id });
  return new Uint8Array(bytes);
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

export async function sendTestNotification(): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("send_test_notification");
  }
}

export async function openSourceTask(record: DownloadRecord): Promise<void> {
  if (!record.sourceUrl) {
    return;
  }
  if (desktopRuntime) {
    await invokeDesktop("open_source_task", { url: record.sourceUrl });
  } else {
    window.open(record.sourceUrl, "_blank", "noopener,noreferrer");
  }
}

export async function launchWrike(tabId: string, url?: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("launch_wrike", { tabId, url: url ?? null });
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
  const { listen } = await import("@tauri-apps/api/event");
  return listen<WrikeTabUpdate>("wrike-tab-updated", (event) => notify(event.payload));
}

export async function subscribeToSettingsUpdates(
  notify: (settings: Settings) => void,
): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<Settings>("settings-updated", (event) => notify(event.payload));
}

export async function subscribeToDownloads(refresh: () => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen("downloads-updated", refresh);
}

export async function subscribeToDownloadErrors(notify: (message: string) => void): Promise<() => void> {
  if (!desktopRuntime) {
    return () => undefined;
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("download-capture-error", (event) => notify(event.payload));
}

function normalizeDictionary(words: string[]): string[] {
  return [...new Set(words.map((word) => word.trim()).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second, undefined, { sensitivity: "base" }));
}
