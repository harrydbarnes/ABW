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
  getWrikeTabState,
  launchWrike,
  hideWrike,
  isDesktopRuntime,
  loadDownloads,
  loadSettings,
  resizeWrikeTabs,
  saveSettings,
  sendTestNotification,
  subscribeToDownloadErrors,
  subscribeToDownloads,
  subscribeToSettingsUpdates,
  subscribeToWrikeTabUpdates,
  wrikeTabAction,
  type WrikeTabAction,
  type WrikeTabUpdate,
} from "./lib/desktop";
import type { DownloadRecord, FileFilter, Settings } from "./types";

const PreviewPanel = lazy(() => import("./features/preview/PreviewPanel"));
const READ_ONLY_URL = "https://login.wrike.com/login/?forceLogin=false&read";

type Screen = "wrike" | "files" | "settings";
type WrikeTabMode = "standard" | "readOnly";
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
  const [newWrikeTabId, setNewWrikeTabId] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<FileFilter>("all");
  const [settings, setSettings] = useState<Settings>({
    spellCheck: true,
    launchWrikeOnStart: true,
    downloadNotifications: true,
    customDictionary: [],
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [reloadingTabId, setReloadingTabId] = useState<string | null>(null);
  const wrikeTabsRef = useRef(wrikeTabs);
  const reloadAnimationTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const splashTimer = window.setTimeout(() => setIsLaunchSplashVisible(false), 2800);
    return () => window.clearTimeout(splashTimer);
  }, []);

  useEffect(() => {
    return () => window.clearTimeout(reloadAnimationTimerRef.current);
  }, []);

  useEffect(() => {
    wrikeTabsRef.current = wrikeTabs;
  }, [wrikeTabs]);

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
      if (next.launchWrikeOnStart) {
        void showWrike(activeWrikeTabId);
      } else {
        setScreen("files");
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
      setNotice("Dictionary updated.");
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
    const closeMenu = () => setTabMenu(null);
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
      resizeTimer = window.setTimeout(() => void resizeWrikeTabs().catch(() => undefined), 80);
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
    return downloads.filter((record) => {
      const kindMatches = filter === "all" || record.kind === filter;
      const queryMatches =
        query.length === 0 ||
        record.fileName.toLowerCase().includes(query) ||
        record.sourceLabel.toLowerCase().includes(query);
      return kindMatches && queryMatches;
    });
  }, [deferredSearch, downloads, filter]);

  const selectedRecord =
    visibleDownloads.find((record) => record.id === selectedId) ?? visibleDownloads[0] ?? null;

  async function showWrike(tabId = activeWrikeTabId) {
    const tabs = wrikeTabsRef.current;
    const tab = tabs.find((candidate) => candidate.id === tabId);
    setActiveWrikeTabId(tabId);
    await resizeWrikeTabs().catch(() => undefined);
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

  async function showLocalScreen(next: Exclude<Screen, "wrike">) {
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    setScreen(next);
  }

  async function addWrikeTab() {
    const nextTabNumber = wrikeTabs.length + 1;
    const next: WrikeTab = {
      id: `tab-${Date.now().toString(36)}`,
      title: nextTabNumber === 1 ? "Wrike" : `New tab ${nextTabNumber}`,
      url: null,
      canGoBack: false,
      canGoForward: false,
      isTitleLoading: true,
      mode: "standard",
    };
    setWrikeTabs((current) => [...current, next]);
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    await launchWrike(next.id);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    setActiveWrikeTabId(next.id);
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
    setWrikeTabs((current) => [...current, next]);
    setNewWrikeTabId(next.id);
    window.setTimeout(() => setNewWrikeTabId(null), 520);
    await launchWrike(next.id, READ_ONLY_URL);
    await hideWrike(wrikeTabs.map((tab) => tab.id));
    setActiveWrikeTabId(next.id);
    setScreen("wrike");
  }

  async function runWrikeTabAction(tabId: string, action: WrikeTabAction) {
    setTabMenu(null);
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
    setTabMenu(null);
    setWrikeTabs(remaining);
    await closeWrikeTab(tabId);
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

  function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>, tabId: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void showWrike(tabId);
    }
  }

  function handleTabDragStart(event: DragEvent<HTMLDivElement>, tabId: string) {
    setDraggedTabId(tabId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
  }

  function handleTabDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain") || draggedTabId;
    if (sourceId) {
      reorderTabs(sourceId, targetId);
    }
    setDraggedTabId(null);
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

  async function toggleSpellCheck() {
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

  return (
    <>
    <div className="app-shell" spellCheck={settings.spellCheck}>
      <header className="taskbar" data-tauri-drag-region>
        <div className="brand" aria-label="ABW" data-tauri-drag-region>
          <img className="brand-wordmark" src="/abw-wordmark.svg" alt="ABW" data-tauri-drag-region />
        </div>
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
                  newWrikeTabId === tab.id ? "entering" : "",
                  draggedTabId === tab.id ? "dragging" : "",
                ].join(" ")}
                draggable
                key={tab.id}
                onClick={() => void showWrike(tab.id)}
                onContextMenu={(event) => void showTabContextMenu(event, tab)}
                onDragEnd={() => setDraggedTabId(null)}
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
                <MaterialIcon kind={tab.mode === "readOnly" ? "description" : index === 0 ? "home" : "tab"} />
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
      <main className="content">
        {screen === "wrike" ? (
          <section className="wrike-surface" aria-label="Wrike workspace">
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
    | "link"
    | "refresh"
    | "settings"
    | "share"
    | "tab"
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
