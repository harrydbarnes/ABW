import { useState } from "react";
import { APP_THEMES, type AppThemeId, type AppUpdateState, type Settings } from "../../types";

interface Props {
  appVersion: string;
  settings: Settings;
  updateState: AppUpdateState;
  onChange: (next: Settings) => void;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onTestNotification: () => void;
}

export function SettingsPanel({
  appVersion,
  settings,
  updateState,
  onChange,
  onCheckForUpdates,
  onInstallUpdate,
  onTestNotification,
}: Props) {
  return (
    <section className="settings-panel">
      <header>
        <h1>Settings</h1>
        <p>Preferences apply to ABW and the live Wrike workspace tab.</p>
      </header>
      <AppUpdateSettings
        appVersion={appVersion}
        autoCheckForUpdates={settings.autoCheckForUpdates}
        onAutoCheckChange={(autoCheckForUpdates) => onChange({ ...settings, autoCheckForUpdates })}
        onCheckForUpdates={onCheckForUpdates}
        onInstallUpdate={onInstallUpdate}
        updateState={updateState}
      />
      <div className="setting-group">
        <div className="setting-group-header">
          <h2>ABW preferences</h2>
          <p>Control how ABW launches, behaves in the background, and opens tabs.</p>
        </div>
        <SettingToggle
          checked={settings.launchWrikeOnStart}
          description="Open your startup tabs whenever ABW starts. You can still reopen the previous session from the launch toast."
          label="Show Wrike workspace on launch"
          onChange={(launchWrikeOnStart) => onChange({ ...settings, launchWrikeOnStart })}
        />
        <SettingToggle
          checked={settings.openAbwAtSystemStartup}
          description="Start ABW automatically when you sign in to Windows."
          label="Open ABW app at system startup"
          onChange={(openAbwAtSystemStartup) => onChange({ ...settings, openAbwAtSystemStartup })}
        />
        <SettingToggle
          checked={settings.closeToNotificationArea}
          description="Keep ABW running in the notification area when its window is closed so it can reopen quickly. This uses more memory."
          label="Close app to notification area (higher memory usage)"
          onChange={(closeToNotificationArea) => onChange({ ...settings, closeToNotificationArea })}
        />
        <SettingToggle
          checked={settings.confirmBeforeClosingTabs}
          description="Ask before quitting when more than one Wrike tab is open. Closing to the notification area keeps your tabs running."
          label="Confirm before closing with multiple tabs open"
          onChange={(confirmBeforeClosingTabs) => onChange({ ...settings, confirmBeforeClosingTabs })}
        />
        <StartupTabsSettings
          urls={settings.startupTabUrls}
          onChange={(startupTabUrls) => onChange({ ...settings, startupTabUrls })}
        />
      </div>
      <div className="setting-group">
        <div className="setting-group-header">
          <h2>File management</h2>
          <p>
            ABW stores intercepted downloads in its per-user application data directory. Files can
            always be opened in Windows from the preview pane.
          </p>
        </div>
        <SettingToggle
          checked={settings.downloadNotifications}
          description="Show a Windows notification when a file from Wrike has been saved into ABW Files."
          label="Download complete notifications"
          onChange={(downloadNotifications) => onChange({ ...settings, downloadNotifications })}
        />
        <SettingToggle
          checked={settings.openDownloadedFilesAutomatically}
          description="Automatically open each downloaded file in its default Windows application as soon as it is saved into ABW Files."
          label="Open downloaded files automatically"
          onChange={(openDownloadedFilesAutomatically) =>
            onChange({ ...settings, openDownloadedFilesAutomatically })
          }
        />
        <div className="notification-note">
          <div>
            <h3>Wrike notifications</h3>
            <p>
              Comments, mentions and assignments use Wrike notifications in the live workspace tab.
              Keep it open and enable notifications when Wrike prompts you.
            </p>
          </div>
          <button className="secondary-action" onClick={onTestNotification}>
            Send test notification
          </button>
        </div>
      </div>
      <ThemeSettings
        autoMatch={settings.autoMatchWrikeTheme}
        selected={settings.theme}
        onAutoMatchChange={(autoMatchWrikeTheme) =>
          onChange({ ...settings, autoMatchWrikeTheme })
        }
        onChange={(theme) =>
          onChange({ ...settings, theme, autoMatchWrikeTheme: false })
        }
      />
      <div className="setting-group">
        <div className="setting-group-header">
          <h2>Spell check</h2>
          <p>Manage spell checking in Wrike editors and your custom dictionary.</p>
        </div>
        <SettingToggle
          checked={settings.spellCheck}
          description="Mark misspellings in Wrike editors and ABW search fields using WebView2 spell checking."
          label="Spell check"
          onChange={(spellCheck) => onChange({ ...settings, spellCheck })}
        />
        <SettingToggle
          checked={settings.showSpellCheckInTopbar}
          description="Show a quick spell check toggle button in the top window bar."
          label="Show in topbar"
          onChange={(showSpellCheckInTopbar) => onChange({ ...settings, showSpellCheckInTopbar })}
        />
        <DictionarySettings
          words={settings.customDictionary}
          onChange={(customDictionary) => onChange({ ...settings, customDictionary })}
        />
      </div>
      <footer className="settings-footer">
        ABW v{appVersion} · Questions or support: Harry Barnes
      </footer>
    </section>
  );
}

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

function AppUpdateSettings({
  appVersion,
  autoCheckForUpdates,
  updateState,
  onAutoCheckChange,
  onCheckForUpdates,
  onInstallUpdate,
}: {
  appVersion: string;
  autoCheckForUpdates: boolean;
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
    <div className="update-panel">
      <div className="update-panel-header">
        <div>
          <h2>App updates</h2>
          <p className={phase === "error" ? "update-error" : undefined}>{summary}</p>
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
      ) : null}
      {notes && (phase === "available" || phase === "downloading" || phase === "installing") ? (
        <pre className="update-notes">{notes}</pre>
      ) : null}
      <SettingToggle
        checked={autoCheckForUpdates}
        description="Check GitHub Releases quietly when ABW opens and periodically in the background."
        label="Check for updates automatically"
        onChange={onAutoCheckChange}
      />
    </div>
  );
}

function StartupTabsSettings({
  urls,
  onChange,
}: {
  urls: string[];
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
        <h2>Startup and new tabs</h2>
        <p>The first URL is the new tab default. All URLs open together on launch.</p>
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
  selected,
  onAutoMatchChange,
  onChange,
}: {
  autoMatch: boolean;
  selected: AppThemeId;
  onAutoMatchChange: (autoMatch: boolean) => void;
  onChange: (theme: AppThemeId) => void;
}) {
  return (
    <div className="theme-panel">
      <div>
        <h2>Theme</h2>
        <p>Match ABW's title bar to a Wrike-inspired workspace colour.</p>
      </div>
      <div className="theme-auto-toggle">
        <SettingToggle
          checked={autoMatch}
          description="Automatically match the top window bar to the theme selected in your Wrike workspace sidebar. Choosing a theme below switches to manual selection."
          label="Automatically match Wrike theme"
          onChange={onAutoMatchChange}
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
            <span>{theme.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DictionarySettings({
  words,
  onChange,
}: {
  words: string[];
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
        <h2>Custom dictionary</h2>
        <p>Add campaign names, client names and abbreviations that ABW should accept.</p>
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
                <strong>{word}</strong>
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
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
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
