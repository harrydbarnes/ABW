import type { ReactElement } from "react";

export type MaterialIconKind =
  | "add"
  | "arrow_back"
  | "arrow_forward"
  | "close"
  | "description"
  | "finance"
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

export function MaterialIcon({ kind }: { kind: MaterialIconKind }) {
  const paths: Record<MaterialIconKind, ReactElement> = {
    home: <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8Z" />,
    add: <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6Z" />,
    arrow_back: <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20Z" />,
    arrow_forward: <path d="m12 4-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8Z" />,
    close: (
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12Z" />
    ),
    description: (
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm1 7V3.5L20.5 9ZM16 18H8v-2h8Zm0-4H8v-2h8Z" />
    ),
    finance: (
      <path d="M4 10v7h3v-7Zm6 0v7h3v-7Zm-8 9v2h20v-2Zm14-9v7h3v-7ZM12 2 2 7v2h20V7Z" />
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
    star: (
      <path d="m12 17.27 6.18 3.73-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21Z" />
    ),
    star_outline: (
      <path d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03ZM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28Z" />
    ),
    tab: <path d="M4 6a2 2 0 0 1 2-2h5.8a2 2 0 0 1 1.42.59L16.63 8H20v10a2 2 0 0 1-2 2H4Z" />,
    view_column: (
      <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Zm2 0v14h5V5Zm7 0v14h5V5Z" />
    ),
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

export function WindowControls({
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

export function NavIcon({ kind }: { kind: string }) {
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
