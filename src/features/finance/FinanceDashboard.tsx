import { useEffect, useMemo, useState } from "react";
import {
  financeExportXlsx,
  financeFocusMx,
  financeImportMqsFile,
  financeImportMqsText,
  financeListMxBuyers,
  financeLoadState,
  financePickDigestFolder,
  financeRunMxAction,
  financeRunPrismaAction,
  financeSaveFavourites,
  financeSyncMx,
  financeSyncPrisma,
  financeUpdateTicketNote,
} from "../../lib/desktop";
import type {
  FinanceFavouriteFilter,
  FinanceSnapshot,
  MatchedOrderView,
  MatchedTicketView,
  MxBuyerEntry,
  OrderRiskLevel,
} from "../../types";
import { FavouriteEditorModal } from "./FavouriteEditorModal";

const MX_ACTIONS = [
  "Set Buyer",
  "Assign serials",
  "Unassign serials",
  "With Buyer",
  "With Buyer - Supplier",
  "With Finance",
];

type FinanceSubTab = "overview" | "mqs" | "orders";

function matchesFavouriteTicket(t: MatchedTicketView, fav: FinanceFavouriteFilter): boolean {
  if (!fav.buyers.length && !fav.clients.length && !fav.agencies.length) return true;
  const buyerOk =
    !fav.buyers.length ||
    fav.buyers.some((b) => {
      const n = b.trim().toLowerCase();
      return (
        !!n &&
        (t.ticket.toBuyer.toLowerCase().includes(n) || t.ticket.owner.toLowerCase().includes(n))
      );
    });
  const clientOk =
    !fav.clients.length ||
    fav.clients.some((c) => {
      const n = c.trim().toLowerCase();
      return (
        !!n &&
        (t.ticket.advertiser.toLowerCase().includes(n) ||
          t.ticket.clientCode.toLowerCase() === n)
      );
    });
  const agencyOk =
    !fav.agencies.length ||
    fav.agencies.some((a) => {
      const n = a.trim().toLowerCase();
      return (
        !!n &&
        (t.ticket.buyingAgency.toLowerCase().includes(n) ||
          t.ticket.operatingCo.toLowerCase().includes(n))
      );
    });
  return buyerOk && clientOk && agencyOk;
}

function matchesFavouriteOrder(o: MatchedOrderView, fav: FinanceFavouriteFilter): boolean {
  if (!fav.buyers.length && !fav.clients.length && !fav.agencies.length) return true;
  const buyerOk =
    !fav.buyers.length ||
    fav.buyers.some((b) => {
      const n = b.trim().toLowerCase();
      return !!n && o.order.buyer.toLowerCase().includes(n);
    });
  const clientOk =
    !fav.clients.length ||
    fav.clients.some((c) => {
      const n = c.trim().toLowerCase();
      return (
        !!n &&
        (o.order.clientId.toLowerCase() === n || o.order.campaign.toLowerCase().includes(n))
      );
    });
  const agencyOk =
    !fav.agencies.length ||
    fav.agencies.some((a) => {
      const n = a.trim().toLowerCase();
      return !!n && o.order.agency.toLowerCase().includes(n);
    });
  return buyerOk && clientOk && agencyOk;
}

