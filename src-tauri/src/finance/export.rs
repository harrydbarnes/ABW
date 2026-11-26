use crate::finance::{
    order_matches_favourite, ticket_matches_favourite, FinanceFavouriteFilter, FinanceSnapshot,
    MatchedOrderView, MatchedTicketView, OrderRiskLevel,
};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

enum CellVal {
    Text(String),
    Number(f64),
}

fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Strip illegal XML 1.0 control chars
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

fn col_letter(mut col_idx: usize) -> String {
    let mut letters = Vec::new();
    loop {
        let rem = col_idx % 26;
        letters.push((b'A' + rem as u8) as char);
        if col_idx < 26 {
            break;
        }
        col_idx = col_idx / 26 - 1;
    }
    letters.into_iter().rev().collect()
}

fn build_sheet_xml(rows: &[Vec<CellVal>]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>"#,
    );
    for (r_idx, row) in rows.iter().enumerate() {
        let row_num = r_idx + 1;
        xml.push_str(&format!(r#"<row r="{row_num}">"#));
        for (c_idx, cell) in row.iter().enumerate() {
            let cell_ref = format!("{}{}", col_letter(c_idx), row_num);
            let style = if r_idx == 0 { r#" s="1""# } else { "" };
            match cell {
                CellVal::Text(s) => {
                    xml.push_str(&format!(
                        r#"<c r="{cell_ref}" t="inlineStr"{style}><is><t>{}</t></is></c>"#,
                        xml_escape(s)
                    ));
                }
                CellVal::Number(n) => {
                    let num_style = if r_idx == 0 { r#" s="1""# } else { r#" s="2""# };
                    if n.is_finite() {
                        xml.push_str(&format!(
                            r#"<c r="{cell_ref}"{num_style}><v>{n:.2}</v></c>"#
                        ));
                    } else {
                        xml.push_str(&format!(r#"<c r="{cell_ref}"{style}/>"#));
                    }
                }
            }
        }
        xml.push_str("</row>");
    }
    xml.push_str("</sheetData></worksheet>");
    xml
}

fn risk_label(level: &OrderRiskLevel) -> &'static str {
    match level {
        OrderRiskLevel::AcceptedWithMqs => "ACCEPTED + OPEN MQS",
        OrderRiskLevel::Rejected => "REJECTED",
        OrderRiskLevel::SentUrgent => "SENT (URGENT)",
        OrderRiskLevel::SentWatch => "SENT (WATCH)",
        OrderRiskLevel::Healthy => "ACCEPTED",
    }
}

pub fn export_xlsx(
    snapshot: &FinanceSnapshot,
    favourite: &FinanceFavouriteFilter,
    exported_at: &str,
    dest: &Path,
) -> Result<usize, String> {
    let tickets: Vec<&MatchedTicketView> = snapshot
        .tickets
        .iter()
        .filter(|t| ticket_matches_favourite(&t.ticket, favourite))
        .collect();
    let orders: Vec<&MatchedOrderView> = snapshot
        .orders
        .iter()
        .filter(|o| order_matches_favourite(&o.order, favourite))
        .collect();

    let at_risk_orders: Vec<&MatchedOrderView> = orders
        .iter()
        .copied()
        .filter(|o| o.risk_level != OrderRiskLevel::Healthy)
        .collect();

    let linked_tickets: Vec<&MatchedTicketView> = tickets
        .iter()
        .copied()
        .filter(|t| t.linked_order_ver.is_some())
        .collect();

    // Sheet 1: Summary KPIs
    let mut totals_by_currency: BTreeMap<String, f64> = BTreeMap::new();
    for t in &tickets {
        *totals_by_currency
            .entry(if t.ticket.currency.is_empty() {
                "GBP".to_owned()
            } else {
                t.ticket.currency.clone()
            })
            .or_insert(0.0) += t.ticket.queried_gross;
    }

    let accepted_with_mqs = orders
        .iter()
        .filter(|o| o.risk_level == OrderRiskLevel::AcceptedWithMqs)
        .count();
    let rejected_count = orders
        .iter()
        .filter(|o| o.risk_level == OrderRiskLevel::Rejected)
        .count();
    let sent_urgent_count = orders
        .iter()
        .filter(|o| o.risk_level == OrderRiskLevel::SentUrgent)
        .count();

    let mut summary_rows: Vec<Vec<CellVal>> = vec![
        vec![
            CellVal::Text("Metric".to_owned()),
            CellVal::Text("Value".to_owned()),
        ],
        vec![
            CellVal::Text("Active Favourite Filter".to_owned()),
            CellVal::Text(favourite.name.clone()),
        ],
        vec![
            CellVal::Text("Exported At (UTC)".to_owned()),
            CellVal::Text(exported_at.to_owned()),
        ],
        vec![
            CellVal::Text("Open MQS Queries".to_owned()),
            CellVal::Number(tickets.len() as f64),
        ],
        vec![
            CellVal::Text("At-Risk Prisma IOs".to_owned()),
            CellVal::Number(at_risk_orders.len() as f64),
        ],
        vec![
            CellVal::Text("Accepted IOs with Open MQS".to_owned()),
            CellVal::Number(accepted_with_mqs as f64),
        ],
        vec![
            CellVal::Text("Rejected IOs".to_owned()),
            CellVal::Number(rejected_count as f64),
        ],
        vec![
            CellVal::Text("Sent Urgent IOs (<= 3 days / overdue)".to_owned()),
            CellVal::Number(sent_urgent_count as f64),
        ],
        vec![
            CellVal::Text("Matched MQS <-> Prisma Links".to_owned()),
            CellVal::Number(linked_tickets.len() as f64),
        ],
    ];
    for (curr, total) in totals_by_currency {
        summary_rows.push(vec![
            CellVal::Text(format!("Total Queried Gross ({curr})")),
            CellVal::Number(total),
        ]);
    }

    // Sheet 2: MQS Queries
    let mut mqs_rows: Vec<Vec<CellVal>> = vec![vec![
        CellVal::Text("Ticket No.".to_owned()),
        CellVal::Text("To Buyer".to_owned()),
        CellVal::Text("Advertiser".to_owned()),
        CellVal::Text("Payee".to_owned()),
        CellVal::Text("Invoice No.".to_owned()),
        CellVal::Text("Created".to_owned()),
        CellVal::Text("Currency".to_owned()),
        CellVal::Text("Queried Payable".to_owned()),
        CellVal::Text("Queried Gross".to_owned()),
        CellVal::Text("Booking Reference".to_owned()),
        CellVal::Text("Reason".to_owned()),
        CellVal::Text("Status".to_owned()),
        CellVal::Text("Linked Prisma Order".to_owned()),
        CellVal::Text("Linked Order Status".to_owned()),
        CellVal::Text("Notes".to_owned()),
    ]];
    for m in &tickets {
        let t = &m.ticket;
        mqs_rows.push(vec![
            CellVal::Text(t.ticket_no.clone()),
            CellVal::Text(t.to_buyer.clone()),
            CellVal::Text(t.advertiser.clone()),
            CellVal::Text(t.payee.clone()),
            CellVal::Text(t.invoice_no.clone()),
            CellVal::Text(t.created.clone()),
            CellVal::Text(t.currency.clone()),
            CellVal::Number(t.queried_payable),
            CellVal::Number(t.queried_gross),
            CellVal::Text(t.booking_reference.clone()),
            CellVal::Text(t.reason.clone()),
            CellVal::Text(t.status.clone()),
            CellVal::Text(m.linked_order_ver.clone().unwrap_or_default()),
            CellVal::Text(m.linked_order_status.clone().unwrap_or_default()),
            CellVal::Text(t.local_notes.clone()),
        ]);
    }

    // Sheet 3: At-Risk IOs
    let mut io_rows: Vec<Vec<CellVal>> = vec![vec![
        CellVal::Text("Order / Ver".to_owned()),
        CellVal::Text("Risk Flag".to_owned()),
        CellVal::Text("Order Status".to_owned()),
        CellVal::Text("Due".to_owned()),
        CellVal::Text("Seller".to_owned()),
        CellVal::Text("Client ID".to_owned()),
        CellVal::Text("Estimate ID".to_owned()),
        CellVal::Text("Order Total".to_owned()),
        CellVal::Text("Campaign".to_owned()),
        CellVal::Text("Dates".to_owned()),
        CellVal::Text("Buyer".to_owned()),
        CellVal::Text("Open MQS Tickets".to_owned()),
        CellVal::Text("Risk Reason".to_owned()),
    ]];
    for o in &at_risk_orders {
        io_rows.push(vec![
            CellVal::Text(o.order.order_ver.clone()),
            CellVal::Text(risk_label(&o.risk_level).to_owned()),
            CellVal::Text(o.order.status.clone()),
            CellVal::Text(o.order.due_label.clone()),
            CellVal::Text(o.order.seller.clone()),
            CellVal::Text(o.order.client_id.clone()),
            CellVal::Text(o.order.estimate_id.clone()),
            CellVal::Number(o.order.order_total),
            CellVal::Text(o.order.campaign.clone()),
            CellVal::Text(o.order.dates.clone()),
            CellVal::Text(o.order.buyer.clone()),
            CellVal::Text(o.linked_ticket_nos.join(", ")),
            CellVal::Text(o.risk_reason.clone()),
        ]);
    }

    // Sheet 4: Linked Matches
    let mut match_rows: Vec<Vec<CellVal>> = vec![vec![
        CellVal::Text("MQS Ticket".to_owned()),
        CellVal::Text("Invoice No.".to_owned()),
        CellVal::Text("MQS Reason".to_owned()),
        CellVal::Text("Queried Gross".to_owned()),
        CellVal::Text("Prisma Order / Ver".to_owned()),
        CellVal::Text("Prisma Status".to_owned()),
        CellVal::Text("Campaign".to_owned()),
        CellVal::Text("Seller".to_owned()),
        CellVal::Text("To Buyer".to_owned()),
    ]];
    for m in &linked_tickets {
        match_rows.push(vec![
            CellVal::Text(m.ticket.ticket_no.clone()),
            CellVal::Text(m.ticket.invoice_no.clone()),
            CellVal::Text(m.ticket.reason.clone()),
            CellVal::Number(m.ticket.queried_gross),
            CellVal::Text(m.linked_order_ver.clone().unwrap_or_default()),
            CellVal::Text(m.linked_order_status.clone().unwrap_or_default()),
            CellVal::Text(m.linked_campaign.clone().unwrap_or_default()),
            CellVal::Text(m.linked_seller.clone().unwrap_or_default()),
            CellVal::Text(m.ticket.to_buyer.clone()),
        ]);
    }

    let file = File::create(dest).map_err(|e| format!("Could not create export file: {e}"))?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let entries: Vec<(&str, String)> = vec![
        (
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#
                .to_owned(),
        ),
        (
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#
                .to_owned(),
        ),
        (
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary KPIs" sheetId="1" r:id="rId1"/>
    <sheet name="MQS Queries" sheetId="2" r:id="rId2"/>
    <sheet name="At-Risk IOs" sheetId="3" r:id="rId3"/>
    <sheet name="Linked Matches" sheetId="4" r:id="rId4"/>
  </sheets>
</workbook>"#
                .to_owned(),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#
                .to_owned(),
        ),
        (
            "xl/styles.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>"#
                .to_owned(),
        ),
        ("xl/worksheets/sheet1.xml", build_sheet_xml(&summary_rows)),
        ("xl/worksheets/sheet2.xml", build_sheet_xml(&mqs_rows)),
        ("xl/worksheets/sheet3.xml", build_sheet_xml(&io_rows)),
        ("xl/worksheets/sheet4.xml", build_sheet_xml(&match_rows)),
    ];

    for (name, content) in entries {
        zip.start_file(name, opts)
            .map_err(|e| format!("Failed writing {name}: {e}"))?;
        zip.write_all(content.as_bytes())
            .map_err(|e| format!("Failed writing {name}: {e}"))?;
    }

    zip.finish()
        .map_err(|e| format!("Failed finalizing workbook: {e}"))?;

    Ok(tickets.len() + at_risk_orders.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::finance::{build_snapshot, default_favourites, FinanceState};
    use crate::spreadsheet;

    #[test]
    fn generates_valid_multi_sheet_xlsx_readable_by_spreadsheet_engine() {
        let state = FinanceState::default();
        let snap = build_snapshot(&state);
        let fav = &default_favourites()[0];
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("finance-pack.xlsx");
        export_xlsx(&snap, fav, "2026-11-26T12:00:00+00:00", &out).unwrap();

        let preview = spreadsheet::preview_file(&out).unwrap();
        assert_eq!(preview.sheets.len(), 4);
        assert_eq!(preview.sheets[0].name, "Summary KPIs");
        assert_eq!(preview.sheets[1].name, "MQS Queries");
        assert_eq!(preview.sheets[2].name, "At-Risk IOs");
        assert_eq!(preview.sheets[3].name, "Linked Matches");
    }
}
