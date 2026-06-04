import { useState } from "react";
import { APP_THEMES, type AppThemeId, type Settings } from "../../types";

interface Props {
  appVersion: string;
  settings: Settings;
  onChange: (next: Settings) => void;
  onTestNotification: () => void;
}

export function SettingsPanel({ appVersion, settings, onChange, onTestNotification }: Props) {
  return (
    <section className="settings-panel">
      <header>
        <h1>Settings</h1>
        <p>Preferences apply to ABW and the live Wrike workspace tab.</p>
      </header>
      <div className="setting-group">
        <SettingToggle
          checked={settings.spellCheck}
          description="Mark misspellings in Wrike editors and ABW search fields using WebView2 spell checking."
          label="Spell check"
          onChange={(spellCheck) => onChange({ ...settings, spellCheck })}
        />
        <SettingToggle
          checked={settings.launchWrikeOnStart}
          description="Open your startup tabs whenever ABW starts. You can still reopen the previous session from the launch toast."
          label="Show Wrike workspace on launch"
          onChange={(launchWrikeOnStart) => onChange({ ...settings, launchWrikeOnStart })}
        />
        <SettingToggle
          checked={settings.openAbwAtSystemStartup}
          description="Launch ABW automatically when you sign in to Windows."
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
          checked={settings.downloadNotifications}
          description="Show a Windows notification when a file from Wrike has been saved into ABW Files."
          label="Download complete notifications"
          onChange={(downloadNotifications) => onChange({ ...settings, downloadNotifications })}
        />
      </div>
      <StartupTabsSettings
        urls={settings.startupTabUrls}
        onChange={(startupTabUrls) => onChange({ ...settings, startupTabUrls })}
      />
      <ThemeSettings
        selected={settings.theme}
        onChange={(theme) => onChange({ ...settings, theme })}
      />
      <div className="notification-note">
        <div>
          <h2>Wrike notifications</h2>
          <p>
            Comments, mentions and assignments use Wrike notifications in the live workspace tab.
            Keep it open and enable notifications when Wrike prompts you.
          </p>
        </div>
        <button className="secondary-action" onClick={onTestNotification}>
          Send test notification
        </button>
      </div>
      <DictionarySettings
        words={settings.customDictionary}
        onChange={(customDictionary) => onChange({ ...settings, customDictionary })}
      />
      <div className="storage-note">
        <h2>Downloads</h2>
        <p>
          ABW stores intercepted downloads in its per-user application data directory. Files can
          always be opened in Windows from the preview pane.
        </p>
      </div>
      <footer className="settings-footer">
        ABW v{appVersion} · Questions or support: Harry Barnes
      </footer>
    </section>
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
  selected,
  onChange,
}: {
  selected: AppThemeId;
  onChange: (theme: AppThemeId) => void;
}) {
  return (
    <div className="theme-panel">
      <div>
        <h2>Theme</h2>
        <p>Match ABW's title bar to a Wrike-inspired workspace colour.</p>
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
