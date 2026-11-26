use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub mod commands;
pub mod export;
pub mod mx_bridge;
pub mod store;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MqsSource {
    MxLive,
    EmailDigest,
    ManualImport,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MqsTicket {
    pub ticket_no: String,
    pub to_buyer: String,
    pub advertiser: String,
    pub payee: String,
    pub invoice_no: String,
    pub created: String,
    #[serde(default)]
    pub line_no: String,
    pub currency: String,
    pub queried_payable: f64,
    pub queried_gross: f64,
    #[serde(default)]
    pub booking_reference: String,
    pub reason: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub operating_co: String,
    #[serde(default)]
    pub buying_agency: String,
    #[serde(default)]
    pub client_code: String,
    #[serde(default)]
    pub issued_date: String,
    #[serde(default)]
    pub invoice_gross: Option<f64>,
    #[serde(default)]
    pub invoice_net_payable: Option<f64>,
    #[serde(default)]
    pub invoice_total_payable: Option<f64>,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub local_notes: String,
    pub source: MqsSource,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrismaOrder {
    pub order_ver: String,
    pub order_base: String,
    pub status: String,
    #[serde(default)]
    pub due_label: String,
    #[serde(default)]
    pub due_in_days: Option<i32>,
    #[serde(default)]
    pub media: String,
    #[serde(default)]
    pub order_type: String,
    #[serde(default)]
    pub seller: String,
    #[serde(default)]
    pub media_id: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub product_id: String,
    #[serde(default)]
    pub estimate_id: String,
    pub order_total: f64,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default)]
    pub campaign: String,
    #[serde(default)]
    pub campaign_id: String,
    #[serde(default)]
    pub dates: String,
    #[serde(default)]
    pub start_date: String,
    #[serde(default)]
    pub end_date: String,
    #[serde(default)]
    pub buyer: String,
    #[serde(default)]
    pub agency: String,
    #[serde(default)]
    pub order_url: String,
    pub last_seen_at: String,
}

