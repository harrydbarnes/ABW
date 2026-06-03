import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useRef,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FilesLibrary } from "./features/files/FilesLibrary";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import {
  closeWrikeTab,
  focusWrikeTab,
  getWrikeTabState,
  launchWrike,
  hideWrike,
  isDesktopRuntime,
  loadDownloads,
  loadSettings,
  resizeWrikeTabs,
  saveSettings,
  saveWrikeSession,
  sendTestNotification,
  subscribeToDownloadErrors,
  subscribeToDownloads,
  subscribeToSettingsUpdates,
  subscribeToWrikeTabUpdates,
  wrikeTabAction,
  type WrikeTabAction,
  type WrikeTabLayout,
  type WrikeTabUpdate,
} from "./lib/desktop";
import type { DownloadRecord, FileFilter, Settings, WrikeSession } from "./types";

const PreviewPanel = lazy(() => import("./features/preview/PreviewPanel"));
const WRIKE_HOME = "https://www.wrike.com/workspace.htm";
const READ_ONLY_URL = "https://login.wrike.com/login/?forceLogin=false&read";
const APP_VERSION = "0.1.1";

type Screen = "wrike" | "files" | "settings";
type WrikeTabMode = "standard" | "readOnly";
type WrikePaneSide = "left" | "right";
type WrikeSplit = {
  leftTabId: string;
  rightTabId: string;
};
type WrikeTab = {
  id: string;
  title: string;
  url: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isTitleLoading: boolean;
  mode: WrikeTabMode;
};

const INITIAL_WRIKE_TAB: WrikeTab = {
  id: "home",
  title: "Wrike",
  url: null,
  canGoBack: false,
  canGoForward: false,
  isTitleLoading: false,
  mode: "standard",
};

function applyWrikeTabUpdate(tab: WrikeTab, update: WrikeTabUpdate): WrikeTab {
  const nextTitle = update.title.trim();
  const isTitleLoading = tab.mode === "readOnly" ? false : update.isTitleLoading;
  const title =
    tab.mode === "readOnly"
      ? "Read Only Mode"
      : isTitleLoading
        ? tab.title || nextTitle || "Wrike"
        : nextTitle || tab.title || "Wrike";
  return {
    ...tab,
    canGoBack: update.canGoBack,
    canGoForward: update.canGoForward,
    isTitleLoading,
    title,
    url: update.url,
  };
}

