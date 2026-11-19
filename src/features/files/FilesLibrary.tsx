import { memo, useMemo } from "react";
import type { DownloadRecord, FileFilter } from "../../types";

interface Props {
  downloads: DownloadRecord[];
  filter: FileFilter;
  onFilterChange: (filter: FileFilter) => void;
  onOpenSourceTask: (record: DownloadRecord) => void;
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
  onFilterChange,
  onOpenSourceTask,
  onSearchChange,
  onSelect,
  onTogglePin,
  pinnedIds,
  search,
  selectedId,
}: Props) {
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const todayString = useMemo(() => new Date().toDateString(), [downloads]);
  return (
    <section className="files-library" aria-label="Downloaded files">
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
            placeholder="Search downloaded files"
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
      <div className="file-list" role="list">
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
                <button
                  aria-label={`${isPinned ? "Unpin" : "Pin"} ${file.fileName}`}
                  aria-pressed={isPinned}
                  className={`pin-file ${isPinned ? "active" : ""}`}
                  onClick={() => onTogglePin(file.id)}
                  title={isPinned ? "Unpin" : "Pin to top"}
                >
                  <PinIcon filled={isPinned} />
                </button>
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
  const sameDay = date.toDateString() === todayString;
  const time = TIME_FORMATTER.format(date);
  return sameDay ? `Today, ${time}` : `${DATE_FORMATTER.format(date)}, ${time}`;
}
