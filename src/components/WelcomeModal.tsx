interface WelcomeModalProps {
  onDismiss: () => void;
  onOpenSettings: () => void;
}

const TEAMS_CHAT_URL =
  "https://teams.microsoft.com/l/chat/0/0?users=harry.barnes@wppmedia.com";

export function WelcomeModal({ onDismiss, onOpenSettings }: WelcomeModalProps) {
  return (
    <div
      className="welcome-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="abw-welcome-title"
    >
      <div className="welcome-modal">
        <div className="welcome-header">
          <h2 id="abw-welcome-title">Welcome to ABW</h2>
          <p>
            A faster, leaner way to use Wrike on Windows — built to use less CPU and memory than
            Chrome or the standard Wrike app, alongside features to improve your day-to-day work.
          </p>
        </div>

        <div className="welcome-callout">
          <strong>🔔 Avoid duplicate Wrike notifications</strong>
          <p>
            ABW now sends Windows pop-ups when someone <code>@mentions</code> you or updates your
            Wrike Inbox:
          </p>
          <ul>
            <li>
              <strong>Old Wrike desktop app:</strong> quit it (or turn off its notifications) so you
              don&apos;t get the same alert twice.
            </li>
            <li>
              <strong>Wrike in Chrome:</strong> turn off browser notifications for{" "}
              <code>wrike.com</code>.
            </li>
          </ul>
        </div>

        <div className="welcome-section-title">
          What&apos;s set up for you <span>(change anytime in Settings)</span>
        </div>

        <div className="welcome-grid">
          <div className="welcome-card">
            <strong>⚡ Faster &amp; leaner on CPU &amp; memory</strong>
            <p>
              Inactive tabs sleep automatically after 30 mins and when minimized to the tray,
              keeping your PC responsive.
            </p>
          </div>
          <div className="welcome-card">
            <strong>📄 Faster file &amp; spreadsheet previews</strong>
            <p>
              Images &amp; PDFs open right inside Wrike. Spreadsheets and saved files live in your{" "}
              <strong>Files</strong> tab and preview much faster than Wrike.
            </p>
          </div>
          <div className="welcome-card">
            <strong>🔔 Wrike &amp; Download alerts</strong>
            <p>
              Windows pop-ups for <code>@mentions</code>, Inbox updates, and saved files. Closing
              the window tucks ABW into the system tray so alerts keep arriving.
            </p>
          </div>
          <div className="welcome-card">
            <strong>🗂️ Tabs, Split View &amp; History</strong>
            <p>
              Open multiple Wrike tabs side-by-side, star favourite tickets, and search your visited{" "}
              <strong>History</strong>.
            </p>
          </div>
          <div className="welcome-card">
            <strong>🧾 Check PO (In Testing)</strong>
            <p>
              Checks Wrike task POs against Prisma automatically when paired with Ops Toolshed.{" "}
              <em>Currently in testing — feedback welcome!</em>
            </p>
          </div>
          <div className="welcome-card">
            <strong>✅ Spell check &amp; easy updates</strong>
            <p>
              Checks spelling as you type, and updates don&apos;t require admin rights (unlike the
              Wrike app). Look out for updates via an in-app banner!
            </p>
          </div>
        </div>

        <div className="welcome-feedback">
          Any feedback? Speak to{" "}
          <a href={TEAMS_CHAT_URL} target="_blank" rel="noreferrer">
            Harry Barnes on Teams
          </a>
          .
        </div>

        <div className="welcome-actions">
          <button className="welcome-btn secondary" type="button" onClick={onOpenSettings}>
            Review all settings
          </button>
          <button className="welcome-btn primary" type="button" onClick={onDismiss}>
            Got it — Open Wrike
          </button>
        </div>
      </div>
    </div>
  );
}
