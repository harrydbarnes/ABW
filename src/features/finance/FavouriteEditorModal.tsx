import { useMemo, useState } from "react";
import type { FinanceFavouriteFilter, MxBuyerEntry } from "../../types";

interface FavouriteEditorModalProps {
  initial: FinanceFavouriteFilter | null;
  mxBuyers: MxBuyerEntry[];
  knownBuyers: string[];
  knownClients: string[];
  knownAgencies: string[];
  onCancel: () => void;
  onDelete?: (id: string) => void;
  onSave: (fav: FinanceFavouriteFilter) => void;
}

export function FavouriteEditorModal({
  initial,
  mxBuyers,
  knownBuyers,
  knownClients,
  knownAgencies,
  onCancel,
  onDelete,
  onSave,
}: FavouriteEditorModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [buyers, setBuyers] = useState<string[]>(initial?.buyers ?? []);
  const [clients, setClients] = useState<string[]>(initial?.clients ?? []);
  const [agencies, setAgencies] = useState<string[]>(initial?.agencies ?? []);
  const [notify, setNotify] = useState(initial?.notify ?? true);

  const [buyerInput, setBuyerInput] = useState("");
  const [clientInput, setClientInput] = useState("");
  const [agencyInput, setAgencyInput] = useState("");

  const buyerSuggestions = useMemo(() => {
    const q = buyerInput.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set(buyers.map((b) => b.toLowerCase()));
    const out: string[] = [];
    for (const b of knownBuyers) {
      if (!seen.has(b.toLowerCase()) && b.toLowerCase().includes(q)) {
        seen.add(b.toLowerCase());
        out.push(b);
      }
    }
    for (const b of mxBuyers) {
      if (out.length >= 12) break;
      const label = b.name;
      if (
        !seen.has(label.toLowerCase()) &&
        (label.toLowerCase().includes(q) || b.code.toLowerCase().includes(q))
      ) {
        seen.add(label.toLowerCase());
        out.push(label);
      }
    }
    return out.slice(0, 12);
  }, [buyerInput, buyers, knownBuyers, mxBuyers]);

  function addUnique(list: string[], setList: (next: string[]) => void, raw: string) {
    const val = raw.trim();
    if (!val) return;
    if (!list.some((item) => item.toLowerCase() === val.toLowerCase())) {
      setList([...list, val]);
    }
  }

  function handleSubmit() {
    const cleanName = name.trim();
    if (!cleanName) return;
    onSave({
      id: initial?.id ?? `fav-${Date.now()}`,
      name: cleanName,
      buyers,
      clients,
      agencies,
      notify,
      builtIn: initial?.builtIn ?? false,
    });
  }

  return (
    <div className="finance-modal-backdrop" onClick={onCancel}>
      <div className="finance-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>
          {initial ? `Edit Favourite: ${initial.name}` : "New Favourite Filter"}
        </h3>
        <div className="finance-drawer-field">
          <label>Favourite Name (e.g. My Team, CRUK &amp; Boots)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Team"
            disabled={initial?.id === "all"}
          />
        </div>

        <div className="finance-drawer-field">
          <label>Buyers / People (matches MX To Buyer, Owner &amp; Prisma Buyer)</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={buyerInput}
              onChange={(e) => setBuyerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addUnique(buyers, setBuyers, buyerInput);
                  setBuyerInput("");
                }
              }}
              placeholder="Type name or MX buyer code (e.g. HARRY BARNES)"
            />
            <button
              className="finance-btn"
              type="button"
              onClick={() => {
                addUnique(buyers, setBuyers, buyerInput);
                setBuyerInput("");
              }}
            >
              Add
            </button>
          </div>
          {buyerSuggestions.length > 0 ? (
            <div className="finance-chip-list" style={{ marginTop: 6 }}>
              {buyerSuggestions.map((s) => (
                <button
                  key={s}
                  className="finance-btn"
                  style={{ padding: "2px 8px", fontSize: 11.5 }}
                  type="button"
                  onClick={() => {
                    addUnique(buyers, setBuyers, s);
                    setBuyerInput("");
                  }}
                >
                  + {s}
                </button>
              ))}
            </div>
          ) : null}
          <div className="finance-chip-list" style={{ marginTop: 6 }}>
            {buyers.map((b) => (
              <span key={b} className="finance-chip">
                {b}
                <button
                  type="button"
                  onClick={() => setBuyers(buyers.filter((x) => x !== b))}
                  aria-label={`Remove ${b}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="finance-drawer-field">
          <label>Clients / Advertisers (optional — matches Advertiser, Client ID or Campaign)</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              list="finance-known-clients"
              value={clientInput}
              onChange={(e) => setClientInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addUnique(clients, setClients, clientInput);
                  setClientInput("");
                }
              }}
              placeholder="e.g. CW7, CANCER RESEARCH, BOOTS"
            />
            <datalist id="finance-known-clients">
              {knownClients.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <button
              className="finance-btn"
              type="button"
              onClick={() => {
                addUnique(clients, setClients, clientInput);
                setClientInput("");
              }}
            >
              Add
            </button>
          </div>
          <div className="finance-chip-list" style={{ marginTop: 6 }}>
            {clients.map((c) => (
              <span key={c} className="finance-chip">
                {c}
                <button
                  type="button"
                  onClick={() => setClients(clients.filter((x) => x !== c))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="finance-drawer-field">
          <label>Agencies / Operating Co (optional)</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              list="finance-known-agencies"
              value={agencyInput}
              onChange={(e) => setAgencyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addUnique(agencies, setAgencies, agencyInput);
                  setAgencyInput("");
                }
              }}
              placeholder="e.g. MEDIACOM LONDON, NGMCLON"
            />
            <datalist id="finance-known-agencies">
              {knownAgencies.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <button
              className="finance-btn"
              type="button"
              onClick={() => {
                addUnique(agencies, setAgencies, agencyInput);
                setAgencyInput("");
              }}
            >
              Add
            </button>
          </div>
          <div className="finance-chip-list" style={{ marginTop: 6 }}>
            {agencies.map((a) => (
              <span key={a} className="finance-chip">
                {a}
                <button
                  type="button"
                  onClick={() => setAgencies(agencies.filter((x) => x !== a))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => setNotify(e.target.checked)}
          />
          <span>
            Notify me for new MQS queries, Rejected IOs, Sent IOs due in ≤3 days, and Accepted IOs
            with open MQS matching this favourite
          </span>
        </label>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <div>
            {initial && !initial.builtIn && onDelete ? (
              <button
                className="finance-btn danger"
                type="button"
                onClick={() => onDelete(initial.id)}
              >
                Delete
              </button>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="finance-btn" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="finance-btn primary"
              type="button"
              disabled={!name.trim()}
              onClick={handleSubmit}
            >
              Save Favourite
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
