import { useLayoutEffect, useRef, useState } from "react";
import { openFeedback } from "../lib/desktop";
import { AbwWordmark } from "./AbwWordmark";

interface WelcomeModalProps {
  onContinue: (openSettings: boolean) => void;
}

const icons = {
  bell: <path d="M18 8a6 6 0 0 0-12 0c0 6-3 7-3 9h18c0-2-3-3-3-9M10 21h4" />,
  sleep: <path d="M20.5 14.2a8.6 8.6 0 0 1-10.7-10.7 8.6 8.6 0 1 0 10.7 10.7Z" />,
  file: <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7M8 14h8m-8 3h6" />,
  tabs: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18m-9 0v10" />
    </>
  ),
  po: (
    <>
      <rect x="5" y="5" width="14" height="16" rx="2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6M5 20h14" />,
};

const features = [
  {
    icon: "sleep",
    title: "Tabs sleep when idle",
    description: "Tabs sleep after 30 minutes of inactivity and when ABW is minimised to the tray.",
  },
  {
    icon: "file",
    title: "File previews",
    description: "View images and PDFs in Wrike. Find spreadsheets and downloads in the Files tab.",
  },
  {
    icon: "bell",
    title: "Windows notifications",
    description: "Get alerts for mentions, Inbox updates and downloads. Alerts continue in the tray.",
  },
  {
    icon: "tabs",
    title: "Tabs, split view and history",
    description: "Open tabs side by side, star favourite tasks and search your history.",
  },
  {
    icon: "po",
    title: "Check PO",
    description: "Pair with Ops Toolshed to check Wrike task POs against Prisma.",
    status: "In testing",
  },
  {
    icon: "check",
    title: "Spell check and updates",
    description: "Check spelling as you type. The app flags updates, and you can install them without admin rights.",
  },
] as const;

function WelcomeIcon({ name }: { name: keyof typeof icons }) {
  return (
    <svg className="welcome-icon" aria-hidden="true" viewBox="0 0 24 24">
      {icons[name]}
    </svg>
  );
}

export function WelcomeModal({ onContinue }: WelcomeModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closingRef = useRef(false);
  const [feedbackError, setFeedbackError] = useState("");

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector("h1")?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, []);

  async function handleContinue(openSettings: boolean) {
    const dialog = dialogRef.current;
    if (!dialog || closingRef.current) return;
    closingRef.current = true;
    dialog.classList.add("is-leaving");
    // Wait for the panel and backdrop to clear before showing the native webview.
    await Promise.allSettled(
      dialog.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
    if (dialogRef.current !== dialog) return;
    dialog.close();
    onContinue(openSettings);
  }

  async function handleFeedback(channel: "teams" | "email") {
    if (closingRef.current) return;
    setFeedbackError("");
    try {
      await openFeedback(channel);
    } catch {
      setFeedbackError(channel === "teams" ? "Couldn’t open Teams. Try email." : "Couldn’t open your email app.");
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="welcome-modal"
      aria-labelledby="abw-welcome-title"
      onCancel={(event) => {
        event.preventDefault();
        void handleContinue(false);
      }}
    >
      <div className="welcome-content">
        <header className="welcome-header">
          <AbwWordmark className="welcome-wordmark" />
          <h1 id="abw-welcome-title" tabIndex={-1}>A faster, lighter Wrike app for Windows</h1>
        </header>
        <section className="welcome-callout" aria-labelledby="abw-welcome-alerts">
          <span className="welcome-callout-icon"><WelcomeIcon name="bell" /></span>
          <div>
            <h2 id="abw-welcome-alerts">Avoid duplicate Wrike alerts</h2>
            <ul>
              <li>Quit the <strong>Wrike desktop app</strong> or turn off its notifications.</li>
              <li>In <strong>Chrome</strong>, turn off notifications for <code>wrike.com</code>.</li>
            </ul>
          </div>
        </section>
        <section aria-labelledby="abw-welcome-features">
          <div className="welcome-section-title">
            <h2 id="abw-welcome-features">What’s set up for you</h2>
            <p>Change these anytime in Settings</p>
          </div>
          <ul className="welcome-features">
            {features.map((feature) => (
              <li className="welcome-feature" key={feature.icon}>
                <span className="welcome-feature-icon"><WelcomeIcon name={feature.icon} /></span>
                <div>
                  <h3>
                    {feature.title}
                    {"status" in feature && <span className="welcome-testing">{feature.status}</span>}
                  </h3>
                  <p>{feature.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <footer className="welcome-footer">
        <div className="welcome-feedback">
          Feedback?{" "}
          <button type="button" onClick={() => void handleFeedback("teams")}>Harry Barnes on Teams</button>
          <span aria-hidden="true"> · </span>
          <button type="button" onClick={() => void handleFeedback("email")}>Email</button>
          {feedbackError && <p role="status">{feedbackError}</p>}
        </div>
        <div className="welcome-actions">
          <button className="welcome-btn" type="button" onClick={() => void handleContinue(true)}>
            Review settings
          </button>
          <button className="welcome-btn primary" type="button" onClick={() => void handleContinue(false)}>
            Open ABW <span aria-hidden="true">→</span>
          </button>
        </div>
      </footer>
    </dialog>
  );
}
