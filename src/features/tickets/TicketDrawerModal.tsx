import { useEffect, useMemo, useState } from "react";
import type { FavoriteTicket, VisitHistoryEntry } from "../../types";

type Mode = "favorites" | "history";

interface Props {
  mode: Mode;
  favorites: FavoriteTicket[];
  history: VisitHistoryEntry[];
  onClose: () => void;
  onOpenUrl: (url: string, title?: string) => void;
  onRemoveFavorite: (url: string) => void;
  onClearHistory: () => void;
}

const PAGE_SIZE = 20;
const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatVisitedTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${DAY_FORMATTER.format(date)}, ${TIME_FORMATTER.format(date)}`;
}

export default function TicketDrawerModal({
  mode,
  favorites,
  history,
  onClose,
  onOpenUrl,
  onRemoveFavorite,
  onClearHistory,
}: Props) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    setQuery("");
    setPage(0);
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const normalizedQuery = query.trim().toLowerCase();

  const activeItems = useMemo(() => {
    const source = mode === "favorites" ? favorites : history;
    if (!normalizedQuery) {
      return source;
    }
    return source.filter(
      (item) =>
        item.title.toLowerCase().includes(normalizedQuery) ||
        (item.client ?? "").toLowerCase().includes(normalizedQuery) ||
        (item.details ?? "").toLowerCase().includes(normalizedQuery) ||
        item.url.toLowerCase().includes(normalizedQuery),
    );
  }, [favorites, history, mode, normalizedQuery]);

  const totalPages = Math.max(1, Math.ceil(activeItems.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = activeItems.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const startIndex = activeItems.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const endIndex = Math.min(activeItems.length, (safePage + 1) * PAGE_SIZE);

  return (
    <div
      className="ticket-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={mode === "favorites" ? "Favourites" : "Ticket History"}
    >
      <div className="ticket-modal" onClick={(event) => event.stopPropagation()}>
        <header className="ticket-modal-header">
          <div>
            <h2>{mode === "favorites" ? "Favourites" : "Ticket History"}</h2>
            <p>
              {mode === "favorites"
                ? `${favorites.length} favourited ${favorites.length === 1 ? "ticket" : "tickets"}`
                : `${history.length} ${history.length === 1 ? "ticket" : "tickets"} visited`}
            </p>
          </div>
          <div className="ticket-modal-header-actions">
            {mode === "history" && history.length > 0 ? (
              <button className="ticket-modal-clear" onClick={onClearHistory} type="button">
                Clear history
              </button>
            ) : null}
            <button
              aria-label="Close"
              className="ticket-modal-close"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>

        <div className="ticket-modal-search">
          <input
            aria-label={
              mode === "favorites"
                ? "Search favourites by ticket name, client, or ID"
                : "Search ticket name, client, or details"
            }
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder={
              mode === "favorites"
                ? "Search favourited tickets, client, or ID..."
                : "Search ticket name, client, ID, or details..."
            }
            type="search"
            value={query}
          />
          <p className="ticket-modal-search-hint">
            {mode === "favorites"
              ? "Click any favourited ticket to open it in your Wrike workspace."
              : "Search tickets you have visited by ticket name, client, or Wrike ID."}
          </p>
        </div>

        <div className="ticket-modal-list">
          {pageItems.length === 0 ? (
            <div className="ticket-modal-empty">
              <strong>
                {mode === "favorites" ? "No favourited tickets yet" : "No ticket history yet"}
              </strong>
              <p>
                {mode === "favorites"
                  ? "Click the star icon on any Wrike tab to add it to Favourites."
                  : "Tickets and views you visit in Wrike will appear here automatically."}
              </p>
            </div>
          ) : mode === "favorites" ? (
            (pageItems as FavoriteTicket[]).map((item) => (
              <div className="ticket-modal-row" key={item.id}>
                <button
                  className="ticket-modal-row-main"
                  onClick={() => onOpenUrl(item.url, item.title)}
                  type="button"
                >
                  <strong className="ticket-modal-title">{item.title}</strong>
                  <div className="ticket-modal-meta">
                    {item.client ? (
                      <span>
                        Client <b>{item.client}</b>
                      </span>
                    ) : null}
                    {item.details ? (
                      <span>
                        Details <b>{item.details}</b>
                      </span>
                    ) : null}
                  </div>
                  <div className="ticket-modal-foot">
                    <span>Saved {formatVisitedTimestamp(item.addedAt)}</span>
                  </div>
                </button>
                <div className="ticket-modal-row-actions">
                  <button
                    aria-label={`Remove ${item.title} from favourites`}
                    className="ticket-modal-unstar"
                    onClick={() => onRemoveFavorite(item.url)}
                    title="Remove from favourites"
                    type="button"
                  >
                    ★
                  </button>
                  <span aria-hidden="true" className="ticket-modal-chevron">
                    ›
                  </span>
                </div>
              </div>
            ))
          ) : (
            (pageItems as VisitHistoryEntry[]).map((item) => (
              <div className="ticket-modal-row" key={item.id}>
                <button
                  className="ticket-modal-row-main"
                  onClick={() => onOpenUrl(item.url, item.title)}
                  type="button"
                >
                  <strong className="ticket-modal-title">{item.title}</strong>
                  <div className="ticket-modal-meta">
                    {item.client ? (
                      <span>
                        Client <b>{item.client}</b>
                      </span>
                    ) : null}
                    {item.details ? (
                      <span>
                        Details <b>{item.details}</b>
                      </span>
                    ) : null}
                  </div>
                  <div className="ticket-modal-foot">
                    <span>Last visited {formatVisitedTimestamp(item.lastVisitedAt)}</span>
                    <span className="ticket-modal-visits">
                      {item.visitCount} {item.visitCount === 1 ? "visit" : "visits"}
                    </span>
                  </div>
                </button>
                <div className="ticket-modal-row-actions">
                  <span aria-hidden="true" className="ticket-modal-chevron">
                    ›
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {activeItems.length > 0 ? (
          <footer className="ticket-modal-footer">
            <button
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              type="button"
            >
              ‹
            </button>
            <span>
              {startIndex}–{endIndex} of {activeItems.length}
            </span>
            <button
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              type="button"
            >
              ›
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
