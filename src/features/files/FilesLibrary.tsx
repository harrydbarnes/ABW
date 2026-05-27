import type { DownloadRecord, FileFilter } from "../../types";
import { openSourceTask } from "../../lib/desktop";

interface Props {
  downloads: DownloadRecord[];
  filter: FileFilter;
  onFilterChange: (filter: FileFilter) => void;
  onOpenSourceTask: () => void;
  onSearchChange: (search: string) => void;
  onSelect: (id: string) => void;
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
  search,
  selectedId,
}: Props) {
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
      </div>
      <div className="file-list" role="list">
        {downloads.length === 0 ? (
          <div className="empty-list">No downloaded files match this view.</div>
        ) : (
          downloads.map((file) => (
            <div
              className={`file-row ${selectedId === file.id ? "selected" : ""}`}
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
            </div>
          ))
        )}
      </div>
    </section>
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