fn default_currency() -> String {
    "GBP".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FinanceFavouriteFilter {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub buyers: Vec<String>,
    #[serde(default)]
    pub clients: Vec<String>,
    #[serde(default)]
    pub agencies: Vec<String>,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub built_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderRiskLevel {
    AcceptedWithMqs,
    Rejected,
    SentUrgent,
    SentWatch,
    Healthy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchedOrderView {
    pub order: PrismaOrder,
    pub risk_level: OrderRiskLevel,
    pub risk_reason: String,
    pub linked_ticket_nos: Vec<String>,
    pub linked_queried_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MatchedTicketView {
    pub ticket: MqsTicket,
    pub normalized_refs: Vec<String>,
    pub linked_order_ver: Option<String>,
    pub linked_order_status: Option<String>,
    pub linked_campaign: Option<String>,
    pub linked_seller: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MxBuyerEntry {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinanceSyncStatus {
    pub mx_running: bool,
    pub mx_last_sync_at: Option<String>,
    pub mx_last_source: Option<MqsSource>,
    pub mx_environment: Option<String>,
    pub prisma_paired: bool,
    pub prisma_last_sync_at: Option<String>,
    pub digest_folder: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceState {
    pub version: u32,
    #[serde(default)]
    pub tickets: Vec<MqsTicket>,
    #[serde(default)]
    pub orders: Vec<PrismaOrder>,
    #[serde(default)]
    pub favourites: Vec<FinanceFavouriteFilter>,
    #[serde(default = "default_active_favourite_id")]
    pub active_favourite_id: String,
    #[serde(default)]
    pub digest_folder: Option<String>,
    #[serde(default)]
    pub sync_status: FinanceSyncStatus,
    #[serde(default)]
    pub notified_keys: Vec<String>,
}

fn default_active_favourite_id() -> String {
    "all".to_owned()
}

impl Default for FinanceState {
    fn default() -> Self {
        Self {
            version: 1,
            tickets: Vec::new(),
            orders: Vec::new(),
            favourites: default_favourites(),
            active_favourite_id: "all".to_owned(),
            digest_folder: None,
            sync_status: FinanceSyncStatus::default(),
            notified_keys: Vec::new(),
        }
    }
}

pub fn default_favourites() -> Vec<FinanceFavouriteFilter> {
    vec![
        FinanceFavouriteFilter {
            id: "all".to_owned(),
            name: "Whole Company".to_owned(),
            buyers: Vec::new(),
            clients: Vec::new(),
            agencies: Vec::new(),
            notify: false,
            built_in: true,
        },
        FinanceFavouriteFilter {
            id: "me".to_owned(),
            name: "Me".to_owned(),
            buyers: Vec::new(),
            clients: Vec::new(),
            agencies: Vec::new(),
            notify: true,
            built_in: true,
        },
        FinanceFavouriteFilter {
            id: "my-team".to_owned(),
            name: "My Team".to_owned(),
            buyers: Vec::new(),
            clients: Vec::new(),
            agencies: Vec::new(),
            notify: true,
            built_in: true,
        },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceSnapshot {
    pub tickets: Vec<MatchedTicketView>,
    pub orders: Vec<MatchedOrderView>,
    pub favourites: Vec<FinanceFavouriteFilter>,
    pub active_favourite_id: String,
    pub digest_folder: Option<String>,
    pub sync_status: FinanceSyncStatus,
    pub notify_badge_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqsActionRequest {
    pub ticket_no: String,
    pub action: String,
    pub comments: String,
    #[serde(default)]
    pub to_buyer: String,
    #[serde(default)]
    pub serial: String,
    pub submit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqsActionResult {
    pub ok: bool,
    pub message: String,
    pub submitted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrismaOrderActionRequest {
    pub order_ver: String,
    pub action: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrismaOrderActionResult {
    pub ok: bool,
    pub status: String,
    pub message: String,
}

/// Normalizes a Prisma Order / Ver string (e.g. `O-D35356S-R1` -> `O-D35356S`).
pub fn normalize_order_ref(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_uppercase();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some((base, rev)) = trimmed.rsplit_once("-R") {
        if !base.is_empty() && !rev.is_empty() && rev.bytes().all(|b| b.is_ascii_digit()) {
            return base.to_owned();
        }
    }
    trimmed
}

/// Extracts candidate Prisma order references from a ticket's booking reference and attachments.
pub fn extract_ticket_order_refs(ticket: &MqsTicket) -> Vec<String> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();

    let mut push_ref = |candidate: &str| {
        let norm = normalize_order_ref(candidate);
        if norm.len() >= 4 && seen.insert(norm.clone()) {
            refs.push(norm);
        }
    };

    if !ticket.booking_reference.trim().is_empty() {
        for token in ticket
            .booking_reference
            .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '/')
        {
            let clean = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-');
            if !clean.is_empty() {
                push_ref(clean);
            }
        }
    }

    for attachment in &ticket.attachments {
        for token in extract_o_tokens(attachment) {
            push_ref(&token);
        }
    }

    refs
}

fn extract_o_tokens(input: &str) -> Vec<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        let is_prefix = (bytes[i] == b'O' || bytes[i] == b'o') && bytes[i + 1] == b'-';
        let boundary_before = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if is_prefix && boundary_before {
            let start = i;
            i += 2;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-') {
                i += 1;
            }
            let candidate = &input[start..i];
            if candidate.len() >= 5 {
                out.push(candidate.to_ascii_uppercase());
            }
        } else {
            i += 1;
        }
    }
    out
}

pub fn ticket_matches_favourite(ticket: &MqsTicket, fav: &FinanceFavouriteFilter) -> bool {
    if fav.buyers.is_empty() && fav.clients.is_empty() && fav.agencies.is_empty() {
        return true;
    }
    let buyer_match = fav.buyers.is_empty()
        || fav.buyers.iter().any(|b| {
            let needle = b.trim().to_ascii_lowercase();
            !needle.is_empty()
                && (ticket.to_buyer.to_ascii_lowercase().contains(&needle)
                    || ticket.owner.to_ascii_lowercase().contains(&needle))
        });
    let client_match = fav.clients.is_empty()
        || fav.clients.iter().any(|c| {
            let needle = c.trim().to_ascii_lowercase();
            !needle.is_empty()
                && (ticket.advertiser.to_ascii_lowercase().contains(&needle)
                    || ticket.client_code.to_ascii_lowercase() == needle)
        });
    let agency_match = fav.agencies.is_empty()
        || fav.agencies.iter().any(|a| {
            let needle = a.trim().to_ascii_lowercase();
            !needle.is_empty()
                && (ticket.buying_agency.to_ascii_lowercase().contains(&needle)
                    || ticket.operating_co.to_ascii_lowercase().contains(&needle))
        });
    buyer_match && client_match && agency_match
}

pub fn order_matches_favourite(order: &PrismaOrder, fav: &FinanceFavouriteFilter) -> bool {
    if fav.buyers.is_empty() && fav.clients.is_empty() && fav.agencies.is_empty() {
        return true;
    }
    let buyer_match = fav.buyers.is_empty()
        || fav.buyers.iter().any(|b| {
            let needle = b.trim().to_ascii_lowercase();
            !needle.is_empty() && order.buyer.to_ascii_lowercase().contains(&needle)
        });
    let client_match = fav.clients.is_empty()
        || fav.clients.iter().any(|c| {
            let needle = c.trim().to_ascii_lowercase();
            !needle.is_empty()
                && (order.client_id.to_ascii_lowercase() == needle
                    || order.campaign.to_ascii_lowercase().contains(&needle))
        });
    let agency_match = fav.agencies.is_empty()
        || fav.agencies.iter().any(|a| {
            let needle = a.trim().to_ascii_lowercase();
            !needle.is_empty() && order.agency.to_ascii_lowercase().contains(&needle)
        });
    buyer_match && client_match && agency_match
}

fn parse_due_days(due_label: &str, explicit: Option<i32>) -> Option<i32> {
    if explicit.is_some() {
        return explicit;
    }
    let lower = due_label.to_ascii_lowercase();
    if lower.contains("overdue") || lower.contains("past due") {
        return Some(-1);
    }
    if lower.contains("today") {
        return Some(0);
    }
    if let Some(pos) = lower.find("due in ") {
        let rest = &lower[pos + 7..];
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(days) = digits.parse::<i32>() {
            return Some(days);
        }
    }
    None
}

pub fn classify_order_risk(
    order: &PrismaOrder,
    linked_ticket_nos: &[String],
) -> (OrderRiskLevel, String) {
    let status_upper = order.status.trim().to_ascii_uppercase();
    let is_accepted = status_upper.contains("ACCEPTED");
    let is_rejected = status_upper.contains("REJECT");

    if is_accepted && !linked_ticket_nos.is_empty() {
        return (
            OrderRiskLevel::AcceptedWithMqs,
            format!(
                "Accepted IO still has {} open MQS {}",
                linked_ticket_nos.len(),
                if linked_ticket_nos.len() == 1 {
                    "query"
                } else {
                    "queries"
                }
            ),
        );
    }
    if is_rejected {
        return (
            OrderRiskLevel::Rejected,
            "Order rejected — high risk of MQS invoice query".to_owned(),
        );
    }
    if status_upper.contains("SENT") || status_upper.contains("PENDING") {
        let due_days = parse_due_days(&order.due_label, order.due_in_days);
        if let Some(days) = due_days {
            if days <= 3 {
                let msg = if days < 0 {
                    "Sent IO is overdue for acceptance".to_owned()
                } else if days == 0 {
                    "Sent IO is due today".to_owned()
                } else {
                    format!(
                        "Sent IO due in {days} day{}",
                        if days == 1 { "" } else { "s" }
                    )
                };
                return (OrderRiskLevel::SentUrgent, msg);
            }
        }
        if !linked_ticket_nos.is_empty() {
            return (
                OrderRiskLevel::SentUrgent,
                format!(
                    "Unaccepted IO already has {} open MQS {}",
                    linked_ticket_nos.len(),
                    if linked_ticket_nos.len() == 1 {
                        "query"
                    } else {
                        "queries"
                    }
                ),
            );
        }
        return (
            OrderRiskLevel::SentWatch,
            "Awaiting supplier or agency acceptance".to_owned(),
        );
    }

    if !linked_ticket_nos.is_empty() {
        return (
            OrderRiskLevel::AcceptedWithMqs,
            format!("Linked to {} open MQS", linked_ticket_nos.len()),
        );
    }

    (
        OrderRiskLevel::Healthy,
        "Accepted with no open MQS".to_owned(),
    )
}

pub fn build_snapshot(state: &FinanceState) -> FinanceSnapshot {
    let mut orders_by_base: HashMap<String, Vec<&PrismaOrder>> = HashMap::new();
    for order in &state.orders {
        let base = if order.order_base.is_empty() {
            normalize_order_ref(&order.order_ver)
        } else {
            normalize_order_ref(&order.order_base)
        };
        if !base.is_empty() {
            orders_by_base.entry(base).or_default().push(order);
        }
    }

    let mut tickets_by_order_base: HashMap<String, Vec<&MqsTicket>> = HashMap::new();
    let mut matched_tickets = Vec::with_capacity(state.tickets.len());

    for ticket in &state.tickets {
        let refs = extract_ticket_order_refs(ticket);
        let mut linked_order: Option<&PrismaOrder> = None;
        for r in &refs {
            tickets_by_order_base
                .entry(r.clone())
                .or_default()
                .push(ticket);
            if linked_order.is_none() {
                if let Some(list) = orders_by_base.get(r) {
                    linked_order = list.first().copied();
                }
            }
        }
        matched_tickets.push(MatchedTicketView {
            ticket: ticket.clone(),
            normalized_refs: refs,
            linked_order_ver: linked_order.map(|o| o.order_ver.clone()),
            linked_order_status: linked_order.map(|o| o.status.clone()),
            linked_campaign: linked_order.map(|o| o.campaign.clone()),
            linked_seller: linked_order.map(|o| o.seller.clone()),
        });
    }

    let mut matched_orders = Vec::with_capacity(state.orders.len());
    for order in &state.orders {
        let base = if order.order_base.is_empty() {
            normalize_order_ref(&order.order_ver)
        } else {
            normalize_order_ref(&order.order_base)
        };
        let linked = tickets_by_order_base
            .get(&base)
            .cloned()
            .unwrap_or_default();
        let mut ticket_nos: Vec<String> = linked.iter().map(|t| t.ticket_no.clone()).collect();
        ticket_nos.sort();
        ticket_nos.dedup();
        let queried_total: f64 = linked.iter().map(|t| t.queried_gross).sum();
        let (risk_level, risk_reason) = classify_order_risk(order, &ticket_nos);
        matched_orders.push(MatchedOrderView {
            order: order.clone(),
            risk_level,
            risk_reason,
            linked_ticket_nos: ticket_nos,
            linked_queried_total: (queried_total * 100.0).round() / 100.0,
        });
    }

    let notify_badge_count = compute_notify_badge_count(state, &matched_tickets, &matched_orders);

    FinanceSnapshot {
        tickets: matched_tickets,
        orders: matched_orders,
        favourites: if state.favourites.is_empty() {
            default_favourites()
        } else {
            state.favourites.clone()
        },
        active_favourite_id: state.active_favourite_id.clone(),
        digest_folder: state.digest_folder.clone(),
        sync_status: state.sync_status.clone(),
        notify_badge_count,
    }
}

fn compute_notify_badge_count(
    state: &FinanceState,
    tickets: &[MatchedTicketView],
    orders: &[MatchedOrderView],
) -> usize {
    let notify_favs: Vec<&FinanceFavouriteFilter> =
        state.favourites.iter().filter(|f| f.notify).collect();
    if notify_favs.is_empty() {
        return 0;
    }

    let mut unique_items = HashSet::new();
    for fav in &notify_favs {
        // Skip empty non-built-in or empty "Me"/"My Team" so unconfigured favourites don't count everyone.
        if fav.id != "all"
            && fav.buyers.is_empty()
            && fav.clients.is_empty()
            && fav.agencies.is_empty()
        {
            continue;
        }
        for t in tickets {
            if ticket_matches_favourite(&t.ticket, fav) {
                unique_items.insert(format!("mqs:{}", t.ticket.ticket_no));
            }
        }
        for o in orders {
            if matches!(
                o.risk_level,
                OrderRiskLevel::AcceptedWithMqs
                    | OrderRiskLevel::Rejected
                    | OrderRiskLevel::SentUrgent
            ) && order_matches_favourite(&o.order, fav)
            {
                unique_items.insert(format!("io:{}", o.order.order_ver));
            }
        }
    }
    unique_items.len()
}

/// Computes newly-arrived alert messages for notification-enabled favourites and updates `notified_keys`.
pub fn collect_new_alerts(state: &mut FinanceState) -> Vec<(String, String)> {
    let snapshot = build_snapshot(state);
    let notify_favs: Vec<FinanceFavouriteFilter> = state
        .favourites
        .iter()
        .filter(|f| f.notify)
        .filter(|f| {
            f.id == "all" || !f.buyers.is_empty() || !f.clients.is_empty() || !f.agencies.is_empty()
        })
        .cloned()
        .collect();
    if notify_favs.is_empty() {
        return Vec::new();
    }

    let mut seen: HashSet<String> = state.notified_keys.iter().cloned().collect();
    let mut alerts = Vec::new();

    for t in &snapshot.tickets {
        let key = format!("mqs:{}", t.ticket.ticket_no);
        if seen.contains(&key) {
            continue;
        }
        if notify_favs
            .iter()
            .any(|fav| ticket_matches_favourite(&t.ticket, fav))
        {
            seen.insert(key.clone());
            state.notified_keys.push(key);
            alerts.push((
                format!("New MQS Query #{}", t.ticket.ticket_no),
                format!(
                    "{} — {} ({} {:.2}): {}",
                    t.ticket.advertiser,
                    t.ticket.payee,
                    t.ticket.currency,
                    t.ticket.queried_gross,
                    t.ticket.reason
                ),
            ));
        }
    }

    for o in &snapshot.orders {
        if !matches!(
            o.risk_level,
            OrderRiskLevel::AcceptedWithMqs | OrderRiskLevel::Rejected | OrderRiskLevel::SentUrgent
        ) {
            continue;
        }
        let key = format!("io:{}:{:?}", o.order.order_ver, o.risk_level);
        if seen.contains(&key) {
            continue;
        }
        if notify_favs
            .iter()
            .any(|fav| order_matches_favourite(&o.order, fav))
        {
            seen.insert(key.clone());
            state.notified_keys.push(key);
            alerts.push((
                format!("Prisma IO Alert: {}", o.order.order_ver),
                format!(
                    "{} ({}) — {}",
                    o.order.campaign, o.order.seller, o.risk_reason
                ),
            ));
        }
    }

    // Keep notified_keys bounded
    if state.notified_keys.len() > 2000 {
        let drain_count = state.notified_keys.len() - 2000;
        state.notified_keys.drain(0..drain_count);
    }

    alerts
}

/// Merges incoming MQS tickets into existing state without clobbering local notes or fresher live rows.
pub fn merge_tickets(existing: &mut Vec<MqsTicket>, incoming: Vec<MqsTicket>, replace_live: bool) {
    let mut by_no: BTreeMap<String, MqsTicket> = BTreeMap::new();
    for t in existing.drain(..) {
        if replace_live && t.source == MqsSource::MxLive {
            // Preserve local notes if re-imported below; otherwise removed live tickets drop off
            continue;
        }
        by_no.insert(t.ticket_no.clone(), t);
    }

    for mut t in incoming {
        if t.ticket_no.trim().is_empty() {
            continue;
        }
        if let Some(prev) = by_no.get(&t.ticket_no) {
            // Don't let an email digest overwrite a live MX row unless live is absent
            if prev.source == MqsSource::MxLive && t.source == MqsSource::EmailDigest {
                continue;
            }
            if t.local_notes.is_empty() && !prev.local_notes.is_empty() {
                t.local_notes = prev.local_notes.clone();
            }
            if t.attachments.is_empty() && !prev.attachments.is_empty() {
                t.attachments = prev.attachments.clone();
            }
        }
        by_no.insert(t.ticket_no.clone(), t);
    }

    *existing = by_no.into_values().collect();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ticket(ticket_no: &str, booking_ref: &str, attachments: Vec<&str>) -> MqsTicket {
        MqsTicket {
            ticket_no: ticket_no.to_owned(),
            to_buyer: "HARRY BARNES".to_owned(),
            advertiser: "CANCER RESEARCH UK".to_owned(),
            payee: "GUARDIAN NEWS & MEDIA LIMITED".to_owned(),
            invoice_no: "2064766".to_owned(),
            created: "23/04/2026".to_owned(),
            line_no: "1".to_owned(),
            currency: "GBP".to_owned(),
            queried_payable: 4697.06,
            queried_gross: 4697.06,
            booking_reference: booking_ref.to_owned(),
            reason: "GROSS COST DISCREPANCY".to_owned(),
            status: "With Buyer".to_owned(),
            priority: "3 - medium".to_owned(),
            owner: "AMOL KADAM".to_owned(),
            operating_co: "MEDIACOM".to_owned(),
            buying_agency: "MEDIACOM LONDON".to_owned(),
            client_code: "CW7".to_owned(),
            issued_date: "31/03/2026".to_owned(),
            invoice_gross: Some(8647.06),
            invoice_net_payable: Some(8647.06),
            invoice_total_payable: Some(10376.47),
            attachments: attachments.into_iter().map(String::from).collect(),
            local_notes: String::new(),
            source: MqsSource::MxLive,
            last_seen_at: "2026-11-26T11:00:00+00:00".to_owned(),
        }
    }

    fn sample_order(order_ver: &str, status: &str, due_label: &str) -> PrismaOrder {
        PrismaOrder {
            order_ver: order_ver.to_owned(),
            order_base: normalize_order_ref(order_ver),
            status: status.to_owned(),
            due_label: due_label.to_owned(),
            due_in_days: None,
            media: "Digital".to_owned(),
            order_type: "Digital".to_owned(),
            seller: "ACAST".to_owned(),
            media_id: "D".to_owned(),
            client_id: "CW7".to_owned(),
            product_id: "5".to_owned(),
            estimate_id: "142".to_owned(),
            order_total: 42482.81,
            currency: "GBP".to_owned(),
            campaign: "26.27 CRUK".to_owned(),
            campaign_id: "CP3M88T".to_owned(),
            dates: "18/1/27 - 14/3/27".to_owned(),
            start_date: "2027-01-18".to_owned(),
            end_date: "2027-03-14".to_owned(),
            buyer: "HARRY BARNES".to_owned(),
            agency: "NGMCLON".to_owned(),
            order_url: String::new(),
            last_seen_at: "2026-11-26T11:00:00+00:00".to_owned(),
        }
    }

    #[test]
    fn normalizes_order_versions_and_extracts_attachment_refs() {
        assert_eq!(normalize_order_ref("O-D35356S-R1"), "O-D35356S");
        assert_eq!(normalize_order_ref("O-D3LONR7-R5"), "O-D3LONR7");
        assert_eq!(normalize_order_ref("O-5JG80"), "O-5JG80");

        let ticket = sample_ticket(
            "137033",
            "",
            vec![
                "Azure-ea1ks44e.eoh-O-D2P0GCL-R1 (4).pdf",
                "Azure-45fm5syz.tvv-O-D2P5NTB-R0 (1).pdf",
            ],
        );
        let refs = extract_ticket_order_refs(&ticket);
        assert_eq!(refs, vec!["O-D2P0GCL".to_owned(), "O-D2P5NTB".to_owned()]);
    }

    #[test]
    fn flags_accepted_order_with_open_mqs() {
        let mut state = FinanceState::default();
        state
            .tickets
            .push(sample_ticket("145674", "O-D35356S", vec![]));
        state
            .orders
            .push(sample_order("O-D35356S-R2", "ACCEPTED", ""));
        state
            .orders
            .push(sample_order("O-D3LONR7-R5", "SENT", "Due in 1 day"));
        state
            .orders
            .push(sample_order("O-D3OV2QT-R0", "ACCEPTED", ""));

        let snapshot = build_snapshot(&state);
        assert_eq!(
            snapshot.orders[0].risk_level,
            OrderRiskLevel::AcceptedWithMqs
        );
        assert_eq!(snapshot.orders[0].linked_ticket_nos, vec!["145674"]);
        assert_eq!(snapshot.orders[1].risk_level, OrderRiskLevel::SentUrgent);
        assert_eq!(snapshot.orders[2].risk_level, OrderRiskLevel::Healthy);
    }

    #[test]
    fn favourite_filter_and_notification_diffing() {
        let mut state = FinanceState::default();
        state.favourites[1].buyers = vec!["HARRY BARNES".to_owned()];
        state
            .tickets
            .push(sample_ticket("137033", "O-D2P0GCL", vec![]));
        let alerts = collect_new_alerts(&mut state);
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].0.contains("137033"));

        // Second pass should not duplicate already-notified alerts
        let alerts_again = collect_new_alerts(&mut state);
        assert!(alerts_again.is_empty());
    }
}