function formatMoney(amount: number, currency = "GBP"): string {
  const sym = currency === "EUR" ? "€" : currency === "USD" ? "$" : "£";
  return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function riskBadge(level: OrderRiskLevel): { cls: string; label: string } {
  switch (level) {
    case "accepted_with_mqs":
      return { cls: "danger", label: "ACCEPTED · MQS OPEN" };
    case "rejected":
      return { cls: "danger", label: "REJECTED" };
    case "sent_urgent":
      return { cls: "warn", label: "SENT · URGENT" };
    case "sent_watch":
      return { cls: "neutral", label: "SENT" };
    default:
      return { cls: "ok", label: "ACCEPTED" };
  }
}

export default function FinanceDashboard({
  onBadgeCountChange,
  onNotify,
}: {
  onBadgeCountChange?: (count: number) => void;
  onNotify?: (message: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null);
  const [mxBuyers, setMxBuyers] = useState<MxBuyerEntry[]>([]);
  const [subTab, setSubTab] = useState<FinanceSubTab>("overview");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTicketNo, setSelectedTicketNo] = useState<string | null>(null);
  const [editingFav, setEditingFav] = useState<FinanceFavouriteFilter | "new" | null>(null);
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteText, setPasteText] = useState("");

  // MX Action form state
  const [mxAction, setMxAction] = useState(MX_ACTIONS[5]);
  const [mxComments, setMxComments] = useState("");
  const [mxSerial, setMxSerial] = useState("");
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [snap, buyers] = await Promise.all([financeLoadState(), financeListMxBuyers(5000)]);
        setSnapshot(snap);
        setMxBuyers(buyers);
        onBadgeCountChange?.(snap.notifyBadgeCount);
      } catch (err) {
        onNotify?.(`Could not load Finance data: ${String(err)}`);
      }
    })();
  }, [onBadgeCountChange, onNotify]);

  function applySnapshot(next: FinanceSnapshot) {
    setSnapshot(next);
    onBadgeCountChange?.(next.notifyBadgeCount);
  }

  const activeFav: FinanceFavouriteFilter = useMemo(() => {
    if (!snapshot) {
      return {
        id: "all",
        name: "Whole Company",
        buyers: [],
        clients: [],
        agencies: [],
        notify: false,
        builtIn: true,
      };
    }
    return (
      snapshot.favourites.find((f) => f.id === snapshot.activeFavouriteId) ??
      snapshot.favourites[0]
    );
  }, [snapshot]);

  const filteredTickets = useMemo(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return snapshot.tickets.filter((t) => {
      if (!matchesFavouriteTicket(t, activeFav)) return false;
      if (!q) return true;
      return [
        t.ticket.ticketNo,
        t.ticket.toBuyer,
        t.ticket.advertiser,
        t.ticket.payee,
        t.ticket.invoiceNo,
        t.ticket.bookingReference,
        t.ticket.reason,
        t.linkedOrderVer ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [snapshot, activeFav, search]);

  const filteredOrders = useMemo(() => {
    if (!snapshot) return [];
    const q = search.trim().toLowerCase();
    return snapshot.orders.filter((o) => {
      if (!matchesFavouriteOrder(o, activeFav)) return false;
      if (!q) return true;
      return [
        o.order.orderVer,
        o.order.status,
        o.order.seller,
        o.order.clientId,
        o.order.estimateId,
        o.order.campaign,
        o.order.buyer,
        o.linkedTicketNos.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [snapshot, activeFav, search]);

  const atRiskOrders = useMemo(
    () => filteredOrders.filter((o) => o.riskLevel !== "healthy"),
    [filteredOrders],
  );
  const acceptedWithMqsOrders = useMemo(
    () => filteredOrders.filter((o) => o.riskLevel === "accepted_with_mqs"),
    [filteredOrders],
  );
  const matchedTicketsCount = useMemo(
    () => filteredTickets.filter((t) => t.linkedOrderVer !== null).length,
    [filteredTickets],
  );
  const totalQueriedGbp = useMemo(
    () =>
      filteredTickets
        .filter((t) => !t.ticket.currency || t.ticket.currency === "GBP")
        .reduce((sum, t) => sum + t.ticket.queriedGross, 0),
    [filteredTickets],
  );

  const selectedTicket = useMemo(
    () => filteredTickets.find((t) => t.ticket.ticketNo === selectedTicketNo) ?? null,
    [filteredTickets, selectedTicketNo],
  );

  useEffect(() => {
    setNoteDraft(selectedTicket?.ticket.localNotes ?? "");
  }, [selectedTicket?.ticket.ticketNo, selectedTicket?.ticket.localNotes]);

  const knownBuyers = useMemo(() => {
    if (!snapshot) return [];
    return Array.from(
      new Set([
        ...snapshot.tickets.map((t) => t.ticket.toBuyer).filter(Boolean),
        ...snapshot.orders.map((o) => o.order.buyer).filter(Boolean),
      ]),
    ).sort();
  }, [snapshot]);

  const knownClients = useMemo(() => {
    if (!snapshot) return [];
    return Array.from(
      new Set([
        ...snapshot.tickets.map((t) => t.ticket.advertiser).filter(Boolean),
        ...snapshot.tickets.map((t) => t.ticket.clientCode).filter(Boolean),
        ...snapshot.orders.map((o) => o.order.clientId).filter(Boolean),
      ]),
    ).sort();
  }, [snapshot]);

  const knownAgencies = useMemo(() => {
    if (!snapshot) return [];
    return Array.from(
      new Set([
        ...snapshot.tickets.map((t) => t.ticket.buyingAgency).filter(Boolean),
        ...snapshot.orders.map((o) => o.order.agency).filter(Boolean),
      ]),
    ).sort();
  }, [snapshot]);

  async function selectFavourite(id: string) {
    if (!snapshot) return;
    const next = await financeSaveFavourites(snapshot.favourites, id);
    applySnapshot(next);
  }

  async function handleSaveFavourite(fav: FinanceFavouriteFilter) {
    if (!snapshot) return;
    const exists = snapshot.favourites.some((f) => f.id === fav.id);
    const updated = exists
      ? snapshot.favourites.map((f) => (f.id === fav.id ? fav : f))
      : [...snapshot.favourites, fav];
    const next = await financeSaveFavourites(updated, fav.id);
    applySnapshot(next);
    setEditingFav(null);
    onNotify?.(`Saved favourite filter "${fav.name}".`);
  }

  async function handleDeleteFavourite(id: string) {
    if (!snapshot) return;
    const updated = snapshot.favourites.filter((f) => f.id !== id);
    const nextActive = snapshot.activeFavouriteId === id ? "all" : snapshot.activeFavouriteId;
    const next = await financeSaveFavourites(updated, nextActive);
    applySnapshot(next);
    setEditingFav(null);
    onNotify?.("Deleted favourite filter.");
  }

  async function runSyncMx() {
    setBusy("mx");
    try {
      const next = await financeSyncMx();
      applySnapshot(next);
      onNotify?.(
        next.syncStatus.lastError ?? `Synced ${next.tickets.length} MQS tickets.`,
      );
    } catch (err) {
      onNotify?.(`MX sync failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function runSyncPrisma() {
    setBusy("prisma");
    try {
      const next = await financeSyncPrisma();
      applySnapshot(next);
      onNotify?.(
        next.syncStatus.lastError ?? `Synced ${next.orders.length} Prisma orders.`,
      );
    } catch (err) {
      onNotify?.(`Prisma sync failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handlePasteImport() {
    if (!pasteText.trim()) return;
    setBusy("paste");
    try {
      const next = await financeImportMqsText(pasteText, "manualImport");
      applySnapshot(next);
      setPasteText("");
      setShowPasteModal(false);
      onNotify?.(`Imported MQS rows (${next.tickets.length} total).`);
    } catch (err) {
      onNotify?.(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleImportFile() {
    setBusy("file");
    try {
      const next = await financeImportMqsFile();
      applySnapshot(next);
      onNotify?.(`Loaded MQS file (${next.tickets.length} total tickets).`);
    } catch (err) {
      onNotify?.(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handlePickDigestFolder() {
    setBusy("folder");
    try {
      const next = await financePickDigestFolder();
      applySnapshot(next);
      onNotify?.(
        next.digestFolder
          ? `Watching MQS digest folder: ${next.digestFolder}`
          : "Digest folder unchanged.",
      );
    } catch (err) {
      onNotify?.(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleExportXlsx() {
    setBusy("export");
    try {
      const saved = await financeExportXlsx(activeFav.id);
      if (saved) {
        onNotify?.(`Exported Finance Excel pack to ${saved}`);
      }
    } catch (err) {
      onNotify?.(`Export failed: ${String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleMxAction(submit: boolean) {
    if (!selectedTicket) return;
    if (submit) {
      const confirmed = window.confirm(
        `Submit "${mxAction}" on MQS ticket #${selectedTicket.ticket.ticketNo} in MX Media Explorer?`,
      );
      if (!confirmed) return;
    }
    setBusy("mx-action");
    try {
      const res = await financeRunMxAction({
        ticketNo: selectedTicket.ticket.ticketNo,
        action: mxAction,
        comments: mxComments,
        toBuyer: selectedTicket.ticket.toBuyer,
        serial: mxSerial,
        submit,
      });
      onNotify?.(res.message);
    } catch (err) {
      onNotify?.(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handlePrismaAction(
    orderVer: string,
    action: "agency_accept" | "request_revision",
  ) {
    const label = action === "agency_accept" ? "Agency accept" : "Request revision";
    const confirmed = window.confirm(
      `Trigger "${label}" on Prisma order ${orderVer} via Ops Toolshed?`,
    );
    if (!confirmed) return;
    setBusy(`prisma-${orderVer}`);
    try {
      const res = await financeRunPrismaAction({ orderVer, action, reason: "" });
      onNotify?.(res.message);
      if (res.ok) {
        const next = await financeSyncPrisma();
        applySnapshot(next);
      }
    } catch (err) {
      onNotify?.(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveNote() {
    if (!selectedTicket) return;
    const next = await financeUpdateTicketNote(selectedTicket.ticket.ticketNo, noteDraft);
    applySnapshot(next);
    onNotify?.(`Saved note on MQS #${selectedTicket.ticket.ticketNo}.`);
  }

  if (!snapshot) {
    return <div className="finance-screen">Loading Finance dashboard...</div>;
  }

  return (
    <div className="finance-screen">
      <div className="finance-header">
        <div className="finance-fav-bar" role="tablist" aria-label="Saved finance favourite filters">
          {snapshot.favourites.map((fav) => (
            <button
              key={fav.id}
              type="button"
              className={`finance-fav-pill ${fav.id === activeFav.id ? "active" : ""}`}
              onClick={() => void selectFavourite(fav.id)}
              title={
                fav.buyers.length || fav.clients.length
                  ? `Buyers: ${fav.buyers.join(", ") || "Any"} | Clients: ${fav.clients.join(", ") || "Any"}`
                  : "No restrictions (all records)"
              }
            >
              <span>{fav.name}</span>
              {fav.notify ? <span title="Notifications enabled">🔔</span> : null}
            </button>
          ))}
          <button
            type="button"
            className="finance-fav-pill"
            onClick={() => setEditingFav(activeFav)}
            title="Edit current favourite filter"
          >
            Edit
          </button>
          <button
            type="button"
            className="finance-fav-pill add-btn"
            onClick={() => setEditingFav("new")}
          >
            + New Favourite
          </button>
        </div>

        <div className="finance-actions-bar">
          <button
            type="button"
            className="finance-btn"
            disabled={busy !== null}
            onClick={() => void runSyncMx()}
          >
            {busy === "mx" ? "Syncing MX..." : "Sync MX"}
          </button>
          <button
            type="button"
            className="finance-btn"
            disabled={busy !== null}
            onClick={() => setShowPasteModal(true)}
          >
            Paste MQS
          </button>
          <button
            type="button"
            className="finance-btn"
            disabled={busy !== null}
            onClick={() => void handleImportFile()}
          >
            Import Digest/File
          </button>
          <button
            type="button"
            className="finance-btn"
            disabled={busy !== null}
            onClick={() => void handlePickDigestFolder()}
            title={snapshot.digestFolder ?? "Choose a folder where MQS email digests are saved"}
          >
            Digest Folder
          </button>
          <button
            type="button"
            className="finance-btn"
            disabled={busy !== null}
            onClick={() => void runSyncPrisma()}
          >
            {busy === "prisma" ? "Syncing Prisma..." : "Sync Prisma"}
          </button>
          <button
            type="button"
            className="finance-btn primary"
            disabled={busy !== null}
            onClick={() => void handleExportXlsx()}
          >
            {busy === "export" ? "Exporting..." : "Export Excel (.xlsx)"}
          </button>
        </div>
      </div>

      <div className="finance-status-strip">
        <span>
          <span className={`finance-status-dot ${snapshot.syncStatus.mxRunning ? "online" : ""}`} />
          MX Media Explorer:{" "}
          {snapshot.syncStatus.mxRunning
            ? `Open (${snapshot.syncStatus.mxEnvironment ?? "MX"})`
            : "Closed (email digest / import mode)"}
        </span>
        <span>
          <span
            className={`finance-status-dot ${snapshot.syncStatus.prismaPaired ? "online" : ""}`}
          />
          Prisma via Ops Toolshed: {snapshot.syncStatus.prismaPaired ? "Paired" : "Not paired"}
        </span>
        {snapshot.digestFolder ? <span>Digest folder: {snapshot.digestFolder}</span> : null}
      </div>

      {snapshot.syncStatus.lastError ? (
        <div className="finance-error-banner">{snapshot.syncStatus.lastError}</div>
      ) : null}

      <div className="finance-kpis">
        <div className="finance-kpi-card">
          <span className="finance-kpi-label">Open MQS Queries</span>
          <span className="finance-kpi-value">{filteredTickets.length}</span>
          <span className="finance-kpi-sub">{formatMoney(totalQueriedGbp, "GBP")} queried GBP</span>
        </div>
        <div className={`finance-kpi-card ${atRiskOrders.length > 0 ? "warn" : ""}`}>
          <span className="finance-kpi-label">At-Risk Prisma IOs</span>
          <span className="finance-kpi-value">{atRiskOrders.length}</span>
          <span className="finance-kpi-sub">Rejected, urgent Sent, or open MQS</span>
        </div>
        <div className={`finance-kpi-card ${acceptedWithMqsOrders.length > 0 ? "danger" : ""}`}>
          <span className="finance-kpi-label">Accepted · Open MQS</span>
          <span className="finance-kpi-value">{acceptedWithMqsOrders.length}</span>
          <span className="finance-kpi-sub">Discrepancy despite IO acceptance</span>
        </div>
        <div className="finance-kpi-card">
          <span className="finance-kpi-label">Linked MQS ↔ Prisma</span>
          <span className="finance-kpi-value">{matchedTicketsCount}</span>
          <span className="finance-kpi-sub">Filter: {activeFav.name}</span>
        </div>
      </div>

      <div className="finance-subtabs">
        <div className="finance-subtab-group">
          <button
            type="button"
            className={`finance-subtab ${subTab === "overview" ? "active" : ""}`}
            onClick={() => setSubTab("overview")}
          >
            Overview ({atRiskOrders.length + filteredTickets.length})
          </button>
          <button
            type="button"
            className={`finance-subtab ${subTab === "mqs" ? "active" : ""}`}
            onClick={() => setSubTab("mqs")}
          >
            MQS Queries ({filteredTickets.length})
          </button>
          <button
            type="button"
            className={`finance-subtab ${subTab === "orders" ? "active" : ""}`}
            onClick={() => setSubTab("orders")}
          >
            Prisma Orders ({filteredOrders.length})
          </button>
        </div>
        <input
          className="finance-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ticket, order ID, buyer, payee, client..."
        />
      </div>

      <div className="finance-workspace">
        <div className="finance-table-wrap">
          {subTab === "orders" ? (
            <table className="finance-table">
              <thead>
                <tr>
                  <th>Order / Ver</th>
                  <th>Risk / Status</th>
                  <th>Seller</th>
                  <th>Client</th>
                  <th>Total</th>
                  <th>Campaign</th>
                  <th>Dates</th>
                  <th>MQS</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: "center", padding: 24, opacity: 0.7 }}>
                      No Prisma orders match &ldquo;{activeFav.name}&rdquo;. Open Prisma Orders in
                      Chrome and click <strong>Sync Prisma</strong>.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map((row) => {
                    const badge = riskBadge(row.riskLevel);
                    return (
                      <tr key={row.order.orderVer}>
                        <td>
                          <strong>{row.order.orderVer}</strong>
                        </td>
                        <td>
                          <span className={`finance-badge ${badge.cls}`}>{badge.label}</span>
                          {row.order.dueLabel ? (
                            <div style={{ fontSize: 11, color: "#b42318", marginTop: 2 }}>
                              {row.order.dueLabel}
                            </div>
                          ) : null}
                        </td>
                        <td>{row.order.seller}</td>
                        <td>{row.order.clientId}</td>
                        <td>{formatMoney(row.order.orderTotal, row.order.currency)}</td>
                        <td>{row.order.campaign}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{row.order.dates}</td>
                        <td>
                          {row.linkedTicketNos.length > 0 ? (
                            <span className="finance-badge danger">
                              #{row.linkedTicketNos.join(", #")}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 4 }}>
                            {!row.order.status.toUpperCase().includes("ACCEPTED") ? (
                              <>
                                <button
                                  type="button"
                                  className="finance-btn"
                                  style={{ padding: "3px 7px", fontSize: 11 }}
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void handlePrismaAction(row.order.orderVer, "agency_accept")
                                  }
                                >
                                  Accept
                                </button>
                                <button
                                  type="button"
                                  className="finance-btn"
                                  style={{ padding: "3px 7px", fontSize: 11 }}
                                  disabled={busy !== null}
                                  onClick={() =>
                                    void handlePrismaAction(row.order.orderVer, "request_revision")
                                  }
                                >
                                  Revision
                                </button>
                              </>
                            ) : null}
                            {row.order.orderUrl ? (
                              <a
                                href={row.order.orderUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="finance-btn"
                                style={{
                                  padding: "3px 7px",
                                  fontSize: 11,
                                  textDecoration: "none",
                                }}
                              >
                                Prisma ↗
                              </a>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          ) : (
            <table className="finance-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>To Buyer</th>
                  <th>Advertiser</th>
                  <th>Payee</th>
                  <th>Invoice</th>
                  <th>Queried Gross</th>
                  <th>Booking Ref / Prisma IO</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {subTab === "overview" && acceptedWithMqsOrders.length > 0 ? (
                  acceptedWithMqsOrders.map((o) => (
                    <tr
                      key={`alert-${o.order.orderVer}`}
                      onClick={() => setSubTab("orders")}
                      style={{ background: "rgba(217, 70, 58, 0.06)" }}
                    >
                      <td>
                        <span className="finance-badge danger">ACCEPTED · MQS</span>
                      </td>
                      <td>{o.order.buyer || "—"}</td>
                      <td>{o.order.clientId}</td>
                      <td>{o.order.seller}</td>
                      <td>{o.order.orderVer}</td>
                      <td>{formatMoney(o.linkedQueriedTotal, o.order.currency)}</td>
                      <td>
                        <strong>{o.order.orderVer}</strong> ({o.order.status})
                      </td>
                      <td>{o.riskReason}</td>
                    </tr>
                  ))
                ) : null}
                {filteredTickets.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: "center", padding: 24, opacity: 0.7 }}>
                      No MQS tickets loaded for &ldquo;{activeFav.name}&rdquo;. Click{" "}
                      <strong>Sync MX</strong>, <strong>Paste MQS</strong>, or{" "}
                      <strong>Import Digest/File</strong>.
                    </td>
                  </tr>
                ) : (
                  filteredTickets.map((row) => (
                    <tr
                      key={row.ticket.ticketNo}
                      className={selectedTicketNo === row.ticket.ticketNo ? "selected" : ""}
                      onClick={() => setSelectedTicketNo(row.ticket.ticketNo)}
                    >
                      <td>
                        <strong>{row.ticket.ticketNo}</strong>
                      </td>
                      <td>{row.ticket.toBuyer}</td>
                      <td>{row.ticket.advertiser}</td>
                      <td>{row.ticket.payee}</td>
                      <td>{row.ticket.invoiceNo}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {formatMoney(row.ticket.queriedGross, row.ticket.currency)}
                      </td>
                      <td>
                        <div>{row.ticket.bookingReference || "—"}</div>
                        {row.linkedOrderVer ? (
                          <span
                            className={`finance-badge ${
                              row.linkedOrderStatus?.toUpperCase().includes("ACCEPTED")
                                ? "danger"
                                : "warn"
                            }`}
                          >
                            {row.linkedOrderVer} · {row.linkedOrderStatus}
                          </span>
                        ) : null}
                      </td>
                      <td>{row.ticket.reason}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {selectedTicket && subTab !== "orders" ? (
          <aside className="finance-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>MQS #{selectedTicket.ticket.ticketNo}</h3>
              <button
                type="button"
                className="finance-btn"
                style={{ padding: "3px 8px" }}
                onClick={() => void financeFocusMx().catch((e) => onNotify?.(String(e)))}
              >
                Focus in MX
              </button>
            </div>
            <div className="finance-drawer-grid">
              <div>
                <strong>Buyer:</strong> {selectedTicket.ticket.toBuyer || "—"}
              </div>
              <div>
                <strong>Status:</strong> {selectedTicket.ticket.status || "With Buyer"}
              </div>
              <div>
                <strong>Invoice:</strong> {selectedTicket.ticket.invoiceNo}
              </div>
              <div>
                <strong>Queried:</strong>{" "}
                {formatMoney(selectedTicket.ticket.queriedGross, selectedTicket.ticket.currency)}
              </div>
              <div>
                <strong>Advertiser:</strong> {selectedTicket.ticket.advertiser}
              </div>
              <div>
                <strong>Payee:</strong> {selectedTicket.ticket.payee}
              </div>
            </div>

            {selectedTicket.linkedOrderVer ? (
              <div className="finance-kpi-card warn">
                <span className="finance-kpi-label">Linked Prisma IO</span>
                <strong>
                  {selectedTicket.linkedOrderVer} ({selectedTicket.linkedOrderStatus})
                </strong>
                <span className="finance-kpi-sub">
                  {selectedTicket.linkedCampaign} — {selectedTicket.linkedSeller}
                </span>
              </div>
            ) : null}

            {selectedTicket.ticket.attachments.length > 0 ? (
              <div>
                <strong style={{ fontSize: 12 }}>MedX.db3 Attachments</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
                  {selectedTicket.ticket.attachments.map((att) => (
                    <li key={att}>{att}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="finance-drawer-field">
              <label>MX Action</label>
              <select value={mxAction} onChange={(e) => setMxAction(e.target.value)}>
                {MX_ACTIONS.map((act) => (
                  <option key={act} value={act}>
                    {act}
                  </option>
                ))}
              </select>
            </div>
            <div className="finance-drawer-field">
              <label>MX Comments</label>
              <textarea
                rows={3}
                value={mxComments}
                onChange={(e) => setMxComments(e.target.value)}
                placeholder="Comment to populate in MX Invoice Query dialog..."
              />
            </div>
            {mxAction.includes("serial") ? (
              <div className="finance-drawer-field">
                <label>Serial</label>
                <input
                  value={mxSerial}
                  onChange={(e) => setMxSerial(e.target.value)}
                  placeholder="Booking serial"
                />
              </div>
            ) : null}
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="finance-btn"
                disabled={busy !== null}
                onClick={() => void handleMxAction(false)}
              >
                Pre-fill in MX
              </button>
              <button
                type="button"
                className="finance-btn primary"
                disabled={busy !== null}
                onClick={() => void handleMxAction(true)}
              >
                Submit in MX
              </button>
            </div>

            <hr style={{ border: "none", borderTop: "1px solid var(--border, #d5dce8)" }} />

            <div className="finance-drawer-field">
              <label>ABW Local Triage Notes (included in Excel export)</label>
              <textarea
                rows={2}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Add internal follow-up notes..."
              />
            </div>
            <button type="button" className="finance-btn" onClick={() => void handleSaveNote()}>
              Save Note
            </button>
          </aside>
        ) : null}
      </div>

      {editingFav !== null ? (
        <FavouriteEditorModal
          initial={editingFav === "new" ? null : editingFav}
          mxBuyers={mxBuyers}
          knownBuyers={knownBuyers}
          knownClients={knownClients}
          knownAgencies={knownAgencies}
          onCancel={() => setEditingFav(null)}
          onDelete={(id) => void handleDeleteFavourite(id)}
          onSave={(fav) => void handleSaveFavourite(fav)}
        />
      ) : null}

      {showPasteModal ? (
        <div className="finance-modal-backdrop" onClick={() => setShowPasteModal(false)}>
          <div className="finance-modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>Paste MQS Rows or Email Digest</h3>
            <p style={{ margin: 0, fontSize: 12.5, opacity: 0.8 }}>
              In MX Media Explorer, select rows in the Invoice Query grid (Ctrl+A, Ctrl+C), or copy
              your MQS email digest table, and paste below.
            </p>
            <textarea
              rows={8}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste tab-separated MQS rows or HTML/CSV digest..."
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="finance-btn"
                onClick={() => setShowPasteModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="finance-btn primary"
                disabled={!pasteText.trim() || busy !== null}
                onClick={() => void handlePasteImport()}
              >
                Import MQS Rows
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
