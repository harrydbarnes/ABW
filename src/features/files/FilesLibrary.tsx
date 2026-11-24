import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
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
  onShowPreviewedChange: (value: boolean) => void;
  pinnedIds: string[];
  search: string;
  selectedId: string | null;
  showPreviewed: boolean;
}

interface FilesColumnWidths {
  file: number;
  source: number;
  date: number;
}

const DEFAULT_COL_WIDTHS: FilesColumnWidths = {
  file: 185,
  source: 135,
  date: 84,
};

function loadColumnWidths(): FilesColumnWidths | null {
  try {
    const raw = window.localStorage.getItem("abw.filesColWidths");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FilesColumnWidths>;
    if (
      typeof parsed.file === "number" &&
      typeof parsed.source === "number" &&
      typeof parsed.date === "number"
    ) {
      return {
        file: Math.max(110, Math.min(480, parsed.file)),
        source: Math.max(90, Math.min(360, parsed.source)),
        date: Math.max(68, Math.min(170, parsed.date)),
      };
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

const filters: Array<{ id: FileFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "pdf", label: "PDF" },
  { id: "spreadsheet", label: "Spreadsheets" },
  { id: "image", label: "Images" },
  { id: "document", label: "Documents" },
  { id: "previewed", label: "Previewed" },
];

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

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
  onShowPreviewedChange,
  pinnedIds,
  search,
  selectedId,
  showPreviewed,
}: Props) {
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const sectionRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const todayString = useMemo(() => new Date().toDateString(), [downloads]);
  const [colWidths, setColWidths] = useState<FilesColumnWidths | null>(() => loadColumnWidths());
  const [draggingCol, setDraggingCol] = useState<keyof FilesColumnWidths | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const filesColsStyle = useMemo<CSSProperties | undefined>(() => {
    if (!colWidths) return undefined;
    return {
      "--files-cols": `minmax(${colWidths.file}px, 1fr) ${colWidths.source}px ${colWidths.date}px 98px`,
    } as CSSProperties;
  }, [colWidths]);

  function startColumnResize(col: keyof FilesColumnWidths, clientX: number) {
    dragCleanupRef.current?.();
    const labelCells = labelsRef.current?.querySelectorAll<HTMLElement>(".list-label-cell");
    const initial: FilesColumnWidths = colWidths ?? {
      file: labelCells?.[0]?.getBoundingClientRect().width ?? DEFAULT_COL_WIDTHS.file,
      source: labelCells?.[1]?.getBoundingClientRect().width ?? DEFAULT_COL_WIDTHS.source,
      date: labelCells?.[2]?.getBoundingClientRect().width ?? DEFAULT_COL_WIDTHS.date,
    };
    let latest: FilesColumnWidths = initial;
    const startX = clientX;
    setDraggingCol(col);
    const limits: Record<keyof FilesColumnWidths, [number, number]> = {
      file: [110, 480],
      source: [90, 360],
      date: [68, 170],
    };
    const [minW, maxW] = limits[col];
    const onMove = (event: PointerEvent) => {
      const delta = event.clientX - startX;
      latest = {
        ...initial,
        [col]: Math.round(Math.max(minW, Math.min(maxW, initial[col] + delta))),
      };
      sectionRef.current?.style.setProperty(
        "--files-cols",
        `minmax(${latest.file}px, 1fr) ${latest.source}px ${latest.date}px 98px`,
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanupRef.current = null;
      setDraggingCol(null);
      setColWidths(latest);
      try {
        window.localStorage.setItem("abw.filesColWidths", JSON.stringify(latest));
      } catch {
        // ignore storage errors
      }
    };
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      dragCleanupRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

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
      ref={sectionRef}
      style={filesColsStyle}
    >
      <header className="library-header">
        <div className="library-header-top">
          <div>
            <h1>Files</h1>
            <p>Downloads from your Wrike tasks</p>
          </div>
          <label
            className="files-previewed-toggle"
            title="Include files opened via in-app preview in All and type tabs"
          >
            <input
              checked={showPreviewed}
              onChange={(event) => onShowPreviewedChange(event.target.checked)}
              type="checkbox"
            />
            <span className="files-toggle-track" aria-hidden="true" />
            <span>Previewed files</span>
          </label>
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
      <div className="list-labels" ref={labelsRef}>
        <span className="list-label-cell">
          File
          <span
            aria-label="Resize File column"
            className={`col-resizer ${draggingCol === "file" ? "dragging" : ""}`}
            onPointerDown={(event) => {
              event.preventDefault();
              startColumnResize("file", event.clientX);
            }}
            role="separator"
          />
        </span>
        <span className="list-label-cell">
          Source task
          <span
            aria-label="Resize Source task column"
            className={`col-resizer ${draggingCol === "source" ? "dragging" : ""}`}
            onPointerDown={(event) => {
              event.preventDefault();
              startColumnResize("source", event.clientX);
            }}
            role="separator"
          />
        </span>
        <span className="list-label-cell">
          Downloaded
          <span
            aria-label="Resize Downloaded column"
            className={`col-resizer ${draggingCol === "date" ? "dragging" : ""}`}
            onPointerDown={(event) => {
              event.preventDefault();
              startColumnResize("date", event.clientX);
            }}
            role="separator"
          />
        </span>
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
                    aria-label={`Delete ${file.fileName} from your computer and Files list`}
                    className="row-action-button danger"
                    disabled={!!file.demo}
                    onClick={() => onDelete(file)}
                    title="Delete file from your computer and Files list"
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
  const now = new Date();
  const ageMs = now.getTime() - date.getTime();
  if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) {
    const time = TIME_FORMATTER.format(date);
    return date.toDateString() === todayString ? `Today, ${time}` : `Yesterday, ${time}`;
  }
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  if (date.getFullYear() !== now.getFullYear()) {
    const year = String(date.getFullYear()).slice(-2);
    return `${day}/${month}/${year}`;
  }
  return `${day}/${month}`;
}
