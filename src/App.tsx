import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { FilesLibrary } from "./features/files/FilesLibrary";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import {
  launchWrike,
  hideWrike,
  isDesktopRuntime,
  loadDownloads,
  loadSettings,
  saveSettings,
  sendTestNotification,
  subscribeToDownloadErrors,
  subscribeToDownloads,
} from "./lib/desktop";
import type { DownloadRecord, FileFilter, Settings } from "./types";

const PreviewPanel = lazy(() => import("./features/preview/PreviewPanel"));

type Screen = "wrike" | "files" | "settings";

export function App() {
  const [screen, setScreen] = useState<Screen>("wrike");
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [filter, setFilter] = useState<FileFilter>("all");
  const [settings, setSettings] = useState<Settings>({
    spellCheck: true,
    launchWrikeOnStart: true,
    downloadNotifications: true,
  });
  const [notice, setNotice] = useState<string | null>(null);

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
        void showWrike();
      } else {
        setScreen("files");
      }
    });
    let dispose: () => void = () => undefined;
    let disposeErrors: () => void = () => undefined;
    void subscribeToDownloads(refresh).then((unsubscribe) => {
      dispose = unsubscribe;
    });
    void subscribeToDownloadErrors((message) => {
      setNotice(`Download was not added to Files: ${message}`);
    }).then((unsubscribe) => {
      disposeErrors = unsubscribe;
    });
    return () => {
      dispose();
      disposeErrors();
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

  async function showWrike() {
    await launchWrike();
    setScreen("wrike");
  }

  async function showLocalScreen(next: Exclude<Screen, "wrike">) {
    await hideWrike();
    setScreen(next);
  }

  async function updateSettings(next: Settings) {
    const persisted = await saveSettings(next);
    setSettings(persisted);
    setNotice("Preferences saved.");
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
    <div className="app-shell" spellCheck={settings.spellCheck}>
      <header className="taskbar">
        <div className="brand" aria-label="ABW">
          <img className="brand-wordmark" src="/abw-wordmark.svg" alt="ABW" />
        </div>
        <div className="workspace-tabs" role="tablist" aria-label="Wrike tabs">
          <button
            aria-selected={screen === "wrike"}
            className={`workspace-tab ${screen === "wrike" ? "selected" : ""}`}
            onClick={() => void showWrike()}
            role="tab"
          >
            <NavIcon kind="home" />
            Wrike
            <span className="external-dot" />
          </button>
          <button
            aria-label="New Wrike tab"
            className="new-tab"
            onClick={() => setNotice("Additional Wrike tabs are not available yet.")}
            title="Additional Wrike tabs are not available yet"
          >
            <NavIcon kind="plus" />
          </button>
          <span className="tab-space" aria-hidden="true" />
        </div>
        <div className={`spell-state ${settings.spellCheck ? "enabled" : ""}`}>
          <NavIcon kind="spell" />
          Spell check {settings.spellCheck ? "on" : "off"}
        </div>
        <nav className="task-navigation" aria-label="ABW navigation">
          <button
            className={`nav-item ${screen === "files" ? "selected" : ""}`}
            onClick={() => void showLocalScreen("files")}
          >
            <NavIcon kind="file" />
            Files
          </button>
          <button
            className={`nav-item ${screen === "settings" ? "selected" : ""}`}
            onClick={() => void showLocalScreen("settings")}
          >
            <NavIcon kind="gear" />
            Settings
          </button>
        </nav>
      </header>
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
          <SettingsPanel
            settings={settings}
            onChange={(next) => void updateSettings(next)}
            onTestNotification={() => void testNotification()}
          />
        )}
        {notice ? (
          <div className="toast" role="status">
            {notice}
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>
              <NavIcon kind="close" />
            </button>
          </div>
        ) : null}
      </main>
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
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      {paths[kind]}
    </svg>
  );
}
