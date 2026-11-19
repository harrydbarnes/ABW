import {
  lazy,
  Suspense,
  useCallback,
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
import { evictPreviewById, formatBytes } from "./features/preview/previewCache";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import {
  checkForAppUpdate,
  clearUnpinnedDownloads,
  closeWrikeTab,
  deleteDownload,
  focusWrikeTab,
  getDownloadsStorageStats,
  installAppUpdate,
  launchWrike,
  hideWrike,
  isDesktopRuntime,
  loadDownloads,
  loadSettings,
  loadStorageHealth,
  loadWrikeSession,
  openSourceTask,
  resizeWrikeTabs,
  revealDownload,
  saveSettings,
  saveWrikeSession,
  sendTestNotification,
  subscribeToDownloadCompleted,
  subscribeToDownloadDeleted,
  subscribeToDownloadErrors,
  subscribeToDownloads,
  subscribeToSettingsUpdates,
  subscribeToWrikeShortcuts,
  subscribeToWrikeTabUpdates,
  wrikeTabAction,
  type WrikePane,
  type WrikeShortcutEvent,
  type WrikeTabAction,
  type WrikeTabLayout,
  type WrikeTabUpdate,
} from "./lib/desktop";
import {
  WRIKE_HOME,
  filterAndSortDownloads,
  hasRestorableSession,
  nextTabIndexForCycle,
  normalizeUrlInput,
  normalizedStartupUrls,
  tabIndexFromShortcutDigit,
  wrikeSessionSignature,
} from "./lib/workspaceUtils";
import type {
  AppUpdateState,
  DownloadRecord,
  DownloadsStorageStats,
  FileFilter,
  Settings,
  WrikeSession,
} from "./types";

const PreviewPanel = lazy(() => import("./features/preview/PreviewPanel"));
const READ_ONLY_URL = "https://login.wrike.com/login/?forceLogin=false&read";
const APP_VERSION = import.meta.env.VITE_APP_VERSION;
const LAUNCH_SPLASH_DURATION_MS = 450;

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
  const [suspendedTabIds, setSuspendedTabIds] = useState<string[]>([]);
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
    openAbwAtSystemStartup: false,
    closeToNotificationArea: true,
    confirmBeforeClosingTabs: false,
    openDownloadedFilesAutomatically: false,
    autoCheckForUpdates: true,
    suspendInactiveTabsMinutes: 0,
    theme: "default",
    customDictionary: [],
    startupTabUrls: [WRIKE_HOME],
    pinnedDownloadIds: [],
  });
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    phase: "idle",
    latestVersion: null,
    notes: null,
    pubDate: null,
    checkedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    dismissedPrompt: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [downloadsStats, setDownloadsStats] = useState<DownloadsStorageStats | null>(null);
  const [clearingDownloads, setClearingDownloads] = useState(false);
  const [sessionPrompt, setSessionPrompt] = useState<WrikeSession | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [reloadingTabId, setReloadingTabId] = useState<string | null>(null);
  const screenRef = useRef(screen);
  const wrikeTabsRef = useRef(wrikeTabs);
  const activeWrikeTabIdRef = useRef(activeWrikeTabId);
  const wrikeSplitRef = useRef(wrikeSplit);
  const settingsRef = useRef(settings);
  const launchedTabIdsRef = useRef(new Set<string>());
  const tabLastActiveAtRef = useRef(new Map<string, number>());
  const canPersistSessionRef = useRef(false);
  const lastPersistedSessionSigRef = useRef("");
  const pendingSessionSigRef = useRef<string | null>(null);
  const updateRequestInFlightRef = useRef(false);
  const appUpdatePhaseRef = useRef(appUpdate.phase);
  const autoUpdateTimerRef = useRef<number | undefined>(undefined);
  const reloadAnimationTimerRef = useRef<number | undefined>(undefined);
  const sessionSaveTimerRef = useRef<number | undefined>(undefined);
  const closingTabIdsRef = useRef(new Set<string>());
  const tabIdCounterRef = useRef(0);
  const shortcutHandlerRef = useRef<(shortcut: WrikeShortcutEvent) => void>(() => undefined);
  const navActionHandlerRef = useRef<(action: WrikeTabAction) => void>(() => undefined);

  useEffect(() => {
    if (storageWarning) setScreen("settings");
  }, [storageWarning]);

  useEffect(() => {
    const splashTimer = window.setTimeout(
      () => setIsLaunchSplashVisible(false),
      LAUNCH_SPLASH_DURATION_MS,
    );
    return () => window.clearTimeout(splashTimer);
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(autoUpdateTimerRef.current);
      window.clearTimeout(reloadAnimationTimerRef.current);
      window.clearTimeout(sessionSaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    appUpdatePhaseRef.current = appUpdate.phase;
  }, [appUpdate.phase]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    wrikeTabsRef.current = wrikeTabs;
  }, [wrikeTabs]);

  useEffect(() => {
    activeWrikeTabIdRef.current = activeWrikeTabId;
  }, [activeWrikeTabId]);

  useEffect(() => {
    wrikeSplitRef.current = wrikeSplit;
  }, [wrikeSplit]);

  const flushPendingSessionSave = useCallback(() => {
    const pendingSig = pendingSessionSigRef.current;
    if (!pendingSig) {
      return;
    }
    window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = undefined;
    pendingSessionSigRef.current = null;
    lastPersistedSessionSigRef.current = pendingSig;
    void saveWrikeSession(currentWrikeSession()).catch((error) =>
      setStorageWarning(`Unable to save your tab session: ${String(error)}`),
    );
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushPendingSessionSave();
      }
    };
    window.addEventListener("pagehide", flushPendingSessionSave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushPendingSessionSave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [flushPendingSessionSave]);

  useEffect(() => {
    if (!canPersistSessionRef.current) {
      return;
    }
    const nextSig = wrikeSessionSignature(
      wrikeTabs,
      activeWrikeTabId,
      wrikeSplit,
      normalizedStartupUrls(settings.startupTabUrls)[0],
    );
    if (nextSig === lastPersistedSessionSigRef.current) {
      return;
    }
    pendingSessionSigRef.current = nextSig;
    window.clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = window.setTimeout(() => {
      flushPendingSessionSave();
    }, 1000);
    return () => window.clearTimeout(sessionSaveTimerRef.current);
  }, [activeWrikeTabId, flushPendingSessionSave, settings.startupTabUrls, wrikeSplit, wrikeTabs]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const noticeTimer = window.setTimeout(() => setNotice(null), 2800);
    return () => window.clearTimeout(noticeTimer);
  }, [notice]);

  useEffect(() => {
    if (!isDesktopRuntime() || settings.suspendInactiveTabsMinutes <= 0) {
      return;
    }
    const thresholdMs = settings.suspendInactiveTabsMinutes * 60_000;
    const intervalMs = Math.min(30_000, Math.max(5_000, Math.floor(thresholdMs / 4)));
    const timer = window.setInterval(() => {
      const now = Date.now();
      const activeIds = new Set(
        screenRef.current === "wrike" ? visibleWrikeTabIds() : [activeWrikeTabIdRef.current],
      );
      const toSuspend: string[] = [];
      for (const tab of wrikeTabsRef.current) {
        if (!launchedTabIdsRef.current.has(tab.id) || activeIds.has(tab.id)) {
          continue;
        }
        const lastActiveAt = tabLastActiveAtRef.current.get(tab.id) ?? now;
        if (now - lastActiveAt >= thresholdMs) {
          toSuspend.push(tab.id);
        }
      }
      if (!toSuspend.length) {
        return;
      }
      for (const tabId of toSuspend) {
        launchedTabIdsRef.current.delete(tabId);
        void closeWrikeTab(tabId).catch(() => undefined);
      }
      setSuspendedTabIds((current) => [...new Set([...current, ...toSuspend])]);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [settings.suspendInactiveTabsMinutes]);

  const runUpdateCheck = useCallback(async (manual: boolean) => {
    if (
      updateRequestInFlightRef.current ||
      appUpdatePhaseRef.current === "downloading" ||
      appUpdatePhaseRef.current === "installing"
    ) {
      return;
    }
    updateRequestInFlightRef.current = true;
    if (manual) {
      setAppUpdate((current) => ({
        ...current,
        phase: "checking",
        error: null,
      }));
    }
    try {
      const result = await checkForAppUpdate();
      const checkedAt = new Date().toISOString();
      if (result.status === "available" && result.latestVersion) {
        setAppUpdate((current) => ({
          phase: "available",
          latestVersion: result.latestVersion,
          notes: result.notes,
          pubDate: result.pubDate,
          checkedAt,
          downloadedBytes: 0,
          totalBytes: null,
          error: null,
          dismissedPrompt: manual
            ? false
            : current.dismissedPrompt && current.latestVersion === result.latestVersion,
        }));
      } else if (result.status === "no-release") {
        setAppUpdate({
          phase: manual ? "no-release" : "idle",
          latestVersion: null,
          notes: null,
          pubDate: null,
          checkedAt,
          downloadedBytes: 0,
          totalBytes: null,
          error: null,
          dismissedPrompt: false,
        });
      } else {
        setAppUpdate({
          phase: "up-to-date",
          latestVersion: null,
          notes: null,
          pubDate: null,
          checkedAt,
          downloadedBytes: 0,
          totalBytes: null,
          error: null,
          dismissedPrompt: false,
        });
      }
    } catch (error) {
      if (manual) {
        setAppUpdate((current) => ({
          ...current,
          phase: "error",
          checkedAt: new Date().toISOString(),
          error: String(error),
        }));
      }
    } finally {
      updateRequestInFlightRef.current = false;
    }
  }, []);

  const startUpdateInstall = useCallback(async () => {
    if (
      updateRequestInFlightRef.current ||
      appUpdatePhaseRef.current === "downloading" ||
      appUpdatePhaseRef.current === "installing"
    ) {
      return;
    }
    updateRequestInFlightRef.current = true;
    setAppUpdate((current) => ({
      ...current,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      dismissedPrompt: false,
    }));
    try {
      await installAppUpdate((event) => {
        if (event.event === "started") {
          setAppUpdate((current) => ({
            ...current,
            phase: "downloading",
            downloadedBytes: 0,
            totalBytes: event.data.contentLength,
          }));
        } else if (event.event === "progress") {
          setAppUpdate((current) => ({
            ...current,
            phase: "downloading",
            downloadedBytes: event.data.downloaded,
            totalBytes: event.data.contentLength ?? current.totalBytes,
          }));
        } else if (event.event === "finished") {
          setAppUpdate((current) => ({
            ...current,
            phase: "installing",
          }));
        }
      });
    } catch (error) {
      setAppUpdate((current) => ({
        ...current,
        phase: "error",
        error: String(error),
      }));
      setNotice(`Update failed: ${String(error)}`);
    } finally {
      updateRequestInFlightRef.current = false;
    }
  }, []);

  function dismissUpdatePrompt() {
    setAppUpdate((current) => ({
      ...current,
      dismissedPrompt: true,
    }));
  }

  useEffect(() => {
    const refresh = () => {
      void loadDownloads().then((records) => {
        setDownloads(records);
        setSelectedId((current) => current ?? records[0]?.id ?? null);
      }).catch((error) => setStorageWarning(`Unable to load your files: ${String(error)}`));
    };
    refresh();
    void Promise.all([loadSettings(), loadWrikeSession(), loadStorageHealth()])
      .then(async ([next, savedSession, warnings]) => {
        settingsRef.current = next;
        setSettings(next);
        if (warnings.length) {
          setStorageWarning(warnings.join(" "));
          setScreen("settings");
          return;
        }
        if (isDesktopRuntime() && next.autoCheckForUpdates) {
          window.clearTimeout(autoUpdateTimerRef.current);
          autoUpdateTimerRef.current = window.setTimeout(() => {
            void runUpdateCheck(false);
          }, 3500);
        }
        if (hasRestorableSession(savedSession)) {
          setSessionPrompt(savedSession);
        }
        if (next.launchWrikeOnStart) {
          await openStartupTabs(next.startupTabUrls);
          if (!hasRestorableSession(savedSession)) {
            canPersistSessionRef.current = true;
          }
        } else {
          setScreen("files");
          if (!hasRestorableSession(savedSession)) {
            canPersistSessionRef.current = true;
          }
        }
      })
      .catch((error) => setStorageWarning(`Unable to load preferences: ${String(error)}`));
    let dispose: () => void = () => undefined;
    let disposeCompleted: () => void = () => undefined;
    let disposeDeleted: () => void = () => undefined;
    let disposeErrors: () => void = () => undefined;
    let disposeTabUpdates: () => void = () => undefined;
    let disposeSettingsUpdates: () => void = () => undefined;
    let disposeShortcuts: () => void = () => undefined;
    void subscribeToDownloads(refresh).then((unsubscribe) => {
      dispose = unsubscribe;
    });
    void subscribeToDownloadCompleted((record) => {
      setDownloads((current) =>
        current.some((existing) => existing.id === record.id) ? current : [record, ...current],
      );
      setSelectedId(record.id);
      setNotice(`${record.fileName} is ready in Files.`);
    }).then((unsubscribe) => {
      disposeCompleted = unsubscribe;
    });
    void subscribeToDownloadDeleted((deletedId) => {
      evictPreviewById(deletedId);
      setDownloads((current) => {
        const next = current.filter((item) => item.id !== deletedId);
        setSelectedId((selected) => (selected === deletedId ? next[0]?.id ?? null : selected));
        return next;
      });
    }).then((unsubscribe) => {
      disposeDeleted = unsubscribe;
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
      settingsRef.current = next;
      setSettings(next);
    }).then((unsubscribe) => {
      disposeSettingsUpdates = unsubscribe;
    });
    void subscribeToWrikeShortcuts((shortcut) => {
      shortcutHandlerRef.current(shortcut);
    }).then((unsubscribe) => {
      disposeShortcuts = unsubscribe;
    });
    return () => {
      dispose();
      disposeCompleted();
      disposeDeleted();
      disposeErrors();
      disposeTabUpdates();
      disposeSettingsUpdates();
      disposeShortcuts();
    };
  }, [runUpdateCheck]);

  useEffect(() => {
    const closeMenu = () => {
      setTabMenu(null);
      void closeTopbarActionsMenu();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
      if (event.isComposing) {
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey) {
        const lower = event.key.toLowerCase();
        if (lower === "t" && !event.shiftKey) {
          event.preventDefault();
          shortcutHandlerRef.current({ action: "new-tab", index: null });
          return;
        }
        if (lower === "w" && !event.shiftKey) {
          event.preventDefault();
          shortcutHandlerRef.current({ action: "close-tab", index: null });
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          shortcutHandlerRef.current({
            action: event.shiftKey ? "prev-tab" : "next-tab",
            index: null,
          });
          return;
        }
        if (event.key === "\\" && !event.shiftKey) {
          event.preventDefault();
          shortcutHandlerRef.current({ action: "toggle-split", index: null });
          return;
        }
        if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
          event.preventDefault();
          shortcutHandlerRef.current({ action: "select-tab", index: Number(event.key) });
          return;
        }
        if (lower === "r" && !event.shiftKey && screenRef.current === "wrike") {
          event.preventDefault();
          navActionHandlerRef.current("reload");
          return;
        }
      }
      if (
        event.key === "F5" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        screenRef.current === "wrike"
      ) {
        event.preventDefault();
        navActionHandlerRef.current("reload");
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        screenRef.current === "wrike" &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (
          target &&
          (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
        ) {
          return;
        }
        event.preventDefault();
        navActionHandlerRef.current(event.key === "ArrowLeft" ? "back" : "forward");
      }
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

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

  const visibleDownloads = useMemo(
    () => filterAndSortDownloads(downloads, filter, deferredSearch, settings.pinnedDownloadIds),
    [deferredSearch, downloads, filter, settings.pinnedDownloadIds],
  );

  const selectedRecord =
    visibleDownloads.find((record) => record.id === selectedId) ?? visibleDownloads[0] ?? null;

  function markTabsActive(tabIds: string[]) {
    const now = Date.now();
    for (const tabId of tabIds) {
      tabLastActiveAtRef.current.set(tabId, now);
    }
    setSuspendedTabIds((current) =>
      current.some((id) => tabIds.includes(id))
        ? current.filter((id) => !tabIds.includes(id))
        : current,
    );
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

  function createTabId(prefix: string) {
    tabIdCounterRef.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${tabIdCounterRef.current.toString(36)}`;
  }

  function currentWrikeSession(): WrikeSession {
    const fallbackUrl = normalizedStartupUrls(settingsRef.current.startupTabUrls)[0];
    return {
      tabs: wrikeTabsRef.current.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url ?? fallbackUrl,
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
    await Promise.all(
      oldTabs.map((tab) => {
        tabLastActiveAtRef.current.delete(tab.id);
        if (launchedTabIdsRef.current.delete(tab.id)) {
          return closeWrikeTab(tab.id).catch(() => undefined);
        }
        return Promise.resolve();
      }),
    );
    if (oldTabs.length) {
      setSuspendedTabIds((current) => current.filter((id) => nextIds.has(id)));
    }
    const splitIsValid = Boolean(
      nextSplit &&
        nextIds.has(nextSplit.leftTabId) &&
        nextIds.has(nextSplit.rightTabId) &&
        nextSplit.leftTabId !== nextSplit.rightTabId,
    );
    const resolvedSplit = splitIsValid ? nextSplit : null;
    const visibleIds = resolvedSplit
      ? [resolvedSplit.leftTabId, resolvedSplit.rightTabId]
      : [nextActiveTabId];
    const normalizedTabs = nextTabs.map((tab) =>
      visibleIds.includes(tab.id) || launchedTabIdsRef.current.has(tab.id)
        ? tab
        : { ...tab, isTitleLoading: false },
    );
    wrikeTabsRef.current = normalizedTabs;
    syncWrikeSplitRef(resolvedSplit);
    syncActiveWrikeTabId(nextActiveTabId);
    setWrikeTabs(normalizedTabs);
    setScreen("wrike");
    markTabsActive(visibleIds);
    const paneForTab = (tabId: string): WrikePane =>
      resolvedSplit
        ? tabId === resolvedSplit.leftTabId
          ? "left"
          : "right"
        : "full";
    const launchOrder = [
      ...visibleIds.filter((id) => id !== nextActiveTabId),
      ...visibleIds.filter((id) => id === nextActiveTabId),
    ];
    await Promise.all(
      launchOrder.map((tabId) => {
        const tab = normalizedTabs.find((candidate) => candidate.id === tabId);
        if (!tab) {
          return Promise.resolve();
        }
        launchedTabIdsRef.current.add(tab.id);
        return launchWrike(
          tab.id,
          tab.mode === "readOnly" ? READ_ONLY_URL : tab.url ?? WRIKE_HOME,
          paneForTab(tab.id),
        );
      }),
    );
    const hiddenLaunched = normalizedTabs
      .filter((tab) => !visibleIds.includes(tab.id) && launchedTabIdsRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (hiddenLaunched.length) {
      await hideWrike(hiddenLaunched);
    }
    if (visibleIds.includes(nextActiveTabId)) {
      await focusWrikeTab(nextActiveTabId).catch(() => undefined);
    }
  }

  async function openStartupTabs(urls = settingsRef.current.startupTabUrls) {
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
    pendingSessionSigRef.current = null;
    lastPersistedSessionSigRef.current = wrikeSessionSignature(
      wrikeTabsRef.current,
      activeWrikeTabIdRef.current,
      wrikeSplitRef.current,
      normalizedStartupUrls(settingsRef.current.startupTabUrls)[0],
    );
    await saveWrikeSession(currentWrikeSession()).catch(() => undefined);
  }

  function dismissSessionPrompt() {
    setSessionPrompt(null);
    canPersistSessionRef.current = true;
    pendingSessionSigRef.current = null;
    lastPersistedSessionSigRef.current = wrikeSessionSignature(
      wrikeTabsRef.current,
      activeWrikeTabIdRef.current,
      wrikeSplitRef.current,
      normalizedStartupUrls(settingsRef.current.startupTabUrls)[0],
    );
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
    const launchedLayouts = currentWrikeLayouts().filter((layout) =>
      launchedTabIdsRef.current.has(layout.tabId),
    );
    if (launchedLayouts.length) {
      await resizeWrikeTabs(launchedLayouts);
    }
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

  function markTabLaunchingIfNeeded(tabId: string) {
    if (launchedTabIdsRef.current.has(tabId)) {
      return;
    }
    setWrikeTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.mode === "standard" && !tab.isTitleLoading
          ? { ...tab, isTitleLoading: true }
          : tab,
      ),
    );
  }

  async function hideLaunchedTabsExcept(keepIds: string[]) {
    const toHide = wrikeTabsRef.current
      .filter((tab) => !keepIds.includes(tab.id) && launchedTabIdsRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (toHide.length) {
      await hideWrike(toHide);
    }
  }

  async function showWrikeSplit(nextSplit: WrikeSplit, focusTabId: string) {
    syncWrikeSplitRef(nextSplit);
    syncActiveWrikeTabId(focusTabId);
    setScreen("wrike");
    const visibleIds = [nextSplit.leftTabId, nextSplit.rightTabId];
    markTabsActive(visibleIds);
    const launchOrder =
      focusTabId === nextSplit.leftTabId
        ? [nextSplit.rightTabId, nextSplit.leftTabId]
        : [nextSplit.leftTabId, nextSplit.rightTabId];
    for (const tabId of launchOrder) {
      const tab = wrikeTabsRef.current.find((candidate) => candidate.id === tabId);
      markTabLaunchingIfNeeded(tabId);
      launchedTabIdsRef.current.add(tabId);
      const pane: WrikePane = tabId === nextSplit.leftTabId ? "left" : "right";
      await launchWrike(
        tabId,
        tab?.mode === "readOnly" ? READ_ONLY_URL : tab?.url ?? WRIKE_HOME,
        pane,
      );
    }
    await hideLaunchedTabsExcept(visibleIds);
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

  async function showWrike(tabId = activeWrikeTabIdRef.current) {
    const tabs = wrikeTabsRef.current;
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const split = wrikeSplitRef.current;
    if (split && (split.leftTabId === tabId || split.rightTabId === tabId)) {
      if (
        screenRef.current !== "wrike" ||
        !launchedTabIdsRef.current.has(split.leftTabId) ||
        !launchedTabIdsRef.current.has(split.rightTabId)
      ) {
        await showWrikeSplit(split, tabId);
        return;
      }
      syncActiveWrikeTabId(tabId);
      markTabsActive([split.leftTabId, split.rightTabId]);
      await focusWrikeTab(tabId);
      await hideLaunchedTabsExcept([split.leftTabId, split.rightTabId]);
      setScreen("wrike");
      return;
    }
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(tabId);
    markTabLaunchingIfNeeded(tabId);
    markTabsActive([tabId]);
    launchedTabIdsRef.current.add(tabId);
    await launchWrike(
      tabId,
      tab?.mode === "readOnly" ? READ_ONLY_URL : tab?.url ?? WRIKE_HOME,
      "full",
    );
    await hideLaunchedTabsExcept([tabId]);
    setScreen("wrike");
  }

  async function showWrikeHome() {
    const tabId = activeWrikeTabIdRef.current;
    setIsTopbarActionsMenuOpen(false);
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(tabId);
    setWrikeTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, mode: "standard" } : tab)),
    );
    markTabsActive([tabId]);
    launchedTabIdsRef.current.add(tabId);
    await launchWrike(tabId, WRIKE_HOME, "full");
    await hideLaunchedTabsExcept([tabId]);
    setScreen("wrike");
  }

  async function showLocalScreen(next: Exclude<Screen, "wrike">) {
    setIsTopbarActionsMenuOpen(false);
    markTabsActive(visibleWrikeTabIds());
    const toHide = wrikeTabsRef.current
      .filter((tab) => launchedTabIdsRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (toHide.length) {
      await hideWrike(toHide);
    }
    setScreen(next);
  }

  async function addWrikeTab(targetUrl?: string) {
    const tabs = wrikeTabsRef.current;
    const nextTabNumber = tabs.length + 1;
    const url = targetUrl ?? normalizedStartupUrls(settingsRef.current.startupTabUrls)[0];
    const next: WrikeTab = {
      id: createTabId("tab"),
      title: nextTabNumber === 1 ? "Wrike" : `New tab ${nextTabNumber}`,
      url,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: true,
      mode: wrikeModeForUrl(url),
    };
    const nextTabs = [...tabs, next];
    syncWrikeSplitRef(null);
    wrikeTabsRef.current = nextTabs;
    setWrikeTabs(nextTabs);
    syncActiveWrikeTabId(next.id);
    setScreen("wrike");
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    markTabsActive([next.id]);
    launchedTabIdsRef.current.add(next.id);
    await launchWrike(next.id, next.mode === "readOnly" ? READ_ONLY_URL : url, "full");
    const toHide = tabs
      .filter((tab) => launchedTabIdsRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (toHide.length) {
      await hideWrike(toHide);
    }
  }

  async function addReadOnlyTab() {
    const tabs = wrikeTabsRef.current;
    const next: WrikeTab = {
      id: createTabId("read-only"),
      title: "Read Only Mode",
      url: READ_ONLY_URL,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: false,
      mode: "readOnly",
    };
    const nextTabs = [...tabs, next];
    syncWrikeSplitRef(null);
    wrikeTabsRef.current = nextTabs;
    setWrikeTabs(nextTabs);
    syncActiveWrikeTabId(next.id);
    setScreen("wrike");
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    markTabsActive([next.id]);
    launchedTabIdsRef.current.add(next.id);
    await launchWrike(next.id, READ_ONLY_URL, "full");
    const toHide = tabs
      .filter((tab) => launchedTabIdsRef.current.has(tab.id))
      .map((tab) => tab.id);
    if (toHide.length) {
      await hideWrike(toHide);
    }
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
    if (tabs.length <= 1 || closingTabIdsRef.current.has(tabId)) {
      return;
    }
    closingTabIdsRef.current.add(tabId);
    const wasActive = activeWrikeTabIdRef.current === tabId;
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
    tabLastActiveAtRef.current.delete(tabId);
    setSuspendedTabIds((current) => current.filter((id) => id !== tabId));
    wrikeTabsRef.current = remaining;
    setWrikeTabs(remaining);
    const nextActiveTabId =
      survivingSplitTabId ??
      (wasActive ? fallbackTab?.id ?? remaining[0]?.id : activeWrikeTabIdRef.current);
    if (nextActiveTabId) {
      syncActiveWrikeTabId(nextActiveTabId);
    }
    if (survivingSplitTabId) {
      syncWrikeSplitRef(null);
    }
    try {
      if (launchedTabIdsRef.current.delete(tabId)) {
        await closeWrikeTab(tabId).catch(() => undefined);
      }
      if (
        survivingSplitTabId &&
        activeWrikeTabIdRef.current === survivingSplitTabId &&
        wrikeTabExists(survivingSplitTabId)
      ) {
        await showWrike(survivingSplitTabId);
        return;
      }
      if (
        wasActive &&
        fallbackTab &&
        activeWrikeTabIdRef.current === fallbackTab.id &&
        wrikeTabExists(fallbackTab.id)
      ) {
        await showWrike(fallbackTab.id);
      }
    } finally {
      closingTabIdsRef.current.delete(tabId);
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
      target instanceof Element &&
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
      const toHide = visibleWrikeTabIds().filter((id) => launchedTabIdsRef.current.has(id));
      if (toHide.length) {
        void hideWrike(toHide);
      }
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

  const updateSettings = useCallback(async (next: Settings) => {
    try {
      const persisted = await saveSettings(next);
      settingsRef.current = persisted;
      setSettings(persisted);
      setNotice("Preferences saved.");
    } catch (error) {
      setStorageWarning(`Unable to save preferences: ${String(error)}`);
    }
  }, []);

  const handleSettingsChange = useCallback(
    (next: Settings) => {
      void updateSettings(next);
    },
    [updateSettings],
  );

  const handleCheckForUpdates = useCallback(() => {
    void runUpdateCheck(true);
  }, [runUpdateCheck]);

  const handleInstallUpdate = useCallback(() => {
    void startUpdateInstall();
  }, [startUpdateInstall]);

  const handleOpenSourceTask = useCallback((record: DownloadRecord) => {
    void (async () => {
      const tabs = wrikeTabsRef.current;
      const activeTab = tabs.find((tab) => tab.id === activeWrikeTabIdRef.current);
      const preferredTabId =
        activeTab?.mode === "standard"
          ? activeTab.id
          : tabs.find((tab) => tab.mode === "standard")?.id ?? "home";
      try {
        const targetTabId = (await openSourceTask(record, preferredTabId)) ?? preferredTabId;
        if (!wrikeTabsRef.current.some((tab) => tab.id === targetTabId)) {
          const created = createWrikeTab(
            targetTabId,
            record.sourceLabel || "Wrike",
            record.sourceUrl ?? WRIKE_HOME,
            "standard",
          );
          const nextTabs = [...wrikeTabsRef.current, created];
          wrikeTabsRef.current = nextTabs;
          setWrikeTabs(nextTabs);
        }
        launchedTabIdsRef.current.add(targetTabId);
        markTabsActive([targetTabId]);
        syncWrikeSplitRef(null);
        syncActiveWrikeTabId(targetTabId);
        await hideLaunchedTabsExcept([targetTabId]);
        setScreen("wrike");
      } catch (error) {
        setNotice(`Unable to open Wrike task: ${String(error)}`);
      }
    })();
  }, []);

  const handleRevealDownload = useCallback((id: string) => {
    void revealDownload(id).catch((error) =>
      setNotice(`Unable to open folder: ${String(error)}`),
    );
  }, []);

  const handleDeleteDownload = useCallback((record: DownloadRecord) => {
    if (
      !window.confirm(
        `Remove "${record.fileName}" from ABW Files and delete it from your computer?`,
      )
    ) {
      return;
    }
    void deleteDownload(record.id)
      .then(() => {
        evictPreviewById(record.id);
        setDownloads((current) => {
          const next = current.filter((item) => item.id !== record.id);
          setSelectedId((selected) => (selected === record.id ? next[0]?.id ?? null : selected));
          return next;
        });
        setNotice(`Removed ${record.fileName}.`);
      })
      .catch((error) => setNotice(`Unable to remove file: ${String(error)}`));
  }, []);

  const togglePinnedDownload = useCallback(
    (id: string) => {
      const current = settingsRef.current;
      const pinned = new Set(current.pinnedDownloadIds);
      if (pinned.has(id)) {
        pinned.delete(id);
      } else {
        pinned.add(id);
      }
      void updateSettings({ ...current, pinnedDownloadIds: [...pinned] });
    },
    [updateSettings],
  );

  async function toggleSpellCheck() {
    await closeTopbarActionsMenu();
    const current = settingsRef.current;
    const spellCheck = !current.spellCheck;
    try {
      const persisted = await saveSettings({ ...current, spellCheck });
      settingsRef.current = persisted;
      setSettings(persisted);
      setNotice(`Spell check ${persisted.spellCheck ? "enabled" : "disabled"}.`);
    } catch (error) {
      setStorageWarning(`Unable to save spell-check preference: ${String(error)}`);
    }
  }

  const testNotification = useCallback(async () => {
    try {
      await sendTestNotification();
      setNotice("Test notification sent.");
    } catch {
      setNotice("Unable to send a notification. Check Windows notification permissions.");
    }
  }, []);

  const handleTestNotification = useCallback(() => {
    void testNotification();
  }, [testNotification]);

  const refreshDownloadsStats = useCallback(() => {
    void getDownloadsStorageStats()
      .then(setDownloadsStats)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (screen === "settings") {
      refreshDownloadsStats();
    }
  }, [downloads, refreshDownloadsStats, screen, settings.pinnedDownloadIds]);

  const handleClearUnpinnedDownloads = useCallback(() => {
    if (
      !window.confirm(
        "Remove all unpinned downloaded files from ABW Files and delete them from your computer? Pinned files will be kept.",
      )
    ) {
      return;
    }
    setClearingDownloads(true);
    void clearUnpinnedDownloads()
      .then(async (result) => {
        const nextRecords = await loadDownloads().catch(() => null);
        if (nextRecords) {
          setDownloads(nextRecords);
          const remaining = new Set(nextRecords.map((item) => item.id));
          setSelectedId((current) => (current && remaining.has(current) ? current : nextRecords[0]?.id ?? null));
        }
        refreshDownloadsStats();
        setNotice(
          result.removedCount > 0
            ? `Removed ${result.removedCount} unpinned ${result.removedCount === 1 ? "file" : "files"} (${formatBytes(result.freedBytes)}).`
            : "No unpinned downloads to remove.",
        );
      })
      .catch((error) => setNotice(`Unable to clean up downloads: ${String(error)}`))
      .finally(() => setClearingDownloads(false));
  }, [refreshDownloadsStats]);

  async function openTopbarActionsMenu() {
    setIsTopbarActionsMenuOpen(true);
  }

  async function closeTopbarActionsMenu() {
    setIsTopbarActionsMenuOpen(false);
  }

  async function toggleTopbarActionsMenu() {
    if (isTopbarActionsMenuOpen) {
      await closeTopbarActionsMenu();
    } else {
      await openTopbarActionsMenu();
    }
  }

  shortcutHandlerRef.current = (shortcut) => {
    const tabs = wrikeTabsRef.current;
    if (shortcut.action === "new-tab") {
      void addWrikeTab();
      return;
    }
    if (shortcut.action === "open-url" && shortcut.url) {
      void addWrikeTab(shortcut.url);
      return;
    }
    if (shortcut.action === "close-tab") {
      if (tabs.length > 1) {
        void closeTab(activeWrikeTabIdRef.current);
      }
      return;
    }
    if (shortcut.action === "next-tab" || shortcut.action === "prev-tab") {
      if (tabs.length <= 1) {
        return;
      }
      const currentIndex = tabs.findIndex((tab) => tab.id === activeWrikeTabIdRef.current);
      const nextIndex = nextTabIndexForCycle(
        currentIndex,
        tabs.length,
        shortcut.action === "next-tab" ? 1 : -1,
      );
      const target = tabs[nextIndex];
      if (target) {
        void showWrike(target.id);
      }
      return;
    }
    if (shortcut.action === "select-tab" && shortcut.index !== null) {
      const targetIndex = tabIndexFromShortcutDigit(shortcut.index, tabs.length);
      const target = targetIndex !== null ? tabs[targetIndex] : null;
      if (target) {
        void showWrike(target.id);
      }
      return;
    }
    if (shortcut.action === "toggle-split") {
      if (wrikeSplitRef.current) {
        void exitSplitView(activeWrikeTabIdRef.current);
      } else if (tabs.length > 1) {
        void splitWrikeTab(activeWrikeTabIdRef.current, "left");
      } else {
        setNotice("Open another tab to use split view.");
      }
    }
  };

  navActionHandlerRef.current = (action) => {
    void runWrikeTabAction(activeWrikeTabIdRef.current, action);
  };

  return (
    <>
    <div className="app-shell" data-theme={settings.theme} spellCheck={settings.spellCheck}>
      <header
        className={`taskbar ${wrikeTabs.length >= 4 ? "is-tab-crowded" : ""}`}
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
            const suspended = suspendedTabIds.includes(tab.id);
            return (
              <div
                aria-selected={selected}
                className={[
                  "workspace-tab",
                  selected ? "selected" : "",
                  tab.mode === "readOnly" ? "read-only" : "",
                  suspended ? "suspended" : "",
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
                title={suspended ? `${tab.title} (suspended to save memory)` : tab.title}
              >
                <span className={`tab-title ${tab.isTitleLoading ? "loading" : ""}`}>{tab.title}</span>
                {index === 0 ? <span className="external-dot" /> : null}
                <span className="tab-actions" aria-label={`${tab.title} controls`}>
                  <button
                    aria-label={`Close ${tab.title}`}
                    disabled={wrikeTabs.length <= 1}
                    draggable={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      void closeTab(tab.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
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
              onPointerDown={(event) => event.stopPropagation()}
              title="New Wrike tab"
            >
              <MaterialIcon kind="add" />
            </button>
            <button
              aria-label="New read only Wrike tab"
              className="read-only-launcher"
              onClick={() => void addReadOnlyTab()}
              onPointerDown={(event) => event.stopPropagation()}
              title="Read Only Mode"
            >
              <MaterialIcon kind="description" />
              <span>Read Only</span>
            </button>
          </span>
          <span className="tab-space" aria-hidden="true" />
        </div>
        <div className="titlebar-session-slot" aria-live="polite">
          {appUpdate.phase === "downloading" || appUpdate.phase === "installing" ? (
            <div className="titlebar-session-toast titlebar-update-toast" role="status">
              <span>
                {appUpdate.phase === "installing"
                  ? `Installing v${appUpdate.latestVersion ?? ""} and restarting...`
                  : appUpdate.totalBytes && appUpdate.totalBytes > 0
                    ? `Downloading v${appUpdate.latestVersion ?? ""}... ${Math.min(100, Math.round((appUpdate.downloadedBytes / appUpdate.totalBytes) * 100))}%`
                    : `Downloading v${appUpdate.latestVersion ?? ""}...`}
              </span>
            </div>
          ) : sessionPrompt ? (
            <div className="titlebar-session-toast" role="status">
              <span>
                Reopen previous session with {sessionPrompt.tabs.length}{" "}
                {sessionPrompt.tabs.length === 1 ? "tab" : "tabs"}?
              </span>
              <span className="toast-actions">
                <button onClick={() => void restorePreviousSession(sessionPrompt)}>Reopen</button>
                <button onClick={dismissSessionPrompt}>Skip</button>
              </span>
            </div>
          ) : appUpdate.phase === "available" &&
            appUpdate.latestVersion &&
            !appUpdate.dismissedPrompt ? (
            <div className="titlebar-session-toast titlebar-update-toast" role="status">
              <span>Update v{appUpdate.latestVersion} available</span>
              <span className="toast-actions">
                <button onClick={() => void startUpdateInstall()}>Update</button>
                <button onClick={dismissUpdatePrompt}>Later</button>
              </span>
            </div>
          ) : null}
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
              title={
                appUpdate.phase === "available" && appUpdate.latestVersion
                  ? `Settings (Update v${appUpdate.latestVersion} available)`
                  : undefined
              }
            >
              <MaterialIcon kind="settings" />
              Settings
              {appUpdate.phase === "available" ? (
                <span className="settings-update-dot" aria-hidden="true" />
              ) : null}
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
            onPointerDown={(event) => event.stopPropagation()}
            title="Show ABW actions"
          >
            <MaterialIcon kind={isTopbarActionsMenuOpen ? "keyboard_arrow_right" : "keyboard_arrow_left"} />
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
              {appUpdate.phase === "available" ? (
                <span className="settings-update-dot" aria-hidden="true" />
              ) : null}
            </button>
          </div>
        </div>
        <div className="topbar-notice-slot" aria-live="polite">
          {notice ? (
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
      {storageWarning ? (
        <div className="storage-warning" role="alert">
          <span>{storageWarning}</span>
          <button aria-label="Dismiss data warning" onClick={() => setStorageWarning(null)}>
            <NavIcon kind="close" />
          </button>
        </div>
      ) : null}
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
              onDelete={handleDeleteDownload}
              onFilterChange={setFilter}
              onOpenSourceTask={handleOpenSourceTask}
              onReveal={handleRevealDownload}
              onSearchChange={setSearch}
              onSelect={setSelectedId}
              onTogglePin={togglePinnedDownload}
              pinnedIds={settings.pinnedDownloadIds}
              search={search}
              selectedId={selectedRecord?.id ?? null}
            />
            <Suspense fallback={<div className="preview-panel loading">Loading preview...</div>}>
              <PreviewPanel
                onDeleteDownload={handleDeleteDownload}
                onOpenSourceTask={handleOpenSourceTask}
                onRevealDownload={handleRevealDownload}
                record={selectedRecord}
              />
            </Suspense>
          </div>
        ) : (
          <div className="settings-screen">
            <SettingsPanel
              appVersion={APP_VERSION}
              clearingDownloads={clearingDownloads}
              downloadsStats={downloadsStats}
              settings={settings}
              updateState={appUpdate}
              onChange={handleSettingsChange}
              onCheckForUpdates={handleCheckForUpdates}
              onClearUnpinnedDownloads={handleClearUnpinnedDownloads}
              onInstallUpdate={handleInstallUpdate}
              onTestNotification={handleTestNotification}
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

type MaterialIconKind =
  | "add"
  | "arrow_back"
  | "arrow_forward"
  | "close"
  | "description"
  | "home"
  | "keyboard_arrow_left"
  | "keyboard_arrow_right"
  | "link"
  | "refresh"
  | "settings"
  | "share"
  | "tab"
  | "view_column"
  | "window_maximize"
  | "window_minimize"
  | "window_restore";

const MATERIAL_ICON_PATHS: Record<MaterialIconKind, ReactElement> = {
  home: <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8Z" />,
  add: <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6Z" />,
  arrow_back: <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20Z" />,
  arrow_forward: <path d="m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8Z" />,
  close: (
    <path d="M18.3 5.71 16.89 4.3 12 9.17 7.11 4.3 5.7 5.71 10.59 10.6 5.7 15.49l1.41 1.41L12 12.01l4.89 4.89 1.41-1.41-4.89-4.89Z" />
  ),
  description: (
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm1 7V3.5L20.5 9ZM16 18H8v-2h8Zm0-4H8v-2h8Z" />
  ),
  keyboard_arrow_left: <path d="m15.41 16.59-4.58-4.59 4.58-4.59L14 6l-6 6 6 6Z" />,
  keyboard_arrow_right: <path d="m8.59 16.59 4.58-4.59-4.58-4.59L10 6l6 6-6 6Z" />,
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
  view_column: (
    <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm2 0v14h5V5Zm7 0v14h5V5Z" />
  ),
  window_maximize: <path d="M6 6h12v12H6Zm2 2v8h8V8Z" />,
  window_minimize: <path d="M6 12h12v2H6Z" />,
  window_restore: <path d="M8 4h12v12h-4v4H4V8h4Zm2 4h6v6h2V6h-8Zm4 2H6v8h8Z" />,
};

function MaterialIcon({ kind }: { kind: MaterialIconKind }) {
  return (
    <svg className="material-icon" viewBox="0 0 24 24" aria-hidden="true">
      {MATERIAL_ICON_PATHS[kind]}
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

const NAV_ICON_PATHS: Record<string, ReactElement> = {
  home: <path d="M3.5 9.3 12 3l8.5 6.3V20H14v-5h-4v5H3.5Z" />,
  file: <path d="M6 3.5h8l4 4V21H6Zm8 0v5h4M9 13h6M9 17h6" />,
  gear: (
    <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm0-5 1.4 2.4 2.8-.1.2 2.8 2.5 1.3-1.3 2.5 1.3 2.5-2.5 1.3-.2 2.8-2.8-.1-1.4 2.4-1.4-2.4-2.8.1-.2-2.8-2.5-1.3 1.3-2.5-1.3-2.5 2.5-1.3.2-2.8 2.8.1Z" />
  ),
  spell: <path d="M5 19 10.2 5h3.6L19 19m-12-5h10M4 21h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

function NavIcon({ kind }: { kind: string }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      {NAV_ICON_PATHS[kind]}
    </svg>
  );
}
