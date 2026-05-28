import { useState } from "react";
import type { Settings } from "../../types";

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  onTestNotification: () => void;
}

export function SettingsPanel({ settings, onChange, onTestNotification }: Props) {
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
          description="Show the live Wrike sign-in or workspace tab whenever ABW starts."
          label="Show Wrike workspace on launch"
          onChange={(launchWrikeOnStart) => onChange({ ...settings, launchWrikeOnStart })}
        />
        <SettingToggle
          checked={settings.downloadNotifications}
          description="Show a Windows notification when a file from Wrike has been saved into ABW Files."
          label="Download complete notifications"
          onChange={(downloadNotifications) => onChange({ ...settings, downloadNotifications })}
        />
      </div>
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
    </section>
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
