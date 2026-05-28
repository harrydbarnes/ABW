import type { DownloadRecord, Settings, WorkbookPreview } from "../types";
import { DEFAULT_SETTINGS, DEMO_DOWNLOADS } from "../data/demo";

const desktopRuntime = "__TAURI_INTERNALS__" in window;

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
    return settings;
  }
  return invokeDesktop<Settings>("update_settings", { settings });
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

export async function launchWrike(tabId: string): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("launch_wrike", { tabId });
  }
}

export async function hideWrike(tabIds: string[]): Promise<void> {
  if (desktopRuntime) {
    await invokeDesktop("hide_wrike_tabs", { tabIds });
  }
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
