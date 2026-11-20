import { memo, useState, type ReactNode } from "react";
import {
  APP_THEMES,
  type AppThemeId,
  type AppUpdateState,
  type DownloadsStorageStats,
  type Settings,
} from "../../types";

interface Props {
  appVersion: string;
  clearingDownloads: boolean;
  downloadsStats: DownloadsStorageStats | null;
  settings: Settings;
  updateState: AppUpdateState;
  onChange: (next: Settings) => void;
  onCheckForUpdates: () => void;
  onClearUnpinnedDownloads: () => void;
  onInstallUpdate: () => void;
  onResetApp: () => void;
  onTestNotification: () => void;
}

function matchesSearch(query: string, ...fields: Array<string | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return fields.some((field) => (field ?? "").toLowerCase().includes(normalized));
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const normalized = query.trim();
  if (!normalized) {
    return <>{text}</>;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === normalized.toLowerCase() ? (
          <mark className="setting-highlight" key={index}>
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function AnimatedSettingItem({
  visible,
  children,
  className = "",
}: {
  visible: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden={!visible}
      className={`setting-filter-item ${visible ? "is-visible" : "is-hidden"} ${className}`.trim()}
    >
      <div className="setting-filter-inner">{children}</div>
    </div>
  );
}

export const SettingsPanel = memo(function SettingsPanel({
  appVersion,
  clearingDownloads,
  downloadsStats,
  settings,
  updateState,
  onChange,
  onCheckForUpdates,
  onClearUnpinnedDownloads,
  onInstallUpdate,
  onResetApp,
  onTestNotification,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const query = searchQuery.trim();

  const showUpdatesHeader = matchesSearch(query, "App updates", "version", "GitHub Releases", "install");
  const showAutoUpdateToggle = matchesSearch(
    query,
    "Check for updates automatically",
    "Check GitHub Releases quietly when ABW opens and periodically in the background.",
  );
  const showUpdatesSection = showUpdatesHeader || showAutoUpdateToggle;

  const showLaunchWrike = matchesSearch(
    query,
    "Show Wrike workspace on launch",
    "Open your startup tabs whenever ABW starts. You can still reopen the previous session from the launch toast.",
  );
  const showSystemStartup = matchesSearch(
    query,
    "Open ABW app at system startup",
    "Start ABW automatically when you sign in to Windows.",
  );
  const showCloseToTray = matchesSearch(
    query,
    "Close app to notification area (higher memory usage)",
    "Keep ABW running in the notification area when its window is closed so it can reopen quickly. This uses more memory.",
  );
  const showConfirmClose = matchesSearch(
    query,
    "Confirm before closing with multiple tabs open",
    "Ask before quitting when more than one Wrike tab is open. Closing to the notification area keeps your tabs running.",
  );
  const showExternalLinks = matchesSearch(
    query,
    "Open external links in default browser",
    "Open non-Wrike links in your default Windows browser instead of opening them inside ABW.",
  );
  const showSuspendInactiveTabs = matchesSearch(
    query,
    "Suspend inactive background tabs",
    "Close hidden Wrike tabs after inactivity to reclaim WebView2 memory. Clicking a suspended tab reloads it where you left off.",
  );
  const showStartupTabs = matchesSearch(
    query,
    "Startup and new tabs",
    "The first URL is the new tab default. All URLs open together on launch.",
    ...settings.startupTabUrls,
  );
  const showAbwPrefsHeader = matchesSearch(
    query,
    "ABW preferences",
    "Control how ABW launches, behaves in the background, and opens tabs.",
  );
  const showAbwPrefsSection =
    showAbwPrefsHeader ||
    showLaunchWrike ||
    showSystemStartup ||
    showCloseToTray ||
    showConfirmClose ||
    showExternalLinks ||
    showSuspendInactiveTabs ||
    showStartupTabs;

  const showDownloadNotifications = matchesSearch(
    query,
    "Download complete notifications",
    "Show a Windows notification when a file from Wrike has been saved into ABW Files.",
  );
  const showOpenDownloaded = matchesSearch(
    query,
    "Open downloaded files automatically",
    "Automatically open each downloaded file in its default Windows application as soon as it is saved into ABW Files.",
  );
  const showWrikeNotifications = matchesSearch(
    query,
    "Wrike notifications",
    "Comments, mentions and assignments use Wrike notifications in the live workspace tab. Keep it open and enable notifications when Wrike prompts you.",
    "Send test notification",
  );
  const showDownloadsCleanup = matchesSearch(
    query,
    "Downloads storage",
    "Clean up unpinned downloads",
    "Pinned files are kept during cleanup.",
  );
  const showFileManagementHeader = matchesSearch(
    query,
    "File management",
    "ABW stores intercepted downloads in its per-user application data directory. Files can always be opened in Windows from the preview pane.",
  );
  const showFileManagementSection =
    showFileManagementHeader ||
    showDownloadNotifications ||
    showOpenDownloaded ||
    showWrikeNotifications ||
    showDownloadsCleanup;

  const showThemeSection = matchesSearch(
    query,
    "Theme",
    "Match ABW's title bar to a Wrike-inspired workspace colour.",
    "Automatically match Wrike theme",
    "Automatically match the top window bar to the theme selected in your Wrike workspace sidebar. Choosing a theme below switches to manual selection.",
    ...APP_THEMES.map((theme) => theme.label),
  );

  const showSpellCheckToggle = matchesSearch(
    query,
    "Spell check",
    "Mark misspellings in Wrike editors and ABW search fields using WebView2 spell checking.",
  );
  const showSpellCheckTopbar = matchesSearch(
    query,
    "Show in topbar",
    "Show a quick spell check toggle button in the top window bar.",
  );
  const showDictionary = matchesSearch(
    query,
    "Custom dictionary",
    "Add campaign names, client names and abbreviations that ABW should accept.",
    ...settings.customDictionary,
  );
  const showSpellHeader = matchesSearch(
    query,
    "Spell check",
    "Manage spell checking in Wrike editors and your custom dictionary.",
  );
  const showSpellSection =
    showSpellHeader || showSpellCheckToggle || showSpellCheckTopbar || showDictionary;

  const hasAnyMatches =
    showUpdatesSection ||
    showAbwPrefsSection ||
    showFileManagementSection ||
    showThemeSection ||
    showSpellSection;

  return (
    <section className="settings-panel">
      <header className="settings-header-row">
        <div>
          <h1>Settings</h1>
          <p>Preferences apply to ABW and the live Wrike workspace tab.</p>
        </div>
        <div className="settings-search-box">
          <input
            aria-label="Search settings"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search settings..."
            type="search"
            value={searchQuery}
          />
          {searchQuery ? (
            <button
              aria-label="Clear settings search"
              className="settings-search-clear"
              onClick={() => setSearchQuery("")}
              type="button"
            >
              ×
            </button>
          ) : null}
        </div>
      </header>

      {!hasAnyMatches ? (
        <div className="settings-no-results">
          <strong>No matching settings</strong>
          <p>Try searching for updates, theme, notifications, spell check, or tabs.</p>
        </div>
      ) : null}

      <AnimatedSettingItem className="setting-section-item" visible={showUpdatesSection}>
        <AppUpdateSettings
          appVersion={appVersion}
          autoCheckForUpdates={settings.autoCheckForUpdates}
          onAutoCheckChange={(autoCheckForUpdates) => onChange({ ...settings, autoCheckForUpdates })}
          onCheckForUpdates={onCheckForUpdates}
          onInstallUpdate={onInstallUpdate}
          query={query}
          showAutoUpdateToggle={showAutoUpdateToggle || showUpdatesHeader}
          updateState={updateState}
        />
      </AnimatedSettingItem>

      <AnimatedSettingItem className="setting-section-item" visible={showAbwPrefsSection}>
        <div className="setting-group">
          <div className="setting-group-header">
            <h2><HighlightText query={query} text="ABW preferences" /></h2>
            <p><HighlightText query={query} text="Control how ABW launches, behaves in the background, and opens tabs." /></p>
          </div>
          <AnimatedSettingItem visible={showLaunchWrike || showAbwPrefsHeader}>
            <SettingToggle
              checked={settings.launchWrikeOnStart}
              description="Open your startup tabs whenever ABW starts. You can still reopen the previous session from the launch toast."
              label="Show Wrike workspace on launch"
              onChange={(launchWrikeOnStart) => onChange({ ...settings, launchWrikeOnStart })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showSystemStartup || showAbwPrefsHeader}>
            <SettingToggle
              checked={settings.openAbwAtSystemStartup}
              description="Start ABW automatically when you sign in to Windows."
              label="Open ABW app at system startup"
              onChange={(openAbwAtSystemStartup) => onChange({ ...settings, openAbwAtSystemStartup })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showCloseToTray || showAbwPrefsHeader}>
            <SettingToggle
              checked={settings.closeToNotificationArea}
              description="Keep ABW running in the notification area when its window is closed so it can reopen quickly. This uses more memory."
              label="Close app to notification area (higher memory usage)"
              onChange={(closeToNotificationArea) => onChange({ ...settings, closeToNotificationArea })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showConfirmClose || showAbwPrefsHeader}>
            <SettingToggle
              checked={settings.confirmBeforeClosingTabs}
              description="Ask before quitting when more than one Wrike tab is open. Closing to the notification area keeps your tabs running."
              label="Confirm before closing with multiple tabs open"
              onChange={(confirmBeforeClosingTabs) => onChange({ ...settings, confirmBeforeClosingTabs })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showExternalLinks || showAbwPrefsHeader}>
            <SettingToggle
              checked={settings.openExternalLinksInBrowser}
              description="Open non-Wrike links in your default Windows browser instead of opening them inside ABW."
              label="Open external links in default browser"
              onChange={(openExternalLinksInBrowser) =>
                onChange({ ...settings, openExternalLinksInBrowser })
              }
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showSuspendInactiveTabs || showAbwPrefsHeader}>
            <label className="setting">
              <span>
                <strong>
                  <HighlightText query={query} text="Suspend inactive background tabs" />
                </strong>
                <small>
                  <HighlightText
                    query={query}
                    text="Close hidden Wrike tabs after inactivity to reclaim WebView2 memory. Clicking a suspended tab reloads it where you left off."
                  />
                </small>
              </span>
              <select
                aria-label="Suspend inactive background tabs"
                className="setting-select"
                onChange={(event) =>
                  onChange({
                    ...settings,
                    suspendInactiveTabsMinutes: Number(event.target.value),
                  })
                }
                value={settings.suspendInactiveTabsMinutes}
              >
                <option value={0}>Off</option>
                <option value={5}>5 minutes</option>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>60 minutes</option>
              </select>
            </label>
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showStartupTabs || showAbwPrefsHeader}>
            <StartupTabsSettings
              onChange={(startupTabUrls) => onChange({ ...settings, startupTabUrls })}
              query={query}
              urls={settings.startupTabUrls}
            />
          </AnimatedSettingItem>
        </div>
      </AnimatedSettingItem>

      <AnimatedSettingItem className="setting-section-item" visible={showFileManagementSection}>
        <div className="setting-group">
          <div className="setting-group-header">
            <h2><HighlightText query={query} text="File management" /></h2>
            <p>
              <HighlightText
                query={query}
                text="ABW stores intercepted downloads in its per-user application data directory. Files can always be opened in Windows from the preview pane."
              />
            </p>
          </div>
          <AnimatedSettingItem visible={showDownloadNotifications || showFileManagementHeader}>
            <SettingToggle
              checked={settings.downloadNotifications}
              description="Show a Windows notification when a file from Wrike has been saved into ABW Files."
              label="Download complete notifications"
              onChange={(downloadNotifications) => onChange({ ...settings, downloadNotifications })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showOpenDownloaded || showFileManagementHeader}>
            <SettingToggle
              checked={settings.openDownloadedFilesAutomatically}
              description="Automatically open each downloaded file in its default Windows application as soon as it is saved into ABW Files."
              label="Open downloaded files automatically"
              onChange={(openDownloadedFilesAutomatically) =>
                onChange({ ...settings, openDownloadedFilesAutomatically })
              }
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showWrikeNotifications || showFileManagementHeader}>
            <div className="notification-note">
              <div>
                <h3><HighlightText query={query} text="Wrike notifications" /></h3>
                <p>
                  <HighlightText
                    query={query}
                    text="Comments, mentions and assignments use Wrike notifications in the live workspace tab. Keep it open and enable notifications when Wrike prompts you."
                  />
                </p>
              </div>
              <button className="secondary-action" onClick={onTestNotification}>
                <HighlightText query={query} text="Send test notification" />
              </button>
            </div>
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showDownloadsCleanup || showFileManagementHeader}>
            <div className="notification-note">
              <div>
                <h3><HighlightText query={query} text="Downloads storage" /></h3>
                <p>
                  {downloadsStats
                    ? `${downloadsStats.totalFiles} downloaded ${downloadsStats.totalFiles === 1 ? "file" : "files"} (${formatBytes(downloadsStats.totalBytes)}) · ${downloadsStats.pinnedFiles} pinned · ${formatBytes(downloadsStats.unpinnedBytes)} unpinned.`
                    : "ABW stores intercepted downloads in its per-user application data directory. Pinned files are kept during cleanup."}
                </p>
              </div>
              <button
                className="secondary-action"
                disabled={
                  clearingDownloads ||
                  !downloadsStats ||
                  downloadsStats.totalFiles <= downloadsStats.pinnedFiles
                }
                onClick={onClearUnpinnedDownloads}
              >
                <HighlightText
                  query={query}
                  text={clearingDownloads ? "Cleaning up..." : "Clean up unpinned downloads"}
                />
              </button>
            </div>
          </AnimatedSettingItem>
        </div>
      </AnimatedSettingItem>

      <AnimatedSettingItem className="setting-section-item" visible={showThemeSection}>
        <ThemeSettings
          autoMatch={settings.autoMatchWrikeTheme}
          onAutoMatchChange={(autoMatchWrikeTheme) =>
            onChange({ ...settings, autoMatchWrikeTheme })
          }
          onChange={(theme) =>
            onChange({ ...settings, theme, autoMatchWrikeTheme: false })
          }
          query={query}
          selected={settings.theme}
        />
      </AnimatedSettingItem>

      <AnimatedSettingItem className="setting-section-item" visible={showSpellSection}>
        <div className="setting-group">
          <div className="setting-group-header">
            <h2><HighlightText query={query} text="Spell check" /></h2>
            <p><HighlightText query={query} text="Manage spell checking in Wrike editors and your custom dictionary." /></p>
          </div>
          <AnimatedSettingItem visible={showSpellCheckToggle || showSpellHeader}>
            <SettingToggle
              checked={settings.spellCheck}
              description="Mark misspellings in Wrike editors and ABW search fields using WebView2 spell checking."
              label="Spell check"
              onChange={(spellCheck) => onChange({ ...settings, spellCheck })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showSpellCheckTopbar || showSpellHeader}>
            <SettingToggle
              checked={settings.showSpellCheckInTopbar}
              description="Show a quick spell check toggle button in the top window bar."
              label="Show in topbar"
              onChange={(showSpellCheckInTopbar) => onChange({ ...settings, showSpellCheckInTopbar })}
              query={query}
            />
          </AnimatedSettingItem>
          <AnimatedSettingItem visible={showDictionary || showSpellHeader}>
            <DictionarySettings
              onChange={(customDictionary) => onChange({ ...settings, customDictionary })}
              query={query}
              words={settings.customDictionary}
            />
          </AnimatedSettingItem>
        </div>
      </AnimatedSettingItem>

      <footer className="settings-footer">
        <span className="settings-footer-meta">
          ABW v{appVersion} · Questions or support: Harry Barnes
        </span>
        <button
          className="settings-reset-btn"
          onClick={() => setConfirmResetOpen(true)}
          title="Reset ABW to default settings"
          type="button"
        >
          Reset
        </button>
      </footer>
      {confirmResetOpen ? (
        <div
          className="reset-confirm-backdrop"
          onClick={() => setConfirmResetOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Confirm app reset"
        >
          <div className="reset-confirm-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Reset ABW?</h2>
            <p>
              This will restore all settings to their defaults and clear your custom dictionary,
              startup tabs, favourites, and ticket history. Your downloaded files will not be
              deleted.
            </p>
            <div className="reset-confirm-actions">
              <button
                className="secondary-action"
                onClick={() => setConfirmResetOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="reset-confirm-danger"
                onClick={() => {
                  setConfirmResetOpen(false);
                  onResetApp();
                }}
                type="button"
              >
                Reset app
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdateDate(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatReleaseNotes(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  const bullets: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let text = line.trim();
    if (!text) continue;
    if (/^#{1,6}\s+what'?s changed/i.test(text)) continue;
    if (/^\*\*full changelog\*\*/i.test(text) || /^full changelog:/i.test(text)) continue;
    if (/^---+$/.test(text)) continue;
    text = text.replace(/^[-*•]\s+/, "");
    text = text.replace(/\s+by\s+@[\w-]+\s+in\s+https?:\/\/\S+$/i, "");
    text = text.replace(/\s*\(#\d+\)\s*$/, "");
    text = text.replace(/^(?:feat|fix|style|chore|ci|perf|refactor|docs)(?:\([^)]+\))?:\s*/i, "");
    text = text.replace(/;\s*bump to v[\d.]+$/i, "");
    text = text.replace(/,?\s*and bump to v[\d.]+$/i, "");
    text = text.trim();
    if (!text) continue;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (!/[.!?]$/.test(text)) {
      text += ".";
    }
    if (!bullets.includes(text)) {
      bullets.push(text);
    }
  }
  return bullets;
}

function AppUpdateSettings({
  appVersion,
  autoCheckForUpdates,
  query,
  showAutoUpdateToggle,
  updateState,
  onAutoCheckChange,
  onCheckForUpdates,
  onInstallUpdate,
}: {
  appVersion: string;
  autoCheckForUpdates: boolean;
  query: string;
  showAutoUpdateToggle: boolean;
  updateState: AppUpdateState;
  onAutoCheckChange: (checked: boolean) => void;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
}) {
  const { phase, latestVersion, notes, pubDate, checkedAt, downloadedBytes, totalBytes, error } =
    updateState;
  const isBusy = phase === "checking" || phase === "downloading" || phase === "installing";
  const progressPercent =
    totalBytes && totalBytes > 0
      ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
      : null;
  const releaseDate = formatUpdateDate(pubDate);
  const checkedTime = checkedAt
    ? new Date(checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  const releaseBullets = formatReleaseNotes(notes);

  let summary = `Running ABW v${appVersion}.`;
  if (phase === "checking") {
    summary = `Checking GitHub Releases for a newer version than v${appVersion}...`;
  } else if (phase === "available" && latestVersion) {
    summary = `ABW v${latestVersion} is ready to install${releaseDate ? ` (released ${releaseDate})` : ""}.`;
  } else if (phase === "downloading") {
    summary =
      progressPercent !== null && totalBytes
        ? `Downloading ABW v${latestVersion ?? ""}: ${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)} (${progressPercent}%).`
        : `Downloading ABW v${latestVersion ?? ""} (${formatBytes(downloadedBytes)})...`;
  } else if (phase === "installing") {
    summary = `Verifying signature and installing ABW v${latestVersion ?? ""}. ABW will restart automatically.`;
  } else if (phase === "up-to-date") {
    summary = `You're up to date on ABW v${appVersion}${checkedTime ? ` · Last checked at ${checkedTime}` : ""}.`;
  } else if (phase === "no-release") {
    summary = `Running ABW v${appVersion}. No published release was found on GitHub Releases yet.`;
  } else if (phase === "error") {
    summary = error || "Unable to check for updates right now.";
  }

  return (
    <div className="setting-group">
      <div className="setting-group-header update-panel-header">
        <div>
          <h2><HighlightText query={query} text="App updates" /></h2>
          <p className={phase === "error" ? "update-error" : undefined}>
            <HighlightText query={query} text={summary} />
          </p>
        </div>
        <div className="update-actions">
          {(phase === "available" || (phase === "error" && latestVersion)) && latestVersion ? (
            <button
              className="primary-action"
              disabled={isBusy}
              onClick={onInstallUpdate}
            >
              Install v{latestVersion}
            </button>
          ) : null}
          <button className="secondary-action" disabled={isBusy} onClick={onCheckForUpdates}>
            {phase === "checking" ? "Checking..." : "Check for updates"}
          </button>
        </div>
      </div>
      {phase === "downloading" || phase === "installing" ? (
        <div className="update-progress-wrap">
          <div
            aria-label="Update download progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={phase === "installing" ? 100 : progressPercent ?? undefined}
            className="update-progress"
            role="progressbar"
          >
            <div
              className={`update-progress-fill ${progressPercent === null && phase === "downloading" ? "indeterminate" : ""}`}
              style={{ width: `${phase === "installing" ? 100 : progressPercent ?? 35}%` }}
            />
          </div>
        </div>
      ) : null}
      {releaseBullets.length > 0 &&
      (phase === "available" || phase === "downloading" || phase === "installing") ? (
        <div className="update-notes-card">
          <strong>What's new</strong>
          <ul className="update-notes-list">
            {releaseBullets.map((bullet, index) => (
              <li key={index}>{bullet}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <AnimatedSettingItem visible={showAutoUpdateToggle}>
        <SettingToggle
          checked={autoCheckForUpdates}
          description="Check GitHub Releases quietly when ABW opens and periodically in the background."
          label="Check for updates automatically"
          onChange={onAutoCheckChange}
          query={query}
        />
      </AnimatedSettingItem>
    </div>
  );
}

function StartupTabsSettings({
  urls,
  query,
  onChange,
}: {
  urls: string[];
  query: string;
  onChange: (urls: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const normalizedUrls = normalizeUrls(urls);

  function addUrl() {
    const next = normalizeUrl(draft);
    if (!next) {
      return;
    }
    onChange(normalizeUrls([...normalizedUrls, next]));
    setDraft("");
  }

  function commitUrl(index: number, value: string) {
    const next = normalizeUrl(value);
    if (!next) {
      onChange(normalizeUrls(normalizedUrls.filter((_, candidateIndex) => candidateIndex !== index)));
      return;
    }
    const updated = [...normalizedUrls];
    updated[index] = next;
    onChange(normalizeUrls(updated));
  }

  return (
    <div className="startup-tabs-panel">
      <div>
        <h2><HighlightText query={query} text="Startup and new tabs" /></h2>
        <p><HighlightText query={query} text="The first URL is the new tab default. All URLs open together on launch." /></p>
      </div>
      <div className="startup-url-list">
        {normalizedUrls.map((url, index) => (
          <div className="startup-url-row" key={`${url}-${index}`}>
            <span className="startup-url-badge">{index === 0 ? "New tab" : `Tab ${index + 1}`}</span>
            <input
              aria-label={index === 0 ? "New tab default URL" : `Startup tab ${index + 1} URL`}
              defaultValue={url}
              onBlur={(event) => commitUrl(index, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitUrl(index, event.currentTarget.value);
                }
              }}
            />
            <button
              disabled={normalizedUrls.length <= 1}
              onClick={() => onChange(normalizeUrls(normalizedUrls.filter((_, candidateIndex) => candidateIndex !== index)))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="startup-url-add">
        <input
          aria-label="Add startup tab URL"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              addUrl();
            }
          }}
          placeholder="Paste a URL"
          value={draft}
        />
        <button className="secondary-action" onClick={addUrl}>
          Add tab
        </button>
      </div>
    </div>
  );
}

function normalizeUrls(urls: string[]) {
  const normalized = urls
    .map(normalizeUrl)
    .filter((url): url is string => Boolean(url));
  return normalized.length ? [...new Set(normalized)] : ["https://www.wrike.com/workspace.htm"];
}

function normalizeUrl(value: string) {
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

function ThemeSettings({
  autoMatch,
  query,
  selected,
  onAutoMatchChange,
  onChange,
}: {
  autoMatch: boolean;
  query: string;
  selected: AppThemeId;
  onAutoMatchChange: (autoMatch: boolean) => void;
  onChange: (theme: AppThemeId) => void;
}) {
  return (
    <div className="theme-panel">
      <div>
        <h2><HighlightText query={query} text="Theme" /></h2>
        <p><HighlightText query={query} text="Match ABW's title bar to a Wrike-inspired workspace colour." /></p>
      </div>
      <div className="theme-auto-toggle">
        <SettingToggle
          checked={autoMatch}
          description="Automatically match the top window bar to the theme selected in your Wrike workspace sidebar. Choosing a theme below switches to manual selection."
          label="Automatically match Wrike theme"
          onChange={onAutoMatchChange}
          query={query}
        />
      </div>
      <div className="theme-grid" role="radiogroup" aria-label="ABW theme">
        {APP_THEMES.map((theme) => (
          <button
            aria-checked={selected === theme.id}
            className={`theme-choice ${selected === theme.id ? "selected" : ""}`}
            data-theme-preview={theme.id}
            key={theme.id}
            onClick={() => onChange(theme.id)}
            role="radio"
          >
            <span className="theme-swatch" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span><HighlightText query={query} text={theme.label} /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DictionarySettings({
  words,
  query,
  onChange,
}: {
  words: string[];
  query: string;
  onChange: (words: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  function normalize(nextWords: string[]) {
    return [...new Set(nextWords.map((word) => word.trim()).filter(Boolean))].sort((first, second) =>
      first.localeCompare(second, undefined, { sensitivity: "base" }),
    );
  }

  function addWord() {
    const word = draft.trim();
    if (!word) {
      return;
    }
    onChange(normalize([...words, word]));
    setDraft("");
  }

  function startEdit(word: string) {
    setEditing(word);
    setEditDraft(word);
  }

  function saveEdit(original: string) {
    const next = editDraft.trim();
    onChange(normalize(words.map((word) => (word === original ? next : word))));
    setEditing(null);
    setEditDraft("");
  }

  return (
    <div className="dictionary-panel">
      <div>
        <h2><HighlightText query={query} text="Custom dictionary" /></h2>
        <p><HighlightText query={query} text="Add campaign names, client names and abbreviations that ABW should accept." /></p>
      </div>
      <div className="dictionary-add">
        <input
          aria-label="Dictionary word"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              addWord();
            }
          }}
          placeholder="Add a word"
          value={draft}
        />
        <button className="secondary-action" onClick={addWord}>
          Add word
        </button>
      </div>
      {words.length ? (
        <div className="dictionary-list">
          {words.map((word) => (
            <div className="dictionary-row" key={word}>
              {editing === word ? (
                <input
                  aria-label={`Edit ${word}`}
                  autoFocus
                  onChange={(event) => setEditDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      saveEdit(word);
                    } else if (event.key === "Escape") {
                      setEditing(null);
                    }
                  }}
                  value={editDraft}
                />
              ) : (
                <strong><HighlightText query={query} text={word} /></strong>
              )}
              <span>
                {editing === word ? (
                  <button onClick={() => saveEdit(word)}>Save</button>
                ) : (
                  <button onClick={() => startEdit(word)}>Edit</button>
                )}
                <button onClick={() => onChange(words.filter((entry) => entry !== word))}>
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="dictionary-empty">No custom words yet.</p>
      )}
    </div>
  );
}

function SettingToggle({
  checked,
  description,
  label,
  query = "",
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  query?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting">
      <span>
        <strong><HighlightText query={query} text={label} /></strong>
        <small><HighlightText query={query} text={description} /></small>
      </span>
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="toggle" aria-hidden="true" />
    </label>
  );
}
