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
        <p>Preferences apply to ABW and the Wrike workspace window.</p>
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
          description="Open the Wrike sign-in or workspace window alongside Files whenever ABW starts."
          label="Open Wrike workspace on launch"
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
            Comments, mentions and assignments use Wrike notifications in the workspace window.
            Keep it open and enable notifications when Wrike prompts you.
          </p>
        </div>
        <button className="secondary-action" onClick={onTestNotification}>
          Send test notification
        </button>
      </div>
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
