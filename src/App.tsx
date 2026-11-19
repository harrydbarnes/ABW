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
import {
  checkForAppUpdate,
  closeWrikeTab,
  focusWrikeTab,
  getWrikeTabState,
  installAppUpdate,
  launchWrike,
  hideWrike,
  isDesktopRuntime,
  loadDownloads,
  loadSettings,
  loadStorageHealth,
  notifyUpdateAvailable,
  openSourceTask,
  resetApp,
  resizeWrikeTabs,
  saveSettings,
  saveWrikeSession,
  sendTestNotification,
  setUpdateTaskbarBadge,
  subscribeToDownloadCompleted,
  subscribeToDownloadErrors,
  subscribeToDownloads,
  subscribeToOpenInNewTab,
  subscribeToSettingsUpdates,
  subscribeToShareUrl,
  subscribeToWrikeShortcuts,
  subscribeToWrikeTabUpdates,
  wrikeTabAction,
  type WrikeShortcutEvent,
  type WrikeTabAction,
  type WrikeTabLayout,
  type WrikeTabUpdate,
} from "./lib/desktop";
import {
  filterAndSortDownloads,
  nextTabIndexForCycle,
  tabIndexFromShortcutDigit,
} from "./lib/workspaceUtils";
import type {
  AppUpdateState,
  DownloadRecord,
  FavoriteTicket,
  FileFilter,
  Settings,
  VisitHistoryEntry,
  WrikeSession,
} from "./types";

const PreviewPanel = lazy(() => import("./features/preview/PreviewPanel"));
const SettingsPanel = lazy(() =>
  import("./features/settings/SettingsPanel").then((module) => ({
    default: module.SettingsPanel,
  })),
);
const TicketDrawerModal = lazy(() => import("./features/tickets/TicketDrawerModal"));
const WRIKE_HOME = "https://www.wrike.com/workspace.htm";

