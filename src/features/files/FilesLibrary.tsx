import type { DownloadRecord, FileFilter } from "../../types";
import { openSourceTask } from "../../lib/desktop";

interface Props {
  downloads: DownloadRecord[];
  filter: FileFilter;
  onFilterChange: (filter: FileFilter) => void;
  onOpenSourceTask: () => void;
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

export function FilesLibrary({
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
  const pinned = new Set(pinnedIds);
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
          downloads.map((file) => (
            <div
              className={[
                "file-row",
                selectedId === file.id ? "selected" : "",
                pinned.has(file.id) ? "pinned" : "",
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
                onClick={() => {
                  void openSourceTask(file).then(onOpenSourceTask);
                }}
                title={`Open ${file.sourceLabel} in Wrike`}
              >
                {file.sourceLabel}
              </button>
              <time>{formatDate(file.downloadedAt)}</time>
              <button
                aria-label={`${pinned.has(file.id) ? "Unpin" : "Pin"} ${file.fileName}`}
                aria-pressed={pinned.has(file.id)}
                className={`pin-file ${pinned.has(file.id) ? "active" : ""}`}
                onClick={() => onTogglePin(file.id)}
                title={pinned.has(file.id) ? "Unpin" : "Pin to top"}
              >
                <PinIcon filled={pinned.has(file.id)} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

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

function formatDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? `Today, ${time}`
    : date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) + `, ${time}`;
}
