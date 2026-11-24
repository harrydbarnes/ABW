import type { DownloadRecord, FileFilter, WrikeSession } from "../types";

export const WRIKE_HOME = "https://www.wrike.com/workspace.htm";

export function normalizeUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate =
    trimmed.includes("://") || trimmed === "about:blank" ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" || url.href === "about:blank"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function normalizedStartupUrls(urls: string[]): string[] {
  const normalized = urls
    .map(normalizeUrlInput)
    .filter((url): url is string => Boolean(url));
  return normalized.length ? [...new Set(normalized)] : [WRIKE_HOME];
}

export function hasRestorableSession(session: WrikeSession | null): session is WrikeSession {
  return Boolean(session?.tabs.some((tab) => normalizeUrlInput(tab.url ?? "")));
}

export function filterAndSortDownloads(
  downloads: DownloadRecord[],
  filter: FileFilter,
  search: string,
  pinnedDownloadIds: string[],
): DownloadRecord[] {
  const query = search.trim().toLowerCase();
  const pinnedIds = new Set(pinnedDownloadIds);
  const matching: Array<{ record: DownloadRecord; pinned: boolean; timestamp: number }> = [];
  for (const record of downloads) {
    if (filter !== "all" && record.kind !== filter) {
      continue;
    }
    if (
      query.length > 0 &&
      !record.fileName.toLowerCase().includes(query) &&
      !record.sourceLabel.toLowerCase().includes(query)
    ) {
      continue;
    }
    matching.push({
      record,
      pinned: pinnedIds.has(record.id),
      timestamp: Date.parse(record.downloadedAt) || 0,
    });
  }
  matching.sort((first, second) => {
    if (first.pinned !== second.pinned) {
      return first.pinned ? -1 : 1;
    }
    return second.timestamp - first.timestamp;
  });
  return matching.map((entry) => entry.record);
}

export function nextTabIndexForCycle(currentIndex: number, tabCount: number, delta: 1 | -1): number {
  if (tabCount <= 0) {
    return 0;
  }
  const safeCurrent = Math.max(0, Math.min(currentIndex, tabCount - 1));
  return (safeCurrent + delta + tabCount) % tabCount;
}

export function tabIndexFromShortcutDigit(digit: number, tabCount: number): number | null {
  if (tabCount <= 0 || digit < 1 || digit > 9) {
    return null;
  }
  if (digit === 9) {
    return tabCount - 1;
  }
  return digit - 1 < tabCount ? digit - 1 : null;
}