function extractWrikeTicketMetadata(title: string, url: string): { client?: string; details?: string } {
  const detailsParts: string[] = [];
  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get("id");
    if (queryId) {
      detailsParts.push(`ID ${queryId}`);
    }
    const hashId = parsed.hash.match(/id=(\d+)/i)?.[1];
    if (hashId && hashId !== queryId) {
      detailsParts.push(`ID ${hashId}`);
    }
    const pathMatch = parsed.hash.match(/path=([^&]+)/i)?.[1];
    if (pathMatch) {
      detailsParts.push(decodeURIComponent(pathMatch).replace(/^[a-z]+/i, (m) => m.toUpperCase()));
    }
  } catch {
    // Ignore URL parse issues
  }
  const cleanTitle = title.trim();
  let client: string | undefined;
  const underscorePrefix = cleanTitle.match(/^([A-Za-z0-9 &'-]{2,24})_/);
  if (underscorePrefix) {
    client = underscorePrefix[1].trim();
  } else {
    const dashPrefix = cleanTitle.match(/^([A-Za-z0-9 &'-]{2,24})\s+-\s+/);
    if (dashPrefix) {
      client = dashPrefix[1].trim();
    }
  }
  return {
    client,
    details: detailsParts.length ? detailsParts.join(" · ") : undefined,
  };
}
const READ_ONLY_URL = "https://login.wrike.com/login/?forceLogin=false&read";
const APP_VERSION = import.meta.env.VITE_APP_VERSION;
const LAUNCH_SPLASH_DURATION_MS = 2800;
const PERIODIC_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
const FOCUS_UPDATE_CHECK_MIN_AGE_MS = 60 * 60 * 1000;
const TOP_BANNER_HEIGHT = 42;

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
    showSpellCheckInTopbar: false,
    launchWrikeOnStart: true,
    downloadNotifications: true,
    openAbwAtSystemStartup: false,
    closeToNotificationArea: true,
    confirmBeforeClosingTabs: false,
    openDownloadedFilesAutomatically: false,
    openExternalLinksInBrowser: true,
    autoCheckForUpdates: true,
    autoMatchWrikeTheme: true,
    theme: "default",
    customDictionary: [],
    startupTabUrls: [WRIKE_HOME],
    pinnedDownloadIds: [],
    favoriteTickets: [],
    visitHistory: [],
    lastWrikeSession: null,
  });
  const [ticketModal, setTicketModal] = useState<"favorites" | "history" | null>(null);
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
  const [sessionPrompt, setSessionPrompt] = useState<WrikeSession | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [reloadingTabId, setReloadingTabId] = useState<string | null>(null);
  const wrikeTabsRef = useRef(wrikeTabs);
  const activeWrikeTabIdRef = useRef(activeWrikeTabId);
  const wrikeSplitRef = useRef(wrikeSplit);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const lastRecordedVisitRef = useRef<Map<string, string>>(new Map());
  const canPersistSessionRef = useRef(false);
  const updateRequestInFlightRef = useRef(false);
  const appUpdatePhaseRef = useRef(appUpdate.phase);
  const lastNotifiedUpdateVersionRef = useRef<string | null>(null);
  const lastUpdateCheckAtRef = useRef(0);
  const autoUpdateTimerRef = useRef<number | undefined>(undefined);
  const reloadAnimationTimerRef = useRef<number | undefined>(undefined);
  const sessionSaveTimerRef = useRef<number | undefined>(undefined);
  const closingTabIdsRef = useRef(new Set<string>());
  const tabIdCounterRef = useRef(0);
  const launchStartedAtRef = useRef(Date.now());
  const shortcutHandlerRef = useRef<(shortcut: WrikeShortcutEvent) => void>(() => undefined);

  const showUpdateBanner =
    (appUpdate.phase === "available" ||
      appUpdate.phase === "downloading" ||
      appUpdate.phase === "installing") &&
    !appUpdate.dismissedPrompt;
  const topBannerInset =
    (showUpdateBanner ? TOP_BANNER_HEIGHT : 0) + (storageWarning ? TOP_BANNER_HEIGHT : 0);
  const topBannerInsetRef = useRef(topBannerInset);
  topBannerInsetRef.current = topBannerInset;

  useEffect(() => {
    if (storageWarning) setScreen("settings");
  }, [storageWarning]);

  useEffect(() => {
    if (!isDesktopRuntime()) {
      return;
    }
    void resizeWrikeTabs(currentWrikeLayouts(), topBannerInset).catch(() => undefined);
  }, [topBannerInset]);

  useEffect(() => {
    if (!isDesktopRuntime() || !settings.autoCheckForUpdates) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void runUpdateCheck(false);
    }, PERIODIC_UPDATE_CHECK_MS);
    const handleWindowFocus = () => {
      if (Date.now() - lastUpdateCheckAtRef.current >= FOCUS_UPDATE_CHECK_MIN_AGE_MS) {
        void runUpdateCheck(false);
      }
    };
    window.addEventListener("focus", handleWindowFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [settings.autoCheckForUpdates]);

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
    appUpdatePhaseRef.current = appUpdate.phase;
    if (isDesktopRuntime()) {
      void setUpdateTaskbarBadge(appUpdate.phase === "available").catch(() => undefined);
    }
  }, [appUpdate.phase]);

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
      void saveWrikeSession(currentWrikeSession()).catch((error) =>
        setStorageWarning(`Unable to save your tab session: ${String(error)}`),
      );
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

  async function runUpdateCheck(manual: boolean) {
    if (
      updateRequestInFlightRef.current ||
      appUpdatePhaseRef.current === "downloading" ||
      appUpdatePhaseRef.current === "installing"
    ) {
      return;
    }
    updateRequestInFlightRef.current = true;
    lastUpdateCheckAtRef.current = Date.now();
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
        if (lastNotifiedUpdateVersionRef.current !== result.latestVersion) {
          lastNotifiedUpdateVersionRef.current = result.latestVersion;
          void notifyUpdateAvailable(result.latestVersion).catch(() => undefined);
        }
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
  }

  async function startUpdateInstall() {
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
  }

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
    void Promise.all([loadSettings(), loadStorageHealth()]).then(async ([next, warnings]) => {
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
      const canRestoreSession = hasRestorableSession(
        next.lastWrikeSession,
        next.startupTabUrls,
        next.launchWrikeOnStart,
      );
      if (canRestoreSession) {
        setSessionPrompt(next.lastWrikeSession);
      }
      if (next.launchWrikeOnStart) {
        await waitForLaunchSplash();
        await openStartupTabs(next.startupTabUrls);
        if (!canRestoreSession) {
          canPersistSessionRef.current = true;
        }
      } else {
        setScreen("files");
        if (!canRestoreSession) {
          canPersistSessionRef.current = true;
        }
      }
    }).catch((error) => setStorageWarning(`Unable to load preferences: ${String(error)}`));
    let dispose: () => void = () => undefined;
    let disposeCompleted: () => void = () => undefined;
    let disposeErrors: () => void = () => undefined;
    let disposeTabUpdates: () => void = () => undefined;
    let disposeSettingsUpdates: () => void = () => undefined;
    let disposeOpenInNewTab: () => void = () => undefined;
    let disposeShareUrl: () => void = () => undefined;
    let disposeShortcuts: () => void = () => undefined;
    void subscribeToDownloads(refresh).then((unsubscribe) => {
      dispose = unsubscribe;
    });
    void subscribeToDownloadCompleted((record) => {
      setSelectedId(record.id);
      setNotice(`${record.fileName} is ready in Files.`);
    }).then((unsubscribe) => {
      disposeCompleted = unsubscribe;
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
      const cleanTitle = update.title.trim();
      const targetUrl = update.url?.trim() ?? "";
      if (
        targetUrl &&
        targetUrl !== "about:blank" &&
        !update.isTitleLoading &&
        cleanTitle &&
        cleanTitle !== "Wrike" &&
        cleanTitle !== "Read Only Mode"
      ) {
        const signature = `${targetUrl}::${cleanTitle}`;
        if (lastRecordedVisitRef.current.get(update.tabId) !== signature) {
          lastRecordedVisitRef.current.set(update.tabId, signature);
          const currentSettings = settingsRef.current;
          const now = new Date().toISOString();
          const { client, details } = extractWrikeTicketMetadata(cleanTitle, targetUrl);
          const existingIndex = currentSettings.visitHistory.findIndex(
            (entry) => entry.url === targetUrl,
          );
          let nextHistory: VisitHistoryEntry[];
          if (existingIndex >= 0) {
            const existing = currentSettings.visitHistory[existingIndex];
            const updated: VisitHistoryEntry = {
              ...existing,
              title: cleanTitle,
              client: client ?? existing.client,
              details: details ?? existing.details,
              lastVisitedAt: now,
              visitCount: existing.visitCount + 1,
            };
            nextHistory = [
              updated,
              ...currentSettings.visitHistory.filter((_, idx) => idx !== existingIndex),
            ];
          } else {
            nextHistory = [
              {
                id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                title: cleanTitle,
                url: targetUrl,
                client,
                details,
                lastVisitedAt: now,
                visitCount: 1,
              },
              ...currentSettings.visitHistory,
            ].slice(0, 250);
          }
          const nextSettings = { ...currentSettings, visitHistory: nextHistory };
          settingsRef.current = nextSettings;
          setSettings(nextSettings);
          void saveSettings(nextSettings).catch(() => undefined);
        }
      }
    }).then((unsubscribe) => {
      disposeTabUpdates = unsubscribe;
    });
    void subscribeToSettingsUpdates((next) => {
      setSettings(next);
    }).then((unsubscribe) => {
      disposeSettingsUpdates = unsubscribe;
    });
    void subscribeToOpenInNewTab((url) => {
      void addWrikeTab(url);
    }).then((unsubscribe) => {
      disposeOpenInNewTab = unsubscribe;
    });
    void subscribeToShareUrl((url) => {
      if (navigator.share) {
        void navigator.share({ title: "Wrike", url }).catch(() => undefined);
      } else {
        void navigator.clipboard?.writeText(url).then(() => {
          setNotice("Link copied to clipboard for sharing.");
        }).catch(() => undefined);
      }
    }).then((unsubscribe) => {
      disposeShareUrl = unsubscribe;
    });
    void subscribeToWrikeShortcuts((shortcut) => {
      shortcutHandlerRef.current(shortcut);
    }).then((unsubscribe) => {
      disposeShortcuts = unsubscribe;
    });
    return () => {
      dispose();
      disposeCompleted();
      disposeErrors();
      disposeTabUpdates();
      disposeSettingsUpdates();
      disposeOpenInNewTab();
      disposeShareUrl();
      disposeShortcuts();
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

  function isWrikeHomepageUrl(rawUrl: string): boolean {
    try {
      const parsed = new URL(rawUrl);
      const isWrikeHost =
        parsed.hostname === "wrike.com" || parsed.hostname.endsWith(".wrike.com");
      if (!isWrikeHost || !parsed.pathname.endsWith("/workspace.htm")) {
        return false;
      }
      if (parsed.searchParams.has("id") || /\bid=\d+/i.test(parsed.hash)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function hasRestorableSession(
    session: WrikeSession | null,
    startupUrls = settings.startupTabUrls,
    launchOnStart = settings.launchWrikeOnStart,
  ): session is WrikeSession {
    if (!session?.tabs.some((tab) => normalizeUrlInput(tab.url ?? ""))) {
      return false;
    }
    if (launchOnStart && !session.split) {
      const expected = normalizedStartupUrls(startupUrls);
      if (
        session.tabs.length === expected.length &&
        session.tabs.every((tab, index) => {
          if (tab.mode !== "standard") {
            return false;
          }
          const actualUrl = normalizeUrlInput(tab.url ?? "");
          if (!actualUrl) {
            return false;
          }
          if (actualUrl.replace(/\/$/, "") === expected[index].replace(/\/$/, "")) {
            return true;
          }
          return isWrikeHomepageUrl(expected[index]) && isWrikeHomepageUrl(actualUrl);
        })
      ) {
        return false;
      }
    }
    return true;
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

  async function waitForLaunchSplash() {
    const elapsed = Date.now() - launchStartedAtRef.current;
    const remaining = LAUNCH_SPLASH_DURATION_MS - elapsed;
    if (remaining > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
    }
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
    await Promise.all(oldTabs.map((tab) => closeWrikeTab(tab.id).catch(() => undefined)));
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
    await Promise.all(
      launchOrder.map((tab) =>
        launchWrike(tab.id, tab.mode === "readOnly" ? READ_ONLY_URL : tab.url ?? WRIKE_HOME),
      ),
    );
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
    await resizeWrikeTabs(currentWrikeLayouts(), topBannerInsetRef.current);
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

  function isTabFavorited(tab: WrikeTab): boolean {
    const targetUrl = tab.url ?? "";
    if (!targetUrl) {
      return false;
    }
    return settings.favoriteTickets.some((item) => item.url === targetUrl);
  }

  function toggleFavoriteTab(tab: WrikeTab) {
    const targetUrl = tab.url ?? normalizedStartupUrls()[0];
    if (!targetUrl) {
      return;
    }
    const exists = settings.favoriteTickets.some((item) => item.url === targetUrl);
    let nextFavorites: FavoriteTicket[];
    if (exists) {
      nextFavorites = settings.favoriteTickets.filter((item) => item.url !== targetUrl);
    } else {
      const cleanTitle = tab.title.trim() || "Wrike";
      const { client, details } = extractWrikeTicketMetadata(cleanTitle, targetUrl);
      nextFavorites = [
        {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          title: cleanTitle,
          url: targetUrl,
          client,
          details,
          addedAt: new Date().toISOString(),
        },
        ...settings.favoriteTickets,
      ];
    }
    void updateSettings({ ...settings, favoriteTickets: nextFavorites });
  }

  async function openTicketModal(mode: "favorites" | "history") {
    setIsTopbarActionsMenuOpen(false);
    setTabMenu(null);
    if (ticketModal === mode) {
      await closeTicketModal();
      return;
    }
    if (screen === "wrike") {
      await hideWrike(wrikeTabsRef.current.map((tab) => tab.id));
    }
    setTicketModal(mode);
  }

  async function closeTicketModal() {
    setTicketModal(null);
    if (screen === "wrike") {
      await restoreWrikeView();
    }
  }

  async function openTicketUrl(url: string, title?: string) {
    setTicketModal(null);
    const tabs = wrikeTabsRef.current;
    const currentActive = tabs.find((tab) => tab.id === activeWrikeTabIdRef.current);
    const targetTab =
      (currentActive && currentActive.mode === "standard" ? currentActive : null) ??
      tabs.find((tab) => tab.id === "home" && tab.mode === "standard") ??
      tabs.find((tab) => tab.mode === "standard") ??
      tabs[0] ??
      INITIAL_WRIKE_TAB;
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(targetTab.id);
    setScreen("wrike");
    setWrikeTabs((current) =>
      current.map((tab) =>
        tab.id === targetTab.id
          ? {
              ...tab,
              title: title?.trim() || tab.title,
              url,
              isTitleLoading: true,
              mode: "standard",
            }
          : tab,
      ),
    );
    await resizeWrikeTabs(
      currentWrikeLayouts(null, targetTab.id),
      topBannerInsetRef.current,
    ).catch(() => undefined);
    await launchWrike(targetTab.id, url);
    await hideWrike(tabs.filter((tab) => tab.id !== targetTab.id).map((tab) => tab.id));
  }

  function removeFavoriteUrl(url: string) {
    void updateSettings({
      ...settings,
      favoriteTickets: settings.favoriteTickets.filter((item) => item.url !== url),
    });
  }

  function clearVisitHistory() {
    lastRecordedVisitRef.current.clear();
    void updateSettings({
      ...settings,
      visitHistory: [],
    });
  }

  async function handleResetApp() {
    try {
      const defaults = await resetApp();
      settingsRef.current = defaults;
      setSettings(defaults);
      setSessionPrompt(null);
      setTicketModal(null);
      lastRecordedVisitRef.current.clear();
      setSearch("");
      setFilter("all");
      for (const tab of wrikeTabsRef.current) {
        if (tab.id !== INITIAL_WRIKE_TAB.id) {
          await closeWrikeTab(tab.id).catch(() => undefined);
        }
      }
      syncWrikeSplitRef(null);
      wrikeTabsRef.current = [INITIAL_WRIKE_TAB];
      setWrikeTabs([INITIAL_WRIKE_TAB]);
      syncActiveWrikeTabId(INITIAL_WRIKE_TAB.id);
      setNotice("ABW has been reset to default settings.");
    } catch (error) {
      setStorageWarning(`Unable to reset ABW: ${String(error)}`);
    }
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
    setTicketModal(null);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    setScreen(next);
  }

  async function openRecordSourceTask(record: DownloadRecord) {
    setIsTopbarActionsMenuOpen(false);
    const tabs = wrikeTabsRef.current;
    const currentActive = tabs.find((tab) => tab.id === activeWrikeTabIdRef.current);
    const targetTab =
      (currentActive && currentActive.mode === "standard" ? currentActive : null) ??
      tabs.find((tab) => tab.id === "home" && tab.mode === "standard") ??
      tabs.find((tab) => tab.mode === "standard") ??
      tabs[0] ??
      INITIAL_WRIKE_TAB;
    syncWrikeSplitRef(null);
    syncActiveWrikeTabId(targetTab.id);
    setScreen("wrike");
    if (record.sourceUrl) {
      setWrikeTabs((current) =>
        current.map((tab) =>
          tab.id === targetTab.id
            ? { ...tab, url: record.sourceUrl, isTitleLoading: true, mode: "standard" }
            : tab,
        ),
      );
      await resizeWrikeTabs(currentWrikeLayouts(null, targetTab.id)).catch(() => undefined);
      await openSourceTask(record, targetTab.id);
      await hideWrike(tabs.filter((tab) => tab.id !== targetTab.id).map((tab) => tab.id));
      const update = await getWrikeTabState(targetTab.id);
      if (update) {
        setWrikeTabs((current) =>
          current.map((tab) => (tab.id === targetTab.id ? applyWrikeTabUpdate(tab, update) : tab)),
        );
      }
      return;
    }
    await showWrike(targetTab.id);
  }

  async function addWrikeTab(initialUrl?: string) {
    const tabs = wrikeTabsRef.current;
    const nextTabNumber = tabs.length + 1;
    const url = initialUrl || normalizedStartupUrls()[0];
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
    await launchWrike(next.id, next.mode === "readOnly" ? READ_ONLY_URL : url);
    await hideWrike(tabs.map((tab) => tab.id));
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
    await launchWrike(next.id, READ_ONLY_URL);
    await hideWrike(tabs.map((tab) => tab.id));
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
      await closeWrikeTab(tabId).catch(() => undefined);
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
    try {
      const persisted = await saveSettings(next);
      setSettings(persisted);
      setNotice("Preferences saved.");
    } catch (error) {
      setStorageWarning(`Unable to save preferences: ${String(error)}`);
    }
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
    try {
      const persisted = await saveSettings({ ...settings, spellCheck });
      setSettings(persisted);
      setNotice(`Spell check ${persisted.spellCheck ? "enabled" : "disabled"}.`);
    } catch (error) {
      setStorageWarning(`Unable to save spell-check preference: ${String(error)}`);
    }
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
                    aria-label={isTabFavorited(tab) ? `Remove ${tab.title} from favourites` : `Add ${tab.title} to favourites`}
                    aria-pressed={isTabFavorited(tab)}
                    className={`tab-star ${isTabFavorited(tab) ? "favorited" : ""}`}
                    draggable={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavoriteTab(tab);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={isTabFavorited(tab) ? "Remove from favourites" : "Add to favourites"}
                  >
                    <MaterialIcon kind={isTabFavorited(tab) ? "star" : "star_outline"} />
                  </button>
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
          {settings.showSpellCheckInTopbar ? (
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
          ) : null}
          <nav className="task-navigation" aria-label="ABW navigation">
            {settings.favoriteTickets.length > 0 ? (
              <button
                className={`nav-item ${ticketModal === "favorites" ? "selected" : ""}`}
                onClick={() => void openTicketModal("favorites")}
                title="Favourited tickets"
              >
                <MaterialIcon kind="star" />
                Favourites
              </button>
            ) : null}
            <button
              className={`nav-item ${ticketModal === "history" ? "selected" : ""}`}
              onClick={() => void openTicketModal("history")}
              title="Ticket visit history"
            >
              <MaterialIcon kind="history" />
              History
            </button>
            <button
              className={`nav-item ${!ticketModal && screen === "files" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("files")}
            >
              <MaterialIcon kind="description" />
              Files
            </button>
            <button
              className={`nav-item ${!ticketModal && screen === "settings" ? "selected" : ""}`}
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
            {settings.showSpellCheckInTopbar ? (
              <button
                aria-pressed={settings.spellCheck}
                className="topbar-menu-item"
                onClick={() => void toggleSpellCheck()}
              >
                <NavIcon kind="spell" />
                <span>Spell check {settings.spellCheck ? "on" : "off"}</span>
              </button>
            ) : null}
            {settings.favoriteTickets.length > 0 ? (
              <button
                className={`topbar-menu-item ${ticketModal === "favorites" ? "selected" : ""}`}
                onClick={() => void openTicketModal("favorites")}
              >
                <MaterialIcon kind="star" />
                <span>Favourites</span>
              </button>
            ) : null}
            <button
              className={`topbar-menu-item ${ticketModal === "history" ? "selected" : ""}`}
              onClick={() => void openTicketModal("history")}
            >
              <MaterialIcon kind="history" />
              <span>History</span>
            </button>
            <button
              className={`topbar-menu-item ${!ticketModal && screen === "files" ? "selected" : ""}`}
              onClick={() => void showLocalScreen("files")}
            >
              <MaterialIcon kind="description" />
              <span>Files</span>
            </button>
            <button
              className={`topbar-menu-item ${!ticketModal && screen === "settings" ? "selected" : ""}`}
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
      {showUpdateBanner ? (
        <div className="update-banner" role="status" aria-live="polite">
          <div className="update-banner-copy">
            <strong>
              {appUpdate.phase === "downloading"
                ? `Downloading ABW v${appUpdate.latestVersion ?? ""}...`
                : appUpdate.phase === "installing"
                  ? `Installing ABW v${appUpdate.latestVersion ?? ""}...`
                  : `ABW v${appUpdate.latestVersion ?? ""} is available`}
            </strong>
            <span>
              {appUpdate.phase === "downloading"
                ? appUpdate.totalBytes
                  ? `${Math.min(100, Math.round((appUpdate.downloadedBytes / appUpdate.totalBytes) * 100))}% downloaded`
                  : "Downloading update package..."
                : appUpdate.phase === "installing"
                  ? "ABW will restart automatically once installation finishes."
                  : "Update now to get the latest fixes and improvements."}
            </span>
          </div>
          <div className="update-banner-actions">
            {appUpdate.phase === "available" ? (
              <button
                className="update-banner-primary"
                onClick={() => void startUpdateInstall()}
                type="button"
              >
                Update now
              </button>
            ) : null}
            <button
              className="update-banner-secondary"
              onClick={() => void showLocalScreen("settings")}
              type="button"
            >
              View details
            </button>
            {appUpdate.phase === "available" ? (
              <button
                aria-label="Dismiss update banner"
                className="update-banner-dismiss"
                onClick={dismissUpdatePrompt}
                type="button"
              >
                <NavIcon kind="close" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
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
          <span className="menu-separator" />
          <button
            disabled={wrikeTabs.length <= 1}
            onClick={() => void closeTab(menuTab.id)}
            role="menuitem"
          >
            <MaterialIcon kind="close" />
            Close tab
          </button>
          <span className="menu-separator" />
          <button onClick={() => void shareTab(menuTab)} role="menuitem">
            <MaterialIcon kind="share" />
            Share
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
              onOpenSourceTask={(record) => void openRecordSourceTask(record)}
              onSearchChange={setSearch}
              onSelect={setSelectedId}
              onTogglePin={togglePinnedDownload}
              pinnedIds={settings.pinnedDownloadIds}
              search={search}
              selectedId={selectedRecord?.id ?? null}
            />
            <Suspense fallback={<div className="preview-panel loading">Loading preview...</div>}>
              <PreviewPanel
                onOpenSourceTask={(record) => void openRecordSourceTask(record)}
                record={selectedRecord}
              />
            </Suspense>
          </div>
        ) : (
          <div className="settings-screen">
            <Suspense fallback={<div className="preview-panel loading">Loading settings...</div>}>
              <SettingsPanel
                appVersion={APP_VERSION}
                settings={settings}
                updateState={appUpdate}
                onChange={(next) => void updateSettings(next)}
                onCheckForUpdates={() => void runUpdateCheck(true)}
                onInstallUpdate={() => void startUpdateInstall()}
                onResetApp={() => void handleResetApp()}
                onTestNotification={() => void testNotification()}
              />
            </Suspense>
          </div>
        )}
      </main>
      {ticketModal ? (
        <Suspense fallback={null}>
          <TicketDrawerModal
            favorites={settings.favoriteTickets}
            history={settings.visitHistory}
            mode={ticketModal}
            onClearHistory={clearVisitHistory}
            onClose={() => void closeTicketModal()}
            onOpenUrl={(url, title) => void openTicketUrl(url, title)}
            onRemoveFavorite={removeFavoriteUrl}
          />
        </Suspense>
      ) : null}
    </div>
    {isLaunchSplashVisible ? (
      <div className="launch-splash" aria-label="Opening ABW" role="status">
        <div className="launch-splash-stack">
          <div className="launch-splash-mark">
            <img src="/abw.svg" alt="" />
          </div>
          <div className="launch-splash-title-clip">
            <div className="launch-splash-brand-title" aria-label="A Better Wrike">
              <svg className="splash-letter splash-letter-a" viewBox="16 54 348 313" aria-hidden="true">
                <defs>
                  <linearGradient id="splash-bright" x1="16" y1="370" x2="1056" y2="52" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#03bb69" />
                    <stop offset=".52" stopColor="#05cb63" />
                    <stop offset="1" stopColor="#45dc68" />
                  </linearGradient>
                  <linearGradient id="splash-shadow" x1="248" y1="55" x2="985" y2="372" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#00ad72" />
                    <stop offset="1" stopColor="#00a56c" />
                  </linearGradient>
                  <linearGradient id="splash-fold" x1="98" y1="370" x2="690" y2="116" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#18c874" />
                    <stop offset="1" stopColor="#42dd69" />
                  </linearGradient>
                </defs>
                <path fill="url(#splash-bright)" d="M18 365 151 56h62L84 365Z" />
                <path fill="url(#splash-shadow)" d="M151 56h62l149 309h-68L181 134Z" />
                <path fill="url(#splash-fold)" d="M84 365h40l82-91-22-48h-34L62 327l-19 38Z" />
              </svg>
              <span className="splash-word">
                <svg className="splash-letter splash-letter-b" viewBox="351 54 280 313" aria-hidden="true">
                  <path fill="url(#splash-shadow)" d="M353 56h71v159h-71Z" />
                  <path fill="url(#splash-bright)" d="M424 56h89c70 0 112 38 112 97 0 34-16 60-45 82 31 18 49 47 49 83 0 30-12 47-31 47h-170l58-58h59c15 0 25-12 25-26 0-18-14-30-33-30h-58l53-56h16c15 0 24-12 24-26 0-15-10-25-28-25h-100Z" />
                  <path fill="url(#splash-fold)" d="M353 230 401 272 483 192h54L373 365h-20Z" />
                </svg>
                <span className="splash-word-tail">etter</span>
              </span>
              <span className="splash-word">
                <svg className="splash-letter splash-letter-w" viewBox="658 54 508 313" aria-hidden="true">
                  <g transform="translate(0 7) scale(1 .875)">
                    <path fill="url(#splash-shadow)" d="M660 56h67l88 215 60-116 37 79-90 175h-57Z" />
                    <path fill="url(#splash-bright)" d="M875 155h64l55 116 94-215h76L1004 409h-57Z" />
                  </g>
                </svg>
                <span className="splash-word-tail">rike</span>
              </span>
            </div>
          </div>
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
    | "history"
    | "home"
    | "keyboard_arrow_left"
    | "keyboard_arrow_right"
    | "link"
    | "refresh"
    | "settings"
    | "share"
    | "star"
    | "star_outline"
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
    history: (
      <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18Zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8Z" />
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
    star: <path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21Z" />,
    star_outline: (
      <path d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03ZM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28Z" />
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