export function App() {
  const [isLaunchSplashVisible, setIsLaunchSplashVisible] = useState(true);
  const [screen, setScreen] = useState<Screen>("wrike");
  const [wrikeTabs, setWrikeTabs] = useState<WrikeTab[]>([INITIAL_WRIKE_TAB]);
  const [activeWrikeTabId, setActiveWrikeTabId] = useState(INITIAL_WRIKE_TAB.id);
  const [wrikeSplit, setWrikeSplit] = useState<WrikeSplit | null>(null);
  const [newWrikeTabId, setNewWrikeTabId] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [splitDropSide, setSplitDropSide] = useState<WrikePaneSide | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [isTopbarActionsMenuOpen, setIsTopbarActionsMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<FileFilter>("all");
  const [settings, setSettings] = useState<Settings>({
    spellCheck: true,
    launchWrikeOnStart: true,
    downloadNotifications: true,
    theme: "default",
    customDictionary: [],
    startupTabUrls: [WRIKE_HOME],
    pinnedDownloadIds: [],
    lastWrikeSession: null,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionPrompt, setSessionPrompt] = useState<WrikeSession | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [reloadingTabId, setReloadingTabId] = useState<string | null>(null);
  const wrikeTabsRef = useRef(wrikeTabs);
  const activeWrikeTabIdRef = useRef(activeWrikeTabId);
  const wrikeSplitRef = useRef(wrikeSplit);
  const canPersistSessionRef = useRef(false);
  const reloadAnimationTimerRef = useRef<number | undefined>(undefined);
  const sessionSaveTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const splashTimer = window.setTimeout(() => setIsLaunchSplashVisible(false), 2800);
    return () => window.clearTimeout(splashTimer);
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(reloadAnimationTimerRef.current);
      window.clearTimeout(sessionSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    wrikeTabsRef.current = wrikeTabs;
  }, [wrikeTabs]);

  useEffect(() => {
    activeWrikeTabIdRef.current = activeWrikeTabId;
  }, [activeWrikeTabId]);

  useEffect(() => {
    wrikeSplitRef.current = wrikeSplit;
  }, [wrikeSplit]);

  useEffect(() => {
    if (!canPersistSessionRef.current) {
      return;
    }
    window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = window.setTimeout(() => {
      void saveWrikeSession(currentWrikeSession()).catch(() => undefined);
    }, 450);
    return () => window.clearTimeout(sessionSaveTimerRef.current);
  }, [activeWrikeTabId, wrikeSplit, wrikeTabs]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const noticeTimer = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(noticeTimer);
  }, [notice]);

  useEffect(() => {
    const refresh = () => {
      void loadDownloads().then((records) => {
        setDownloads(records);
        setSelectedId((current) => current ?? records[0]?.id ?? null);
      });
    };
    refresh();
    void loadSettings().then((next) => {
      setSettings(next);
      if (hasRestorableSession(next.lastWrikeSession)) {
        setSessionPrompt(next.lastWrikeSession);
      }
      if (next.launchWrikeOnStart) {
        void openStartupTabs(next.startupTabUrls).then(() => {
          if (!hasRestorableSession(next.lastWrikeSession)) {
            canPersistSessionRef.current = true;
          }
        });
      } else {
        setScreen("files");
        if (!hasRestorableSession(next.lastWrikeSession)) {
          canPersistSessionRef.current = true;
        }
      }
    });
    let dispose: () => void = () => undefined;
    let disposeErrors: () => void = () => undefined;
    let disposeTabUpdates: () => void = () => undefined;
    let disposeSettingsUpdates: () => void = () => undefined;
    void subscribeToDownloads(refresh).then((unsubscribe) => {
      dispose = unsubscribe;
    });
    void subscribeToDownloadErrors((message) => {
      setNotice(`Download was not added to Files: ${message}`);
    }).then((unsubscribe) => {
      disposeErrors = unsubscribe;
    });
    void subscribeToWrikeTabUpdates((update) => {
      setWrikeTabs((current) =>
        current.map((tab) =>
          tab.id === update.tabId ? applyWrikeTabUpdate(tab, update) : tab,
        ),
      );
    }).then((unsubscribe) => {
      disposeTabUpdates = unsubscribe;
    });
    void subscribeToSettingsUpdates((next) => {
      setSettings(next);
    }).then((unsubscribe) => {
      disposeSettingsUpdates = unsubscribe;
    });
    return () => {
      dispose();
      disposeErrors();
      disposeTabUpdates();
      disposeSettingsUpdates();
    };
  }, []);

  useEffect(() => {
    const closeMenu = () => {
      setTabMenu(null);
      void closeTopbarActionsMenu();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeWrikeTabId, isTopbarActionsMenuOpen, screen, wrikeTabs]);

  useEffect(() => {
    let resizeTimer: number | undefined;
    let unlistenResize: (() => void) | undefined;
    const syncWrikeBounds = () => {
      if (!isDesktopRuntime()) {
        return;
      }
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void resizeCurrentWrikeTabs().catch(() => undefined), 80);
    };
    if (isDesktopRuntime()) {
      const appWindow = getCurrentWindow();
      void appWindow.isMaximized().then(setIsWindowMaximized).catch(() => undefined);
      void appWindow.onResized(() => {
        void appWindow.isMaximized().then(setIsWindowMaximized).catch(() => undefined);
      }).then((dispose) => {
        unlistenResize = dispose;
      });
    }
    window.addEventListener("resize", syncWrikeBounds);
    return () => {
      window.clearTimeout(resizeTimer);
      unlistenResize?.();
      window.removeEventListener("resize", syncWrikeBounds);
    };
  }, []);

  const visibleDownloads = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    const pinnedIds = new Set(settings.pinnedDownloadIds);
    return downloads.filter((record) => {
      const kindMatches = filter === "all" || record.kind === filter;
      const queryMatches =
        query.length === 0 ||
        record.fileName.toLowerCase().includes(query) ||
        record.sourceLabel.toLowerCase().includes(query);
      return kindMatches && queryMatches;
    }).sort((first, second) => {
      const firstPinned = pinnedIds.has(first.id);
      const secondPinned = pinnedIds.has(second.id);
      if (firstPinned !== secondPinned) {
        return firstPinned ? -1 : 1;
      }
      return new Date(second.downloadedAt).getTime() - new Date(first.downloadedAt).getTime();
    });
  }, [deferredSearch, downloads, filter, settings.pinnedDownloadIds]);

  const selectedRecord =
    visibleDownloads.find((record) => record.id === selectedId) ?? visibleDownloads[0] ?? null;

  function normalizeUrlInput(value: string): string | null {
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

  function normalizedStartupUrls(urls = settings.startupTabUrls) {
    const normalized = urls
      .map(normalizeUrlInput)
      .filter((url): url is string => Boolean(url));
    return normalized.length ? [...new Set(normalized)] : [WRIKE_HOME];
  }

  function hasRestorableSession(session: WrikeSession | null): session is WrikeSession {
    return Boolean(session?.tabs.some((tab) => normalizeUrlInput(tab.url ?? "")));
  }

  function wrikeModeForUrl(url: string): WrikeTabMode {
    return url === READ_ONLY_URL ? "readOnly" : "standard";
  }

  function createWrikeTab(tabId: string, title: string, url: string, mode = wrikeModeForUrl(url)): WrikeTab {
    return {
      id: tabId,
      title,
      url,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: mode === "standard",
      mode,
    };
  }

  function currentWrikeSession(): WrikeSession {
    return {
      tabs: wrikeTabsRef.current.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url ?? normalizedStartupUrls()[0],
        mode: tab.mode,
      })),
      activeTabId: activeWrikeTabIdRef.current,
      split: wrikeSplitRef.current,
      savedAt: new Date().toISOString(),
    };
  }

  async function openWrikeTabSet(nextTabs: WrikeTab[], nextActiveTabId: string, nextSplit: WrikeSplit | null) {
    const nextIds = new Set(nextTabs.map((tab) => tab.id));
    const oldTabs = wrikeTabsRef.current.filter((tab) => !nextIds.has(tab.id));
    for (const tab of oldTabs) {
      await closeWrikeTab(tab.id).catch(() => undefined);
    }
    wrikeTabsRef.current = nextTabs;
    syncWrikeSplitRef(nextSplit);
    syncActiveWrikeTabId(nextActiveTabId);
    setWrikeTabs(nextTabs);
    setScreen("wrike");
    const visibleIds =
      nextSplit && nextIds.has(nextSplit.leftTabId) && nextIds.has(nextSplit.rightTabId)
        ? [nextSplit.leftTabId, nextSplit.rightTabId]
        : [nextActiveTabId];
    const launchOrder = [
      ...nextTabs.filter((tab) => tab.id !== nextActiveTabId),
      ...nextTabs.filter((tab) => tab.id === nextActiveTabId),
    ];
    for (const tab of launchOrder) {
      await launchWrike(tab.id, tab.mode === "readOnly" ? READ_ONLY_URL : tab.url ?? WRIKE_HOME);
    }
    await resizeWrikeTabs(currentWrikeLayouts(nextSplit, nextActiveTabId)).catch(() => undefined);
    await hideWrike(nextTabs.filter((tab) => !visibleIds.includes(tab.id)).map((tab) => tab.id));
    if (visibleIds.includes(nextActiveTabId)) {
      await focusWrikeTab(nextActiveTabId).catch(() => undefined);
    }
  }

  async function openStartupTabs(urls = settings.startupTabUrls) {
    const nextTabs = normalizedStartupUrls(urls).map((url, index) =>
      createWrikeTab(index === 0 ? "home" : `startup-${Date.now().toString(36)}-${index}`, index === 0 ? "Wrike" : `Startup tab ${index + 1}`, url),
    );
    await openWrikeTabSet(nextTabs, nextTabs[0].id, null);
  }

  async function restorePreviousSession(session: WrikeSession) {
    const seen = new Set<string>();
    const nextTabs = session.tabs
      .map((tab, index) => {
        const url = normalizeUrlInput(tab.url ?? "") ?? WRIKE_HOME;
        const fallbackId = index === 0 ? "home" : `restored-${Date.now().toString(36)}-${index}`;
        const candidateId = /^[a-zA-Z0-9-]+$/.test(tab.id) ? tab.id : fallbackId;
        const id = seen.has(candidateId) ? fallbackId : candidateId;
        seen.add(id);
        return createWrikeTab(id, tab.title || (index === 0 ? "Wrike" : `Restored tab ${index + 1}`), url, tab.mode);
      })
      .filter((tab) => tab.url);
    if (!nextTabs.length) {
      setSessionPrompt(null);
      canPersistSessionRef.current = true;
      return;
    }
    const tabIds = new Set(nextTabs.map((tab) => tab.id));
    const nextActiveTabId = tabIds.has(session.activeTabId) ? session.activeTabId : nextTabs[0].id;
    const nextSplit =
      session.split &&
      tabIds.has(session.split.leftTabId) &&
      tabIds.has(session.split.rightTabId) &&
      session.split.leftTabId !== session.split.rightTabId
        ? session.split
        : null;
    setSessionPrompt(null);
    canPersistSessionRef.current = false;
    await openWrikeTabSet(nextTabs, nextActiveTabId, nextSplit);
    canPersistSessionRef.current = true;
    await saveWrikeSession(currentWrikeSession()).catch(() => undefined);
  }

  function dismissSessionPrompt() {
    setSessionPrompt(null);
    canPersistSessionRef.current = true;
    void saveWrikeSession(currentWrikeSession()).catch(() => undefined);
  }

  function syncWrikeSplitRef(next: WrikeSplit | null) {
    wrikeSplitRef.current = next;
    setWrikeSplit(next);
  }

  function syncActiveWrikeTabId(next: string) {
    activeWrikeTabIdRef.current = next;
    setActiveWrikeTabId(next);
  }

  function wrikeTabExists(tabId: string) {
    return wrikeTabsRef.current.some((tab) => tab.id === tabId);
  }

  function visibleWrikeTabIds(split = wrikeSplitRef.current, activeTabId = activeWrikeTabIdRef.current) {
    if (split && wrikeTabExists(split.leftTabId) && wrikeTabExists(split.rightTabId)) {
      return [split.leftTabId, split.rightTabId];
    }
    return wrikeTabExists(activeTabId) ? [activeTabId] : [wrikeTabsRef.current[0]?.id].filter(Boolean);
  }

  function currentWrikeLayouts(
    split = wrikeSplitRef.current,
    activeTabId = activeWrikeTabIdRef.current,
  ): WrikeTabLayout[] {
    if (split && wrikeTabExists(split.leftTabId) && wrikeTabExists(split.rightTabId)) {
      return [
        { tabId: split.leftTabId, pane: "left" },
        { tabId: split.rightTabId, pane: "right" },
      ];
    }
    return visibleWrikeTabIds(null, activeTabId).map((tabId) => ({ tabId, pane: "full" }));
  }

  async function resizeCurrentWrikeTabs() {
    await resizeWrikeTabs(currentWrikeLayouts());
  }

  function companionTabId(tabId: string, preferred?: string | null) {
    if (preferred && preferred !== tabId && wrikeTabExists(preferred)) {
      return preferred;
    }
    const split = wrikeSplitRef.current;
    const splitCompanion =
      split?.leftTabId === tabId
        ? split.rightTabId
        : split?.rightTabId === tabId
          ? split.leftTabId
          : null;
    if (splitCompanion && wrikeTabExists(splitCompanion)) {
      return splitCompanion;
    }
    return wrikeTabsRef.current.find((tab) => tab.id !== tabId)?.id ?? null;
  }

  async function showWrikeSplit(nextSplit: WrikeSplit, focusTabId: string) {
    syncWrikeSplitRef(nextSplit);
    syncActiveWrikeTabId(focusTabId);
    setScreen("wrike");
    const visibleIds = [nextSplit.leftTabId, nextSplit.rightTabId];
    const launchOrder =
      focusTabId === nextSplit.leftTabId
        ? [nextSplit.rightTabId, nextSplit.leftTabId]
        : [nextSplit.leftTabId, nextSplit.rightTabId];
    for (const tabId of launchOrder) {
      const tab = wrikeTabsRef.current.find((candidate) => candidate.id === tabId);
      await launchWrike(tabId, tab?.mode === "readOnly" ? READ_ONLY_URL : undefined);
    }
    await resizeWrikeTabs(currentWrikeLayouts(nextSplit, focusTabId)).catch(() => undefined);
    await hideWrike(wrikeTabsRef.current.filter((tab) => !visibleIds.includes(tab.id)).map((tab) => tab.id));
  }

  async function restoreWrikeView() {
    const split = wrikeSplitRef.current;
    if (split && wrikeTabExists(split.leftTabId) && wrikeTabExists(split.rightTabId)) {
      await showWrikeSplit(split, activeWrikeTabIdRef.current);
      return;
    }
    await showWrike(activeWrikeTabIdRef.current);
  }

  async function splitWrikeTab(tabId: string, side: WrikePaneSide) {
    const otherTabId = companionTabId(tabId, activeWrikeTabIdRef.current);
    if (!otherTabId) {
      setNotice("Open another tab to use split view.");
      return;
    }
    const nextSplit =
      side === "left"
        ? { leftTabId: tabId, rightTabId: otherTabId }
        : { leftTabId: otherTabId, rightTabId: tabId };
    setTabMenu(null);
    await closeTopbarActionsMenu();
    await showWrikeSplit(nextSplit, tabId);
  }

  async function exitSplitView(focusTabId = activeWrikeTabIdRef.current) {
    syncWrikeSplitRef(null);
    await showWrike(focusTabId);
  }

  async function showWrike(tabId = activeWrikeTabId) {
    const tabs = wrikeTabsRef.current;
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const split = wrikeSplitRef.current;
    if (split && (split.leftTabId === tabId || split.rightTabId === tabId)) {
      syncActiveWrikeTabId(tabId);
      await resizeWrikeTabs(currentWrikeLayouts(split, tabId)).catch(() => undefined);
      await focusWrikeTab(tabId);
      await hideWrike(tabs.filter((tab) => tab.id !== split.leftTabId && tab.id !== split.rightTabId).map((tab) => tab.id));
      setScreen("wrike");
      return;
    }
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(tabId);
    await resizeWrikeTabs(currentWrikeLayouts(null, tabId)).catch(() => undefined);
    await launchWrike(tabId, tab?.mode === "readOnly" ? READ_ONLY_URL : undefined);
    await hideWrike(tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
    const update = await getWrikeTabState(tabId);
    if (update) {
      setWrikeTabs((current) =>
        current.map((tab) => (tab.id === tabId ? applyWrikeTabUpdate(tab, update) : tab)),
      );
    }
    setScreen("wrike");
  }

  async function showWrikeHome() {
    const tabId = activeWrikeTabId;
    setIsTopbarActionsMenuOpen(false);
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(tabId);
    setWrikeTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, mode: "standard" } : tab)),
    );
    await resizeWrikeTabs(currentWrikeLayouts(null, tabId)).catch(() => undefined);
    await launchWrike(tabId, WRIKE_HOME);
    await hideWrike(wrikeTabsRef.current.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
    const update = await getWrikeTabState(tabId);
    if (update) {
      setWrikeTabs((current) =>
        current.map((tab) => (tab.id === tabId ? applyWrikeTabUpdate(tab, update) : tab)),
      );
    }
    setScreen("wrike");
  }

  async function showLocalScreen(next: Exclude<Screen, "wrike">) {
    setIsTopbarActionsMenuOpen(false);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    setScreen(next);
  }

  async function addWrikeTab() {
    const nextTabNumber = wrikeTabs.length + 1;
    const url = normalizedStartupUrls()[0];
    const next: WrikeTab = {
      id: `tab-${Date.now().toString(36)}`,
      title: nextTabNumber === 1 ? "Wrike" : `New tab ${nextTabNumber}`,
      url,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: true,
      mode: wrikeModeForUrl(url),
    };
    syncWrikeSplitRef(null);
    setWrikeTabs((current) => [...current, next]);
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    await launchWrike(next.id, next.mode === "readOnly" ? READ_ONLY_URL : url);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    syncActiveWrikeTabId(next.id);
    setScreen("wrike");
  }

  async function addReadOnlyTab() {
    const next: WrikeTab = {
      id: `read-only-${Date.now().toString(36)}`,
      title: "Read Only Mode",
      url: READ_ONLY_URL,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: false,
      mode: "readOnly",
    };
    syncWrikeSplitRef(null);
    setWrikeTabs((current) => [...current, next]);
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    await launchWrike(next.id, READ_ONLY_URL);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    syncActiveWrikeTabId(next.id);
    setScreen("wrike");
  }

  async function runWrikeTabAction(tabId: string, action: WrikeTabAction) {
    setTabMenu(null);
    await closeTopbarActionsMenu();
    if (action === "reload") {
      window.clearTimeout(reloadAnimationTimerRef.current);
      setReloadingTabId(tabId);
      reloadAnimationTimerRef.current = window.setTimeout(() => {
        setReloadingTabId((current) => (current === tabId ? null : current));
      }, 900);
    }
    await wrikeTabAction(tabId, action);
  }

  async function closeTab(tabId: string) {
    const tabs = wrikeTabsRef.current;
    if (tabs.length <= 1) {
      return;
    }
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    const remaining = tabs.filter((tab) => tab.id !== tabId);
    const fallbackTab = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)];
    const split = wrikeSplitRef.current;
    const survivingSplitTabId =
      split?.leftTabId === tabId
        ? split.rightTabId
        : split?.rightTabId === tabId
          ? split.leftTabId
          : null;
    setTabMenu(null);
    wrikeTabsRef.current = remaining;
    setWrikeTabs(remaining);
    await closeWrikeTab(tabId);
    if (survivingSplitTabId) {
      syncWrikeSplitRef(null);
      await showWrike(survivingSplitTabId);
      return;
    }
    if (activeWrikeTabId === tabId && fallbackTab) {
      await showWrike(fallbackTab.id);
    }
  }

  function reorderTabs(sourceId: string, targetId: string) {
    if (sourceId === targetId) {
      return;
    }
    setWrikeTabs((current) => {
      const sourceIndex = current.findIndex((tab) => tab.id === sourceId);
      const targetIndex = current.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  async function copyTextToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  async function copyTabLink(tab: WrikeTab) {
    setTabMenu(null);
    const url = tab.url ?? "https://www.wrike.com/workspace.htm";
    setNotice((await copyTextToClipboard(url)) ? "Copied to Clipboard" : "Unable to copy link");
  }

  async function shareTab(tab: WrikeTab) {
    setTabMenu(null);
    const url = tab.url ?? "https://www.wrike.com/workspace.htm";
    const share = (navigator as Navigator & {
      share?: (data: { title: string; url: string }) => Promise<void>;
    }).share;
    if (share) {
      try {
        await share({ title: tab.title, url });
        setNotice("Wrike link shared.");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }
    setNotice((await copyTextToClipboard(url)) ? "Copied to Clipboard" : "Unable to copy link");
  }

  async function runWindowAction(action: "minimize" | "toggleMaximize" | "close") {
    if (!isDesktopRuntime()) {
      return;
    }
    const appWindow = getCurrentWindow();
    if (action === "minimize") {
      await appWindow.minimize();
    } else if (action === "toggleMaximize") {
      await appWindow.toggleMaximize();
      setIsWindowMaximized(await appWindow.isMaximized());
    } else {
      await appWindow.close();
    }
  }

  function isTitlebarInteractionTarget(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      target.closest(
        "button, .workspace-tab, .browser-controls, .brand, .topbar-actions, .topbar-actions-overflow, .window-controls, .tab-context-menu",
      )
    );
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>, tabId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void showWrike(tabId);
    }
  }

  function handleTitlebarDoubleClick(event: MouseEvent<HTMLElement>) {
    if (isTitlebarInteractionTarget(event.target)) {
      return;
    }
    void runWindowAction("toggleMaximize");
  }

  function handleTitlebarMouseDown(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || event.detail !== 1 || !isDesktopRuntime()) {
      return;
    }
    if (isTitlebarInteractionTarget(event.target)) {
      return;
    }
    void getCurrentWindow().startDragging();
  }

  function handleTabDragStart(event: DragEvent<HTMLDivElement>, tabId: string) {
    setDraggedTabId(tabId);
    setSplitDropSide(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
    if (screen === "wrike") {
      void hideWrike(visibleWrikeTabIds());
    }
  }

  function handleTabDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedTabId;
    if (sourceId) {
      reorderTabs(sourceId, targetId);
    }
    setDraggedTabId(null);
    setSplitDropSide(null);
  }

  function handleTabDragEnd() {
    setDraggedTabId(null);
    setSplitDropSide(null);
    if (screen === "wrike") {
      void restoreWrikeView();
    }
  }

  function sideFromPointer(clientX: number): WrikePaneSide {
    return clientX < window.innerWidth / 2 ? "left" : "right";
  }

  function handleSplitDragOver(event: DragEvent<HTMLElement>) {
    if (!draggedTabId || wrikeTabsRef.current.length <= 1) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setSplitDropSide(sideFromPointer(event.clientX));
  }

  function handleSplitDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setSplitDropSide(null);
  }

  function handleSplitDrop(event: DragEvent<HTMLElement>) {
    if (!draggedTabId) {
      return;
    }
    event.preventDefault();
    const tabId = draggedTabId;
    const side = sideFromPointer(event.clientX);
    setDraggedTabId(null);
    setSplitDropSide(null);
    void splitWrikeTab(tabId, side);
  }

  async function showTabContextMenu(event: MouseEvent<HTMLDivElement>, tab: WrikeTab) {
    event.preventDefault();
    event.stopPropagation();
    if (!isDesktopRuntime()) {
      setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
      return;
    }
    try {
      const menu = await Menu.new({
        items: [
          {
            text: "Back",
            enabled: tab.canGoBack,
            action: () => void runWrikeTabAction(tab.id, "back"),
          },
          {
            text: "Forward",
            enabled: tab.canGoForward,
            action: () => void runWrikeTabAction(tab.id, "forward"),
          },
          {
            text: "Refresh",
            action: () => void runWrikeTabAction(tab.id, "reload"),
          },
          { item: "Separator" },
          {
            text: "Show tab on left",
            enabled: wrikeTabsRef.current.length > 1,
            action: () => void splitWrikeTab(tab.id, "left"),
          },
          {
            text: "Show tab on right",
            enabled: wrikeTabsRef.current.length > 1,
            action: () => void splitWrikeTab(tab.id, "right"),
          },
          {
            text: "Exit split view",
            enabled: Boolean(wrikeSplitRef.current),
            action: () => void exitSplitView(tab.id),
          },
          { item: "Separator" },
          {
            text: "Copy link",
            action: () => void copyTabLink(tab),
          },
          {
            text: "Share",
            action: () => void shareTab(tab),
          },
          { item: "Separator" },
          {
            text: "Close tab",
            enabled: wrikeTabsRef.current.length > 1,
            action: () => void closeTab(tab.id),
          },
        ],
      });
      await menu.popup();
    } catch {
      setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
    }
  }

  const menuTab = tabMenu ? wrikeTabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;
  const activeWrikeTab =
    wrikeTabs.find((tab) => tab.id === activeWrikeTabId) ?? wrikeTabs[0] ?? null;

  async function updateSettings(next: Settings) {
    const persisted = await saveSettings(next);
    setSettings(persisted);
    setNotice("Preferences saved.");
  }

  function togglePinnedDownload(id: string) {
    const pinned = new Set(settings.pinnedDownloadIds);
    if (pinned.has(id)) {
      pinned.delete(id);
    } else {
      pinned.add(id);
    }
    void updateSettings({ ...settings, pinnedDownloadIds: [...pinned] });
  }

  async function toggleSpellCheck() {
    await closeTopbarActionsMenu();
    const spellCheck = !settings.spellCheck;
    const persisted = await saveSettings({ ...settings, spellCheck });
    setSettings(persisted);
    setNotice(`Spell check ${persisted.spellCheck ? "enabled" : "disabled"}.`);
  }

  async function testNotification() {
    try {
      await sendTestNotification();
      setNotice("Test notification sent.");
    } catch {
      setNotice("Unable to send a notification. Check Windows notification permissions.");
    }
  }

  async function openTopbarActionsMenu() {
    setIsTopbarActionsMenuOpen(true);
    if (screen === "wrike") {
      await hideWrike(wrikeTabs.map((tab) => tab.id));
    }
  }

  async function closeTopbarActionsMenu() {
    if (!isTopbarActionsMenuOpen) {
      return;
    }
    setIsTopbarActionsMenuOpen(false);
    if (screen === "wrike") {
      await restoreWrikeView();
    }
  }

  async function toggleTopbarActionsMenu() {
    if (isTopbarActionsMenuOpen) {
      await closeTopbarActionsMenu();
    } else {
      await openTopbarActionsMenu();
    }
  }

  return (
    <>
    <div className="app-shell" data-theme={settings.theme} spellCheck={settings.spellCheck}>
      <header
        className={`taskbar ${wrikeTabs.length >= 4 ? "is-tab-crowded" : ""}`}
        data-tauri-drag-region
        onDoubleClick={handleTitlebarDoubleClick}
        onMouseDown={handleTitlebarMouseDown}
      >
        <button
          aria-label="Open Wrike home in current tab"
          className="brand"
          onClick={() => void showWrikeHome()}
          title="Open Wrike home"
        >
          <img className="brand-wordmark" src="/abw-wordmark.svg" alt="ABW" />
        </button>
        {activeWrikeTab ? (
          <div className="browser-controls" aria-label={`${activeWrikeTab.title} browser controls`}>
            <button
              aria-label={`Go back in ${activeWrikeTab.title}`}
              disabled={!activeWrikeTab.canGoBack}
              onClick={() => void runWrikeTabAction(activeWrikeTab.id, "back")}
              title="Back"
            >
              <MaterialIcon kind="arrow_back" />
            </button>
            <button
              aria-label={`Go forward in ${activeWrikeTab.title}`}
              disabled={!activeWrikeTab.canGoForward}
              onClick={() => void runWrikeTabAction(activeWrikeTab.id, "forward")}
              title="Forward"
            >
              <MaterialIcon kind="arrow_forward" />
            </button>
            <button
              aria-label={`Reload ${activeWrikeTab.title}`}
              className={reloadingTabId === activeWrikeTab.id ? "is-reloading" : undefined}
              onClick={() => void runWrikeTabAction(activeWrikeTab.id, "reload")}
              title="Reload"
            >
              <MaterialIcon kind="refresh" />
            </button>
          </div>
        ) : null}
        <div className="workspace-tabs" role="tablist" aria-label="Wrike tabs">
          {wrikeTabs.map((tab, index) => {
            const selected = screen === "wrike" && activeWrikeTabId === tab.id;
            return (
              <div
                aria-selected={selected}
                className={[
                  "workspace-tab",
                  selected ? "selected" : "",
                  tab.mode === "readOnly" ? "read-only" : "",
                  wrikeSplit?.leftTabId === tab.id ? "split-left" : "",
                  wrikeSplit?.rightTabId === tab.id ? "split-right" : "",
                  newWrikeTabId === tab.id ? "entering" : "",
                  draggedTabId === tab.id ? "dragging" : "",
                ].join(" ")}
                draggable
                key={tab.id}
                onClick={() => void showWrike(tab.id)}
                onContextMenu={(event) => void showTabContextMenu(event, tab)}
                onDragEnd={handleTabDragEnd}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDragStart={(event) => handleTabDragStart(event, tab.id)}
                onDrop={(event) => handleTabDrop(event, tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                role="tab"
                tabIndex={0}
                title={tab.title}
              >
                <span className={`tab-title ${tab.isTitleLoading ? "loading" : ""}`}>{tab.title}</span>
                {index === 0 ? <span className="external-dot" /> : null}
                <span className="tab-actions" aria-label={`${tab.title} controls`}>
                  <button
                    aria-label={`Close ${tab.title}`}
                    disabled={wrikeTabs.length <= 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(tab.id);
                    }}
                    title="Close"
                  >
                    <MaterialIcon kind="close" />
                  </button>
                </span>
              </div>
            );
          })}
          <span className="new-tab-cluster">
            <button
              aria-label="New Wrike tab"
              className="new-tab"
              onClick={() => void addWrikeTab()}
              title="New Wrike tab"
            >
              <MaterialIcon kind="add" />
            </button>
            <button
              aria-label="New read only Wrike tab"
              className="read-only-launcher"
              onClick={() => void addReadOnlyTab()}
              title="Read Only Mode"
            >
              <MaterialIcon kind="description" />
              <span>Read Only</span>
            </button>
          </span>
          <span className="tab-space" aria-hidden="true" data-tauri-drag-region />
        </div>
        <div className="topbar-actions">
          <button
            aria-label={`Turn spell check ${settings.spellCheck ? "off" : "on"}`}
            aria-pressed={settings.spellCheck}
            className={`spell-state ${settings.spellCheck ? "enabled" : ""}`}
            onClick={() => void toggleSpellCheck()}
            title={`Turn spell check ${settings.spellCheck ? "off" : "on"}`}
          >
            <span className="icon-wrap">
              <NavIcon kind="spell" />
            </span>
            Spell check {settings.spellCheck ? "on" : "off"}
          </button>
          <nav className="task-navigation" aria-label="ABW navigation">
            <button
              className={`nav-item ${screen === "files" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("files")}
            >
              <MaterialIcon kind="description" />
              Files
            </button>
            <button
              className={`nav-item ${screen === "settings" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("settings")}
            >
              <MaterialIcon kind="settings" />
              Settings
            </button>
          </nav>
        </div>
        <div
          className="topbar-actions-overflow"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            aria-controls="topbar-actions-menu"
            aria-expanded={isTopbarActionsMenuOpen}
            aria-label="Show ABW actions"
            className={`topbar-actions-toggle ${isTopbarActionsMenuOpen ? "open" : ""}`}
            onClick={() => void toggleTopbarActionsMenu()}
            title="Show ABW actions"
          >
            <MaterialIcon kind="keyboard_arrow_down" />
          </button>
          <div
            className={`topbar-actions-menu ${isTopbarActionsMenuOpen ? "open" : ""}`}
            id="topbar-actions-menu"
          >
            <button
              aria-pressed={settings.spellCheck}
              className="topbar-menu-item"
              onClick={() => void toggleSpellCheck()}
            >
              <NavIcon kind="spell" />
              <span>Spell check {settings.spellCheck ? "on" : "off"}</span>
            </button>
            <button
              className={`topbar-menu-item ${screen === "files" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("files")}
            >
              <MaterialIcon kind="description" />
              <span>Files</span>
            </button>
            <button
              className={`topbar-menu-item ${screen === "settings" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("settings")}
            >
              <MaterialIcon kind="settings" />
              <span>Settings</span>
            </button>
          </div>
        </div>
        <div className="topbar-notice-slot" aria-live="polite">
          {sessionPrompt ? (
            <div className="topbar-toast session-toast" role="status">
              <span>
                Reopen your previous session with {sessionPrompt.tabs.length}{" "}
                {sessionPrompt.tabs.length === 1 ? "tab" : "tabs"}?
              </span>
              <span className="toast-actions">
                <button onClick={() => void restorePreviousSession(sessionPrompt)}>Reopen</button>
                <button onClick={dismissSessionPrompt}>Skip</button>
              </span>
            </div>
          ) : notice ? (
            <div className="topbar-toast" role="status">
              {notice}
              <button aria-label="Dismiss" onClick={() => setNotice(null)}>
                <NavIcon kind="close" />
              </button>
            </div>
          ) : null}
        </div>
        <WindowControls
          isMaximized={isWindowMaximized}
          onAction={(action) => void runWindowAction(action)}
        />
      </header>
      {tabMenu && menuTab ? (
        <div
          className="tab-context-menu"
          onClick={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: tabMenu.x, top: tabMenu.y }}
        >
          <button
            disabled={!menuTab.canGoBack}
            onClick={() => void runWrikeTabAction(menuTab.id, "back")}
            role="menuitem"
          >
            <MaterialIcon kind="arrow_back" />
            Back
          </button>
          <button
            disabled={!menuTab.canGoForward}
            onClick={() => void runWrikeTabAction(menuTab.id, "forward")}
            role="menuitem"
          >
            <MaterialIcon kind="arrow_forward" />
            Forward
          </button>
          <button onClick={() => void runWrikeTabAction(menuTab.id, "reload")} role="menuitem">
            <MaterialIcon kind="refresh" />
            Refresh
          </button>
          <span className="menu-separator" />
          <button
            disabled={wrikeTabs.length <= 1}
            onClick={() => void splitWrikeTab(menuTab.id, "left")}
            role="menuitem"
          >
            <MaterialIcon kind="view_column" />
            Show tab on left
          </button>
          <button
            disabled={wrikeTabs.length <= 1}
            onClick={() => void splitWrikeTab(menuTab.id, "right")}
            role="menuitem"
          >
            <MaterialIcon kind="view_column" />
            Show tab on right
          </button>
          <button
            disabled={!wrikeSplit}
            onClick={() => void exitSplitView(menuTab.id)}
            role="menuitem"
          >
            <MaterialIcon kind="tab" />
            Exit split view
          </button>
          <span className="menu-separator" />
          <button onClick={() => void copyTabLink(menuTab)} role="menuitem">
            <MaterialIcon kind="link" />
            Copy link
          </button>
          <button onClick={() => void shareTab(menuTab)} role="menuitem">
            <MaterialIcon kind="share" />
            Share
          </button>
          <span className="menu-separator" />
          <button
            disabled={wrikeTabs.length <= 1}
            onClick={() => void closeTab(menuTab.id)}
            role="menuitem"
          >
            <MaterialIcon kind="close" />
            Close tab
          </button>
        </div>
      ) : null}
      <main
        className={`content ${draggedTabId ? "tab-side-dragging" : ""}`}
        onDragLeave={handleSplitDragLeave}
        onDragOver={handleSplitDragOver}
        onDrop={handleSplitDrop}
      >
        {screen === "wrike" ? (
          <section
            className={`wrike-surface ${draggedTabId ? "split-drop-active" : ""}`}
            aria-label="Wrike workspace"
          >
            {draggedTabId && wrikeTabs.length > 1 ? (
              <div className="split-drop-zones" aria-hidden="true">
                <span className={`split-drop-zone left ${splitDropSide === "left" ? "active" : ""}`}>
                  <MaterialIcon kind="view_column" />
                </span>
                <span className={`split-drop-zone right ${splitDropSide === "right" ? "active" : ""}`}>
                  <MaterialIcon kind="view_column" />
                </span>
              </div>
            ) : null}
            <NavIcon kind="home" />
            <h1>Wrike</h1>
            <p>
              {isDesktopRuntime()
                ? "Loading your live workspace..."
                : "Your live Wrike workspace displays here in the desktop app."}
            </p>
          </section>
        ) : screen === "files" ? (
          <div className="files-screen">
            <FilesLibrary
              downloads={visibleDownloads}
              filter={filter}
              onFilterChange={setFilter}
              onOpenSourceTask={() => setScreen("wrike")}
              onSearchChange={setSearch}
              onSelect={setSelectedId}
              onTogglePin={togglePinnedDownload}
              pinnedIds={settings.pinnedDownloadIds}
              search={search}
              selectedId={selectedRecord?.id ?? null}
            />
            <Suspense fallback={<div className="preview-panel loading">Loading preview...</div>}>
              <PreviewPanel record={selectedRecord} />
            </Suspense>
          </div>
        ) : (
          <div className="settings-screen">
            <SettingsPanel
              appVersion={APP_VERSION}
              settings={settings}
              onChange={(next) => void updateSettings(next)}
              onTestNotification={() => void testNotification()}
            />
          </div>
        )}
      </main>
    </div>
    {isLaunchSplashVisible ? (
      <div className="launch-splash" aria-label="Opening ABW" role="status">
        <div className="launch-splash-mark">
          <img src="/abw.svg" alt="" />
        </div>
      </div>
    ) : null}
    </>
  );
}

function MaterialIcon({
  kind,
}: {
  kind:
    | "add"
    | "arrow_back"
    | "arrow_forward"
    | "close"
    | "description"
    | "home"
    | "keyboard_arrow_down"
    | "link"
    | "refresh"
    | "settings"
    | "share"
    | "tab"
    | "view_column"
    | "window_maximize"
    | "window_minimize"
    | "window_restore";
}) {
  const paths: Record<typeof kind, ReactElement> = {
    home: <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8Z" />,
    add: <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6Z" />,
    arrow_back: <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20Z" />,
    arrow_forward: <path d="m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8Z" />,
    close: <path d="M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49l1.41 1.41L12 12.01l4.89 4.89 1.41-1.41-4.89-4.89Z" />,
    description: (
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm1 7V3.5L20.5 9ZM16 18H8v-2h8Zm0-4H8v-2h8Z" />
    ),
    keyboard_arrow_down: <path d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6Z" />,
    link: (
      <path d="M3.9 12a5 5 0 0 1 5-5h4v2h-4a3 3 0 0 0 0 6h4v2h-4a5 5 0 0 1-5-5Zm5.5 1v-2h5.2v2Zm1.7 4v-2h4a3 3 0 0 0 0-6h-4V7h4a5 5 0 0 1 0 10Z" />
    ),
    refresh: (
      <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4Z" />
    ),
    settings: (
      <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.42 7.42 0 0 0-1.69-.98L14.5 2.42A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65a.49.49 0 0 0 .49.42h4a.49.49 0 0 0 .49-.42l.38-2.65c.61-.25 1.17-.58 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5" />
    ),
    share: (
      <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 1 0 15 5c0 .24.04.47.09.7L8.04 9.81A3 3 0 1 0 8.04 14l7.12 4.18c-.05.21-.08.43-.08.65a2.92 2.92 0 1 0 2.92-2.75Z" />
    ),
    tab: <path d="M4 6a2 2 0 0 1 2-2h5.8a2 2 0 0 1 1.42.59L16.63 8H20v10a2 2 0 0 1-2 2H4Z" />,
    view_column: <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm2 0v14h5V5Zm7 0v14h5V5Z" />,
    window_maximize: <path d="M6 6h12v12H6Zm2 2v8h8V8Z" />,
    window_minimize: <path d="M6 12h12v2H6Z" />,
    window_restore: <path d="M8 4h12v12h-4v4H4V8h4Zm2 4h6v6h2V6h-8Zm4 2H6v8h8Z" />,
  };
  return (
    <svg className="material-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

function WindowControls({
  isMaximized,
  onAction,
}: {
  isMaximized: boolean;
  onAction: (action: "minimize" | "toggleMaximize" | "close") => void;
}) {
  return (
    <div className="window-controls" aria-label="Window controls">
      <button aria-label="Minimize" onClick={() => onAction("minimize")} title="Minimize">
        <MaterialIcon kind="window_minimize" />
      </button>
      <button
        aria-label={isMaximized ? "Restore" : "Maximize"}
        onClick={() => onAction("toggleMaximize")}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        <MaterialIcon kind={isMaximized ? "window_restore" : "window_maximize"} />
      </button>
      <button
        aria-label="Close"
        className="close-window"
        onClick={() => onAction("close")}
        title="Close"
      >
        <MaterialIcon kind="close" />
      </button>
    </div>
  );
}

function NavIcon({ kind }: { kind: string }) {
  const paths: Record<string, ReactElement> = {
    home: <path d="M3.5 9.3 12 3l8.5 6.3V20H14v-5h-4v5H3.5Z" />,
    file: <path d="M6 3.5h8l4 4V21H6Zm8 0v5h4M9 13h6M9 17h6" />,
    gear: (
      <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0-5 1.4 2.4 2.8-.1.2 2.8 2.5 1.3-1.3 2.5 1.3 2.5-2.5 1.3-.2 2.8-2.8-.1-1.4 2.4-1.4-2.4-2.8.1-.2-2.8-2.5-1.3 1.3-2.5-1.3-2.5 2.5-1.3.2-2.8 2.8.1Z" />
    ),
    spell: <path d="M5 19 10.2 5h3.6L19 19m-12-5h10M4 21h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      {paths[kind]}
    </svg>
  );
}
