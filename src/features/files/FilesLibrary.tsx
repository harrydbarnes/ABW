import { memo, useMemo, useRef, type KeyboardEvent } from "react";
import type { DownloadRecord, FileFilter } from "../../types";

interface Props {
  downloads: DownloadRecord[];
  filter: FileFilter;
  onDelete: (record: DownloadRecord) => void;
  onFilterChange: (filter: FileFilter) => void;
  onOpenSourceTask: (record: DownloadRecord) => void;
  onReveal: (id: string) => void;
  onSearchChange: (search: string) => void;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  pinnedIds: string[];
  search: string;
  selectedId: string | null;
}

const filters: Array<{ id: FileFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "pdf", label: "PDF" },
  { id: "spreadsheet", label: "Spreadsheets" },
  { id: "document", label: "Documents" },
];

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export const FilesLibrary = memo(function FilesLibrary({
  downloads,
  filter,
  onDelete,
  onFilterChange,
  onOpenSourceTask,
  onReveal,
  onSearchChange,
  onSelect,
  onTogglePin,
  pinnedIds,
  search,
  selectedId,
}: Props) {
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const todayString = useMemo(() => new Date().toDateString(), [downloads]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const target = event.target;
    const isTextInput =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if (
      (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "f") ||
      (!event.ctrlKey && !event.metaKey && !event.altKey && event.key === "/" && !isTextInput)
    ) {
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!downloads.length) {
        return;
      }
      event.preventDefault();
      const currentIndex = downloads.findIndex((item) => item.id === selectedId);
      const nextIndex =
        currentIndex < 0
          ? 0
          : event.key === "ArrowDown"
            ? Math.min(downloads.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
      const next = downloads[nextIndex];
      if (!next) {
        return;
      }
      onSelect(next.id);
      window.requestAnimationFrame(() => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-download-id]");
        rows?.[nextIndex]?.scrollIntoView({ block: "nearest" });
      });
      return;
    }

    if (event.key === "Delete" && !isTextInput) {
      const current = downloads.find((item) => item.id === selectedId);
      if (current && !current.demo) {
        event.preventDefault();
        onDelete(current);
      }
    }
  }

  return (
    <section
      className="files-library"
      aria-label="Downloaded files"
      onKeyDown={handleKeyDown}
    >
      <header className="library-header">
        <div>
          <h1>Files</h1>
          <p>Downloads from your Wrike tasks</p>
        </div>
        <label className="search">
          <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
          <input
            aria-label="Search downloaded files"
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search downloaded files (Ctrl+F)"
            ref={searchInputRef}
            value={search}
          />
        </label>
      </header>
      <div className="filters" aria-label="File type filters">
        {filters.map((item) => (
          <button
            aria-pressed={filter === item.id}
            className={filter === item.id ? "active" : ""}
            key={item.id}
            onClick={() => onFilterChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="list-labels" aria-hidden="true">
        <span>File</span>
        <span>Source task</span>
        <span>Downloaded</span>
        <span />
      </div>
      <div className="file-list" ref={listRef} role="list">
        {downloads.length === 0 ? (
          <div className="empty-list">No downloaded files match this view.</div>
        ) : (
          downloads.map((file) => {
            const isPinned = pinned.has(file.id);
            return (
              <div
                className={[
                  "file-row",
                  selectedId === file.id ? "selected" : "",
                  isPinned ? "pinned" : "",
                ].join(" ")}
                data-download-id={file.id}
                key={file.id}
                role="listitem"
              >
                <button className="file-select" onClick={() => onSelect(file.id)}>
                  <FileGlyph kind={file.kind} />
                  <strong>{file.fileName}</strong>
                </button>
                <button
                  className="row-task-link"
                  onClick={() => onOpenSourceTask(file)}
                  title={`Open ${file.sourceLabel} in Wrike`}
                >
                  {file.sourceLabel}
                </button>
                <time>{formatDate(file.downloadedAt, todayString)}</time>
                <div className="file-row-actions">
                  <button
                    aria-label={`${isPinned ? "Unpin" : "Pin"} ${file.fileName}`}
                    aria-pressed={isPinned}
                    className={`pin-file ${isPinned ? "active" : ""}`}
                    onClick={() => onTogglePin(file.id)}
                    title={isPinned ? "Unpin" : "Pin to top"}
                  >
                    <PinIcon filled={isPinned} />
                  </button>
                  <button
                    aria-label={`Show ${file.fileName} in folder`}
                    className="row-action-button"
                    disabled={!!file.demo}
                    onClick={() => onReveal(file.id)}
                    title="Show in folder"
                  >
                    <FolderIcon />
                  </button>
                  <button
                    aria-label={`Remove ${file.fileName}`}
                    className="row-action-button danger"
                    disabled={!!file.demo}
                    onClick={() => onDelete(file)}
                    title="Remove file"
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
});

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="icon" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7">
      <path d="m14.5 3.5 6 6-3 1.5-3.1 4.4.1 3.1-1.3 1.3-3.7-3.7-4.2 4.2-1.6-1.6 4.2-4.2-3.7-3.7 1.3-1.3 3.1.1L13 6.5Z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.8l2 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M4 7h16M9 7V4.8h6V7M7.5 7l.8 12.2a1 1 0 0 0 1 .8h5.4a1 1 0 0 0 1-.8L16.5 7" />
    </svg>
  );
}

function FileGlyph({ kind }: Pick<DownloadRecord, "kind">) {
  return (
    <span className={`file-glyph ${kind}`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M6 2.8h8l4 4V21H6Z" />
        <path d="M14 3v5h4" />
      </svg>
      <small>{kind === "spreadsheet" ? "XLS" : kind === "pdf" ? "PDF" : "DOC"}</small>
    </span>
  );
}

function formatDate(value: string, todayString: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const time = TIME_FORMATTER.format(date);
  return date.toDateString() === todayString ? `Today, ${time}` : `${DATE_FORMATTER.format(date)}, ${time}`;
}
