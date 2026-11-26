use calamine::{open_workbook_auto, Reader};
use quick_xml::{
    escape::resolve_xml_entity,
    events::{BytesStart, Event},
    Reader as XmlReader, XmlVersion,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};
use zip::ZipArchive;

pub const MAX_SPREADSHEET_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SPREADSHEET_EXPANDED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_SPREADSHEET_ARCHIVE_ENTRIES: u16 = 2_048;
const MAX_SPREADSHEET_COMPRESSION_RATIO: u64 = 100;
const MIN_SPREADSHEET_RATIO_CHECK_BYTES: u64 = 256 * 1024;
const MAX_SPREADSHEET_SHEETS: usize = 128;
const MAX_SPREADSHEET_ROWS: usize = 500;
const MAX_SPREADSHEET_COLUMNS: usize = 50;
const MAX_SPREADSHEET_ROW_SCAN: usize = 10_000;
const MAX_SPREADSHEET_COLUMN_SCAN: usize = 2_000;
const MAX_XML_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SHARED_STRINGS: usize = 200_000;
const MAX_SHEET_IMAGES: usize = 24;
const MAX_SINGLE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookPreview {
    pub sheets: Vec<WorkbookSheet>,
    pub active_sheet: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<WorkbookCellStyle>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookImage {
    pub data_url: String,
    pub left_px: f64,
    pub top_px: f64,
    pub width_px: f64,
    pub height_px: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookSheet {
    pub name: String,
    pub columns: Vec<WorkbookColumn>,
    pub rows: Vec<WorkbookRow>,
    #[serde(skip_serializing_if = "is_false")]
    pub truncated_rows: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub truncated_columns: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub has_images: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub deferred: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookColumn {
    pub index: usize,
    pub label: String,
    pub width_px: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookRow {
    pub index: usize,
    pub height_px: u32,
    pub cells: Vec<WorkbookCell>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookCell {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col_span: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_span: Option<usize>,
    #[serde(skip_serializing_if = "is_false")]
    pub covered_by_merge: bool,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct WorkbookCellStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_decoration: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub white_space: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_top: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_right: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_bottom: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border_left: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub fn preview_file(path: &Path) -> Result<WorkbookPreview, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Unable to inspect spreadsheet: {error}"))?
        .len();
    if size > MAX_SPREADSHEET_PREVIEW_BYTES {
        return Err(format!(
            "This spreadsheet is {} MB. In-app preview supports files up to 64 MB; open it in Windows instead.",
            size.div_ceil(1024 * 1024)
        ));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    if matches!(extension.as_str(), "csv" | "tsv") {
        return load_delimited_spreadsheet(path, extension == "tsv");
    }

    if matches!(
        extension.as_str(),
        "xlsx" | "xlsm" | "xltx" | "xltm" | "xlsb" | "ods"
    ) {
        let mut file =
            File::open(path).map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
        validate_spreadsheet_archive_file(&mut file)?;
        if matches!(extension.as_str(), "xlsx" | "xlsm" | "xltx" | "xltm") {
            file.seek(SeekFrom::Start(0))
                .map_err(|error| format!("Unable to read spreadsheet: {error}"))?;
            match load_styled_ooxml(file) {
                Ok(preview) => return Ok(preview),
                Err(PreviewParseOutcome::Safety(message)) => return Err(message),
                Err(PreviewParseOutcome::Fallback) => {
                    // Fall back to calamine for unusual or partially damaged OOXML workbooks.
                }
            }
        }
    }

    load_calamine_fallback(path)
}

fn load_calamine_fallback(path: &Path) -> Result<WorkbookPreview, String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
    let sheet_names = workbook.sheet_names().to_owned();
    if sheet_names.len() > MAX_SPREADSHEET_SHEETS {
        return Err(format!(
            "This spreadsheet has {} sheets. In-app preview supports up to {MAX_SPREADSHEET_SHEETS}; open it in Windows instead.",
            sheet_names.len()
        ));
    }
    let sheets = sheet_names
        .into_iter()
        .map(|name| {
            let mut truncated_rows = false;
            let mut truncated_columns = false;
            let mut rows = Vec::new();
            let mut width = 0usize;
            if let Ok(range) = workbook.worksheet_range(&name) {
                rows.reserve(MAX_SPREADSHEET_ROWS.min(range.height()));
                for (row_idx, row) in range.rows().enumerate() {
                    if row_idx >= MAX_SPREADSHEET_ROWS {
                        truncated_rows = true;
                        break;
                    }
                    if row.len() > MAX_SPREADSHEET_COLUMNS {
                        truncated_columns = true;
                    }
                    let row_width = row.len().min(MAX_SPREADSHEET_COLUMNS);
                    width = width.max(row_width);
                    let cells = row[..row_width]
                        .iter()
                        .map(|cell| WorkbookCell {
                            value: cell.to_string(),
                            style_index: None,
                            col_span: None,
                            row_span: None,
                            covered_by_merge: false,
                        })
                        .collect();
                    rows.push(WorkbookRow {
                        index: row_idx + 1,
                        height_px: 31,
                        cells,
                    });
                }
            }
            for row in &mut rows {
                if row.cells.len() < width {
                    row.cells.resize_with(width, || WorkbookCell {
                        value: String::new(),
                        style_index: None,
                        col_span: None,
                        row_span: None,
                        covered_by_merge: false,
                    });
                }
            }
            let columns = (1..=width)
                .map(|index| WorkbookColumn {
                    index,
                    label: to_column_label(index),
                    width_px: if index == 1 { 176 } else { 98 },
                })
                .collect();
            WorkbookSheet {
                name,
                columns,
                rows,
                truncated_rows,
                truncated_columns,
                has_images: false,
                deferred: false,
            }
        })
        .collect();
    Ok(WorkbookPreview {
        sheets,
        active_sheet: 0,
        styles: Vec::new(),
    })
}

fn load_delimited_spreadsheet(path: &Path, force_tab: bool) -> Result<WorkbookPreview, String> {
    use std::io::BufRead;

    let file = File::open(path).map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut probe_buf = Vec::with_capacity(2048);
    let bytes_read = reader
        .read_until(b'\n', &mut probe_buf)
        .map_err(|error| format!("Unable to read delimited spreadsheet: {error}"))?;
    let sample = if bytes_read > 0 {
        String::from_utf8_lossy(&probe_buf).into_owned()
    } else {
        String::new()
    };

    let delimiter = if force_tab {
        b'\t'
    } else {
        detect_csv_delimiter(sample.trim_start_matches('\u{feff}'))
    };

    // Rewind to byte 0 and read incrementally until we have enough rows for the preview budget.
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("Unable to read delimited spreadsheet: {error}"))?;

    let max_read_bytes = (8 * 1024 * 1024_usize).min(MAX_SPREADSHEET_PREVIEW_BYTES as usize);
    let mut raw_bytes = Vec::with_capacity(32 * 1024);
    let mut line_buf = Vec::with_capacity(4096);
    let mut approx_rows = 0usize;
    let mut in_quotes = false;
    let mut hit_byte_cap = false;

    loop {
        line_buf.clear();
        let read = reader
            .read_until(b'\n', &mut line_buf)
            .map_err(|error| format!("Unable to read delimited spreadsheet: {error}"))?;
        if read == 0 {
            break;
        }
        if raw_bytes.len().saturating_add(read) > max_read_bytes {
            let remaining = max_read_bytes.saturating_sub(raw_bytes.len());
            raw_bytes.extend_from_slice(&line_buf[..remaining]);
            hit_byte_cap = true;
            break;
        }
        for &byte in &line_buf {
            if byte == b'"' {
                in_quotes = !in_quotes;
            }
        }
        raw_bytes.extend_from_slice(&line_buf);
        if !in_quotes {
            approx_rows += 1;
            if approx_rows > MAX_SPREADSHEET_ROWS + 1 {
                hit_byte_cap = true;
                break;
            }
        }
    }

    let decoded = String::from_utf8_lossy(&raw_bytes);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);

    let (parsed_rows, max_cols, truncated_rows, truncated_columns) =
        parse_delimited_rows(text, delimiter as char, hit_byte_cap);

    let width = max_cols.min(MAX_SPREADSHEET_COLUMNS);
    let mut col_max_chars = vec![0usize; width];
    for row in &parsed_rows {
        for (col_idx, value) in row.iter().take(width).enumerate() {
            let char_count = value.chars().count();
            if char_count > col_max_chars[col_idx] {
                col_max_chars[col_idx] = char_count;
            }
        }
    }

    let columns = (0..width)
        .map(|col_idx| {
            let index = col_idx + 1;
            let chars = col_max_chars[col_idx].clamp(8, 36) as u32;
            WorkbookColumn {
                index,
                label: to_column_label(index),
                width_px: (chars * 7 + 22).clamp(78, 280),
            }
        })
        .collect();

    let has_header = !parsed_rows.is_empty();
    let styles = if has_header {
        vec![WorkbookCellStyle {
            background_color: Some("#f7f9fd".to_owned()),
            color: Some("#35445c".to_owned()),
            font_weight: Some(700),
            white_space: Some("nowrap".to_owned()),
            ..WorkbookCellStyle::default()
        }]
    } else {
        Vec::new()
    };

    let rows = parsed_rows
        .into_iter()
        .enumerate()
        .map(|(row_idx, mut row_values)| {
            let style_index = (row_idx == 0).then_some(0);
            if row_values.len() < width {
                row_values.resize_with(width, String::new);
            } else if row_values.len() > width {
                row_values.truncate(width);
            }
            let cells = row_values
                .into_iter()
                .map(|value| WorkbookCell {
                    value,
                    style_index,
                    col_span: None,
                    row_span: None,
                    covered_by_merge: false,
                })
                .collect();
            WorkbookRow {
                index: row_idx + 1,
                height_px: 31,
                cells,
            }
        })
        .collect();

    let sheet_name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(if force_tab { "TSV" } else { "CSV" })
        .to_owned();

    Ok(WorkbookPreview {
        sheets: vec![WorkbookSheet {
            name: sheet_name,
            columns,
            rows,
            truncated_rows,
            truncated_columns,
            has_images: false,
            deferred: false,
        }],
        active_sheet: 0,
        styles,
    })
}

fn detect_csv_delimiter(first_line: &str) -> u8 {
    let mut commas = 0usize;
    let mut tabs = 0usize;
    let mut semicolons = 0usize;
    let mut in_quotes = false;
    for byte in first_line.bytes() {
        match byte {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => commas += 1,
            b'\t' if !in_quotes => tabs += 1,
            b';' if !in_quotes => semicolons += 1,
            b'\n' | b'\r' => break,
            _ => {}
        }
    }
    if tabs > commas && tabs >= semicolons {
        b'\t'
    } else if semicolons > commas {
        b';'
    } else {
        b','
    }
}

fn parse_delimited_rows(
    text: &str,
    delimiter: char,
    hit_byte_cap: bool,
) -> (Vec<Vec<String>>, usize, bool, bool) {
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(64);
    let mut current_row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut max_cols = 0usize;
    let mut truncated_rows = hit_byte_cap;
    let mut truncated_columns = false;

    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }

        if at_field_start && ch == '"' {
            in_quotes = true;
            at_field_start = false;
            continue;
        }

        if ch == delimiter {
            if current_row.len() < MAX_SPREADSHEET_COLUMNS {
                current_row.push(std::mem::take(&mut field));
            } else {
                field.clear();
                truncated_columns = true;
            }
            at_field_start = true;
            continue;
        }

        if ch == '\r' || ch == '\n' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            if current_row.len() < MAX_SPREADSHEET_COLUMNS {
                current_row.push(std::mem::take(&mut field));
            } else {
                field.clear();
                truncated_columns = true;
            }
            if !(current_row.len() == 1 && current_row[0].is_empty()) {
                if rows.len() >= MAX_SPREADSHEET_ROWS {
                    truncated_rows = true;
                    current_row.clear();
                    break;
                }
                max_cols = max_cols.max(current_row.len());
                rows.push(std::mem::take(&mut current_row));
            } else {
                current_row.clear();
            }
            at_field_start = true;
            continue;
        }

        at_field_start = false;
        field.push(ch);
    }

    if !truncated_rows && (!field.is_empty() || !current_row.is_empty()) {
        if current_row.len() < MAX_SPREADSHEET_COLUMNS {
            current_row.push(field);
        } else {
            truncated_columns = true;
        }
        if !(current_row.len() == 1 && current_row[0].is_empty()) {
            if rows.len() >= MAX_SPREADSHEET_ROWS {
                truncated_rows = true;
            } else {
                max_cols = max_cols.max(current_row.len());
                rows.push(current_row);
            }
        }
    }

    (rows, max_cols, truncated_rows, truncated_columns)
}

#[derive(Debug)]
enum PreviewParseOutcome {
    Safety(String),
    Fallback,
}

#[cfg(test)]
pub fn validate_spreadsheet_archive(path: &Path) -> Result<(), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Unable to inspect spreadsheet archive: {error}"))?;
    validate_spreadsheet_archive_file(&mut file)
}

fn validate_spreadsheet_archive_file(file: &mut File) -> Result<(), String> {
    const EOCD_SIGNATURE: u32 = 0x0605_4b50;
    const CENTRAL_DIRECTORY_SIGNATURE: u32 = 0x0201_4b50;
    const MAX_EOCD_SEARCH: u64 = 65_557;

    let length = file
        .metadata()
        .map_err(|error| format!("Unable to inspect spreadsheet archive: {error}"))?
        .len();
    let tail_length = length.min(MAX_EOCD_SEARCH) as usize;
    file.seek(SeekFrom::End(-(tail_length as i64)))
        .map_err(|error| format!("Unable to inspect spreadsheet archive: {error}"))?;
    let mut tail = vec![0; tail_length];
    file.read_exact(&mut tail)
        .map_err(|error| format!("Unable to inspect spreadsheet archive: {error}"))?;
    let eocd = tail
        .windows(4)
        .rposition(|window| {
            u32::from_le_bytes(window.try_into().unwrap_or_default()) == EOCD_SIGNATURE
        })
        .ok_or_else(|| "This spreadsheet archive is invalid or unsupported.".to_owned())?;
    if eocd + 22 > tail.len() {
        return Err("This spreadsheet archive is invalid or unsupported.".into());
    }
    let entries = u16::from_le_bytes(tail[eocd + 10..eocd + 12].try_into().unwrap_or_default());
    let central_size =
        u32::from_le_bytes(tail[eocd + 12..eocd + 16].try_into().unwrap_or_default()) as u64;
    let central_offset =
        u32::from_le_bytes(tail[eocd + 16..eocd + 20].try_into().unwrap_or_default()) as u64;
    if entries > MAX_SPREADSHEET_ARCHIVE_ENTRIES
        || central_offset.saturating_add(central_size) > length
    {
        return Err("This spreadsheet is too complex for safe in-app preview.".into());
    }
    file.seek(SeekFrom::Start(central_offset))
        .map_err(|error| format!("Unable to inspect spreadsheet archive: {error}"))?;
    let mut compressed_total = 0_u64;
    let mut expanded_total = 0_u64;
    for _ in 0..entries {
        let mut header = [0_u8; 46];
        file.read_exact(&mut header)
            .map_err(|_| "This spreadsheet archive is invalid or unsupported.".to_owned())?;
        if u32::from_le_bytes(header[0..4].try_into().unwrap_or_default())
            != CENTRAL_DIRECTORY_SIGNATURE
        {
            return Err("This spreadsheet archive is invalid or unsupported.".into());
        }
        let compressed = u32::from_le_bytes(header[20..24].try_into().unwrap_or_default());
        let expanded = u32::from_le_bytes(header[24..28].try_into().unwrap_or_default());
        if compressed == u32::MAX || expanded == u32::MAX {
            return Err("ZIP64 spreadsheets are not supported for in-app preview.".into());
        }
        compressed_total = compressed_total.saturating_add(compressed as u64);
        expanded_total = expanded_total.saturating_add(expanded as u64);
        if expanded_total > MAX_SPREADSHEET_EXPANDED_BYTES
            || (expanded_total >= MIN_SPREADSHEET_RATIO_CHECK_BYTES
                && compressed_total > 0
                && expanded_total / compressed_total > MAX_SPREADSHEET_COMPRESSION_RATIO)
        {
            return Err("This spreadsheet expands beyond the safe in-app preview limit.".into());
        }
        let name_length = u16::from_le_bytes(header[28..30].try_into().unwrap_or_default()) as i64;
        let extra_length = u16::from_le_bytes(header[30..32].try_into().unwrap_or_default()) as i64;
        let comment_length =
            u16::from_le_bytes(header[32..34].try_into().unwrap_or_default()) as i64;
        file.seek(SeekFrom::Current(
            name_length + extra_length + comment_length,
        ))
        .map_err(|_| "This spreadsheet archive is invalid or unsupported.".to_owned())?;
    }
    Ok(())
}

fn optional_ooxml_part<T: Default>(
    result: Result<T, PreviewParseOutcome>,
) -> Result<T, PreviewParseOutcome> {
    match result {
        Ok(value) => Ok(value),
        Err(PreviewParseOutcome::Safety(message)) => Err(PreviewParseOutcome::Safety(message)),
        Err(PreviewParseOutcome::Fallback) => Ok(T::default()),
    }
}

struct OoxmlContext {
    archive: ZipArchive<BufReader<File>>,
    entry_lookup: HashMap<String, usize>,
    workbook_meta: WorkbookMeta,
    rels: HashMap<String, String>,
    shared_strings: Vec<String>,
    stylesheet: Stylesheet,
    palette: Vec<WorkbookCellStyle>,
    xf_style_indices: Vec<Option<usize>>,
}

fn load_ooxml_context(file: File) -> Result<OoxmlContext, PreviewParseOutcome> {
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|_| PreviewParseOutcome::Fallback)?;
    let mut entry_lookup = HashMap::with_capacity(archive.len());
    for idx in 0..archive.len() {
        if let Some(Ok(name)) = archive.name_for_index(idx) {
            entry_lookup.insert(name.to_ascii_lowercase(), idx);
        }
    }

    let workbook_idx = *entry_lookup
        .get("xl/workbook.xml")
        .ok_or(PreviewParseOutcome::Fallback)?;
    let workbook_meta = parse_workbook(&mut archive, workbook_idx)?;
    if workbook_meta.sheets.len() > MAX_SPREADSHEET_SHEETS {
        return Err(PreviewParseOutcome::Safety(format!(
            "This spreadsheet has {} sheets. In-app preview supports up to {MAX_SPREADSHEET_SHEETS}; open it in Windows instead.",
            workbook_meta.sheets.len()
        )));
    }

    let rels = match entry_lookup.get("xl/_rels/workbook.xml.rels").copied() {
        Some(idx) => optional_ooxml_part(parse_workbook_rels(&mut archive, idx))?,
        None => HashMap::new(),
    };

    let shared_strings = match entry_lookup.get("xl/sharedstrings.xml").copied() {
        Some(idx) => optional_ooxml_part(parse_shared_strings(&mut archive, idx))?,
        None => Vec::new(),
    };

    let theme_colors = match entry_lookup.get("xl/theme/theme1.xml").copied() {
        Some(idx) => match parse_theme_colors(&mut archive, idx) {
            Ok(colors) => colors,
            Err(PreviewParseOutcome::Safety(message)) => {
                return Err(PreviewParseOutcome::Safety(message))
            }
            Err(PreviewParseOutcome::Fallback) => DEFAULT_THEME_COLORS,
        },
        None => DEFAULT_THEME_COLORS,
    };

    let stylesheet = match entry_lookup.get("xl/styles.xml").copied() {
        Some(idx) => optional_ooxml_part(parse_styles(&mut archive, idx, &theme_colors))?,
        None => Stylesheet::default(),
    };
    let (palette, xf_style_indices) = stylesheet.build_palette();

    Ok(OoxmlContext {
        archive,
        entry_lookup,
        workbook_meta,
        rels,
        shared_strings,
        stylesheet,
        palette,
        xf_style_indices,
    })
}

fn load_styled_ooxml(file: File) -> Result<WorkbookPreview, PreviewParseOutcome> {
    let mut ctx = load_ooxml_context(file)?;

    let visible_sheets: Vec<(usize, WorkbookSheetEntry)> = ctx
        .workbook_meta
        .sheets
        .iter()
        .enumerate()
        .filter(|(_, sheet)| sheet.visible)
        .map(|(idx, sheet)| (idx, sheet.clone()))
        .collect();

    let active_sheet = visible_sheets
        .iter()
        .position(|(original_idx, _)| *original_idx == ctx.workbook_meta.active_tab)
        .unwrap_or(0);

    let mut resolved_targets = Vec::with_capacity(visible_sheets.len());
    for (_, sheet_entry) in &visible_sheets {
        let Some(target) = ctx.rels.get(&sheet_entry.rel_id) else {
            return Err(PreviewParseOutcome::Fallback);
        };
        let Some(&sheet_idx) = ctx.entry_lookup.get(&target.to_ascii_lowercase()) else {
            return Err(PreviewParseOutcome::Fallback);
        };
        resolved_targets.push((sheet_entry.name.clone(), target.clone(), sheet_idx));
    }

    let defer_inactive = resolved_targets.len() > 1;
    let mut sheets = Vec::with_capacity(resolved_targets.len());
    for (visible_idx, (name, target, sheet_idx)) in resolved_targets.into_iter().enumerate() {
        if defer_inactive && visible_idx != active_sheet {
            sheets.push(WorkbookSheet {
                name,
                columns: Vec::new(),
                rows: Vec::new(),
                truncated_rows: false,
                truncated_columns: false,
                has_images: false,
                deferred: true,
            });
            continue;
        }
        let has_images = sheet_has_images(&mut ctx.archive, &ctx.entry_lookup, &target);
        let mut sheet = parse_worksheet(
            &mut ctx.archive,
            sheet_idx,
            &name,
            &ctx.shared_strings,
            &ctx.stylesheet,
            &ctx.xf_style_indices,
            ctx.workbook_meta.date_1904,
        )?;
        sheet.has_images = has_images;
        sheets.push(sheet);
    }

    let styles = if defer_inactive {
        ctx.palette
    } else {
        // Prune styles not referenced by any rendered cell when all sheets are already parsed.
        let mut remapped_styles = Vec::new();
        let mut style_remap: Vec<Option<usize>> = vec![None; ctx.palette.len()];
        for sheet in &mut sheets {
            for row in &mut sheet.rows {
                for cell in &mut row.cells {
                    if let Some(old_idx) = cell.style_index {
                        if let Some(slot) = style_remap.get_mut(old_idx) {
                            let new_idx = match *slot {
                                Some(existing) => existing,
                                None => {
                                    let idx = remapped_styles.len();
                                    remapped_styles.push(ctx.palette[old_idx].clone());
                                    *slot = Some(idx);
                                    idx
                                }
                            };
                            cell.style_index = Some(new_idx);
                        } else {
                            cell.style_index = None;
                        }
                    }
                }
            }
        }
        remapped_styles
    };

    Ok(WorkbookPreview {
        sheets,
        active_sheet,
        styles,
    })
}

pub fn load_sheet(path: &Path, sheet_index: usize) -> Result<WorkbookSheet, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Unable to inspect spreadsheet: {error}"))?
        .len();
    if size > MAX_SPREADSHEET_PREVIEW_BYTES {
        return Err(format!(
            "This spreadsheet is {} MB. In-app preview supports files up to 64 MB; open it in Windows instead.",
            size.div_ceil(1024 * 1024)
        ));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "xlsx" | "xlsm" | "xltx" | "xltm") {
        return Err("On-demand sheet loading is only supported for OOXML workbooks.".into());
    }
    let mut file =
        File::open(path).map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
    validate_spreadsheet_archive_file(&mut file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Unable to read spreadsheet: {error}"))?;

    let mut ctx = load_ooxml_context(file).map_err(|outcome| match outcome {
        PreviewParseOutcome::Safety(msg) => msg,
        PreviewParseOutcome::Fallback => "Unable to load worksheet.".to_owned(),
    })?;
    let sheet_entry = ctx
        .workbook_meta
        .sheets
        .iter()
        .filter(|sheet| sheet.visible)
        .nth(sheet_index)
        .cloned()
        .ok_or_else(|| "Requested worksheet was not found.".to_owned())?;
    let target = ctx
        .rels
        .get(&sheet_entry.rel_id)
        .cloned()
        .ok_or_else(|| "Unable to locate worksheet data.".to_owned())?;
    let &sheet_idx = ctx
        .entry_lookup
        .get(&target.to_ascii_lowercase())
        .ok_or_else(|| "Unable to locate worksheet entry.".to_owned())?;
    let has_images = sheet_has_images(&mut ctx.archive, &ctx.entry_lookup, &target);
    let mut sheet = parse_worksheet(
        &mut ctx.archive,
        sheet_idx,
        &sheet_entry.name,
        &ctx.shared_strings,
        &ctx.stylesheet,
        &ctx.xf_style_indices,
        ctx.workbook_meta.date_1904,
    )
    .map_err(|outcome| match outcome {
        PreviewParseOutcome::Safety(msg) => msg,
        PreviewParseOutcome::Fallback => "Unable to parse worksheet.".to_owned(),
    })?;
    sheet.has_images = has_images;
    sheet.deferred = false;
    Ok(sheet)
}

struct WorkbookMeta {
    active_tab: usize,
    date_1904: bool,
    sheets: Vec<WorkbookSheetEntry>,
}

#[derive(Clone)]
struct WorkbookSheetEntry {
    name: String,
    rel_id: String,
    visible: bool,
}

fn open_xml<'a, R: Read + Seek>(
    archive: &'a mut ZipArchive<R>,
    idx: usize,
) -> Result<XmlReader<BufReader<std::io::Take<zip::read::ZipFile<'a, R>>>>, PreviewParseOutcome> {
    let file = archive
        .by_index(idx)
        .map_err(|_| PreviewParseOutcome::Fallback)?;
    if file.size() > MAX_XML_ENTRY_BYTES {
        return Err(PreviewParseOutcome::Safety(
            "This spreadsheet expands beyond the safe in-app preview limit.".into(),
        ));
    }
    let mut reader = XmlReader::from_reader(BufReader::new(file.take(MAX_XML_ENTRY_BYTES + 1)));
    reader.config_mut().trim_text(false);
    Ok(reader)
}

fn attr_value(element: &BytesStart<'_>, local: &str) -> Option<String> {
    for attr in element.attributes().flatten() {
        if attr.key.local_name().as_ref() == local {
            if let Ok(value) = attr.normalized_value(XmlVersion::Implicit1_0) {
                return Some(value.into_owned());
            }
        }
    }
    None
}

fn push_general_ref(buf: &mut String, reference: &quick_xml::events::BytesRef<'_>) {
    if let Ok(Some(ch)) = reference.resolve_char_ref() {
        buf.push(ch);
    } else if let Some(entity) = resolve_xml_entity(reference.as_ref()) {
        buf.push_str(entity);
    }
}

fn append_text_until_end<R: std::io::BufRead>(
    reader: &mut XmlReader<R>,
    end_name: &str,
    buf: &mut Vec<u8>,
    out: &mut String,
) -> Result<(), PreviewParseOutcome> {
    loop {
        buf.clear();
        match reader
            .read_event_into(buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Text(t) => out.push_str(&t.xml10_content()),
            Event::CData(c) => out.push_str(&c.xml10_content()),
            Event::GeneralRef(r) => push_general_ref(out, &r),
            Event::End(end) if end.local_name().as_ref() == end_name => break,
            Event::Eof => return Err(PreviewParseOutcome::Fallback),
            _ => {}
        }
    }
    Ok(())
}

fn skip_element_with_buf<R: std::io::BufRead>(
    reader: &mut XmlReader<R>,
    buf: &mut Vec<u8>,
) -> Result<(), PreviewParseOutcome> {
    let mut depth = 1usize;
    loop {
        buf.clear();
        match reader
            .read_event_into(buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            Event::Eof => return Err(PreviewParseOutcome::Fallback),
            _ => {}
        }
    }
    Ok(())
}

fn parse_workbook<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<WorkbookMeta, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut active_tab = 0usize;
    let mut date_1904 = false;
    let mut sheets = Vec::new();
    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) | Event::Empty(ref e) => match e.local_name().as_ref() {
                "workbookView" => {
                    if let Some(val) = attr_value(e, "activeTab") {
                        active_tab = val.parse().unwrap_or(0);
                    }
                }
                "workbookPr" => {
                    if let Some(val) = attr_value(e, "date1904") {
                        date_1904 = val == "1" || val.eq_ignore_ascii_case("true");
                    }
                }
                "sheet" => {
                    let name = attr_value(e, "name").unwrap_or_default();
                    let rel_id = attr_value(e, "id").unwrap_or_default();
                    let state = attr_value(e, "state").unwrap_or_default();
                    let visible = state.is_empty() || state.eq_ignore_ascii_case("visible");
                    sheets.push(WorkbookSheetEntry {
                        name,
                        rel_id,
                        visible,
                    });
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(WorkbookMeta {
        active_tab,
        date_1904,
        sheets,
    })
}

fn parse_workbook_rels<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<HashMap<String, String>, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut rels = HashMap::new();
    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) | Event::Empty(ref e)
                if e.local_name().as_ref() == "Relationship" =>
            {
                if let (Some(id), Some(target)) = (attr_value(e, "Id"), attr_value(e, "Target")) {
                    let normalized = normalize_xl_target(&target);
                    rels.insert(id, normalized);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(rels)
}

fn normalize_xl_target(target: &str) -> String {
    let trimmed = target.trim_start_matches('/');
    if trimmed.starts_with("xl/") {
        trimmed.to_owned()
    } else if let Some(rest) = trimmed.strip_prefix("../") {
        rest.to_owned()
    } else {
        format!("xl/{trimmed}")
    }
}

fn parse_shared_strings<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<Vec<String>, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut text_buf = Vec::with_capacity(256);
    let mut strings = Vec::new();
    let mut in_si = false;
    let mut current = String::new();

    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) => match e.local_name().as_ref() {
                "si" => {
                    if strings.len() >= MAX_SHARED_STRINGS {
                        break;
                    }
                    in_si = true;
                    current.clear();
                }
                "rPh" | "extLst" => {
                    skip_element_with_buf(&mut reader, &mut text_buf)?;
                }
                "t" if in_si => {
                    append_text_until_end(&mut reader, "t", &mut text_buf, &mut current)?;
                }
                _ => {}
            },
            Event::Empty(ref e) => {
                if e.local_name().as_ref() == "si" && strings.len() < MAX_SHARED_STRINGS {
                    strings.push(String::new());
                }
            }
            Event::End(ref e) => {
                if e.local_name().as_ref() == "si" && in_si {
                    in_si = false;
                    strings.push(std::mem::take(&mut current));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(strings)
}

const DEFAULT_THEME_COLORS: [(u8, u8, u8); 12] = [
    (0xff, 0xff, 0xff), // 0: lt1
    (0x00, 0x00, 0x00), // 1: dk1
    (0xe7, 0xe6, 0xe6), // 2: lt2
    (0x44, 0x54, 0x6a), // 3: dk2
    (0x5b, 0x9b, 0xd5), // 4: accent1
    (0xed, 0x7d, 0x31), // 5: accent2
    (0xa5, 0xa5, 0xa5), // 6: accent3
    (0xff, 0xc0, 0x00), // 7: accent4
    (0x44, 0x72, 0xc4), // 8: accent5
    (0x70, 0xad, 0x47), // 9: accent6
    (0x05, 0x63, 0xc1), // 10: hlink
    (0x95, 0x4f, 0x72), // 11: folHlink
];

fn extract_theme_slot_rgb(element: &BytesStart<'_>) -> Option<(u8, u8, u8)> {
    let mut val_rgb = None;
    for attr in element.attributes().flatten() {
        let key = attr.key.local_name();
        if key.as_ref() == "lastClr" {
            if let Some(rgb) = parse_hex_rgb(attr.value.as_ref()) {
                return Some(rgb);
            }
        } else if key.as_ref() == "val" {
            val_rgb = parse_hex_rgb(attr.value.as_ref());
        }
    }
    val_rgb
}

fn parse_theme_colors<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<[(u8, u8, u8); 12], PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut palette = DEFAULT_THEME_COLORS;
    let mut in_scheme = false;
    let mut current_slot: Option<usize> = None;

    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) => match e.local_name().as_ref() {
                "clrScheme" => in_scheme = true,
                "lt1" if in_scheme => current_slot = Some(0),
                "dk1" if in_scheme => current_slot = Some(1),
                "lt2" if in_scheme => current_slot = Some(2),
                "dk2" if in_scheme => current_slot = Some(3),
                "accent1" if in_scheme => current_slot = Some(4),
                "accent2" if in_scheme => current_slot = Some(5),
                "accent3" if in_scheme => current_slot = Some(6),
                "accent4" if in_scheme => current_slot = Some(7),
                "accent5" if in_scheme => current_slot = Some(8),
                "accent6" if in_scheme => current_slot = Some(9),
                "hlink" if in_scheme => current_slot = Some(10),
                "folHlink" if in_scheme => current_slot = Some(11),
                "srgbClr" | "sysClr" => {
                    if let Some(slot) = current_slot {
                        if let Some(rgb) = extract_theme_slot_rgb(e) {
                            palette[slot] = rgb;
                        }
                    }
                }
                _ => {}
            },
            Event::Empty(ref e) => {
                if let Some(slot) = current_slot {
                    if matches!(e.local_name().as_ref(), "srgbClr" | "sysClr") {
                        if let Some(rgb) = extract_theme_slot_rgb(e) {
                            palette[slot] = rgb;
                        }
                    }
                }
            }
            Event::End(ref e) => match e.local_name().as_ref() {
                "clrScheme" => break,
                "dk1" | "lt1" | "dk2" | "lt2" | "accent1" | "accent2" | "accent3" | "accent4"
                | "accent5" | "accent6" | "hlink" | "folHlink" => {
                    current_slot = None;
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(palette)
}

#[derive(Clone, Default)]
struct ParsedFont {
    name: Option<String>,
    size: Option<f64>,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    color: Option<String>,
}

#[derive(Clone, Default)]
struct ParsedBorderSide {
    style: Option<String>,
    color: Option<String>,
}

#[derive(Clone, Default)]
struct ParsedBorder {
    left: ParsedBorderSide,
    right: ParsedBorderSide,
    top: ParsedBorderSide,
    bottom: ParsedBorderSide,
}

#[derive(Clone, Default)]
struct ParsedXf {
    num_fmt_id: u32,
    font_id: usize,
    fill_id: usize,
    border_id: usize,
    horizontal: Option<String>,
    vertical: Option<String>,
    wrap_text: bool,
}

#[derive(Default)]
struct Stylesheet {
    num_fmts: HashMap<u32, String>,
    fonts: Vec<ParsedFont>,
    fills: Vec<Option<String>>,
    borders: Vec<ParsedBorder>,
    cell_xfs: Vec<ParsedXf>,
}

impl Stylesheet {
    fn format_code(&self, num_fmt_id: u32) -> Option<&str> {
        self.num_fmts
            .get(&num_fmt_id)
            .map(String::as_str)
            .or_else(|| builtin_num_fmt(num_fmt_id))
    }

    fn css_style(&self, xf_idx: usize) -> Option<WorkbookCellStyle> {
        let xf = self.cell_xfs.get(xf_idx)?;
        let mut style = WorkbookCellStyle::default();
        if let Some(Some(bg)) = self.fills.get(xf.fill_id) {
            style.background_color = Some(bg.clone());
        }
        if let Some(font) = self.fonts.get(xf.font_id) {
            style.color = font.color.clone();
            style.font_family = font.name.clone();
            if let Some(sz) = font.size {
                style.font_size = Some(format!("{sz}pt"));
            }
            if font.bold {
                style.font_weight = Some(700);
            }
            if font.italic {
                style.font_style = Some("italic".to_owned());
            }
            match (font.underline, font.strike) {
                (true, true) => style.text_decoration = Some("underline line-through".to_owned()),
                (true, false) => style.text_decoration = Some("underline".to_owned()),
                (false, true) => style.text_decoration = Some("line-through".to_owned()),
                (false, false) => {}
            }
        }
        if let Some(horiz) = xf.horizontal.as_deref() {
            style.text_align = Some(normalize_horizontal(horiz).to_owned());
        }
        if let Some(vert) = xf.vertical.as_deref() {
            style.vertical_align = Some(normalize_vertical(vert).to_owned());
        }
        if xf.wrap_text {
            style.white_space = Some("normal".to_owned());
        } else {
            style.white_space = Some("nowrap".to_owned());
        }
        if let Some(border) = self.borders.get(xf.border_id) {
            style.border_top = format_border_side(&border.top);
            style.border_right = format_border_side(&border.right);
            style.border_bottom = format_border_side(&border.bottom);
            style.border_left = format_border_side(&border.left);
        }

        let has_extra = style.background_color.is_some()
            || style.color.is_some()
            || style.font_family.is_some()
            || style.font_size.is_some()
            || style.font_weight.is_some()
            || style.font_style.is_some()
            || style.text_decoration.is_some()
            || style.text_align.is_some()
            || style.vertical_align.is_some()
            || style.border_top.is_some()
            || style.border_right.is_some()
            || style.border_bottom.is_some()
            || style.border_left.is_some()
            || xf.wrap_text;
        has_extra.then_some(style)
    }

    fn build_palette(&self) -> (Vec<WorkbookCellStyle>, Vec<Option<usize>>) {
        let mut palette = Vec::new();
        let mut lookup: HashMap<WorkbookCellStyle, usize> = HashMap::new();
        let mut xf_map = Vec::with_capacity(self.cell_xfs.len());
        for xf_idx in 0..self.cell_xfs.len() {
            let mapped = self.css_style(xf_idx).map(|style| {
                if let Some(&existing) = lookup.get(&style) {
                    existing
                } else {
                    let index = palette.len();
                    lookup.insert(style.clone(), index);
                    palette.push(style);
                    index
                }
            });
            xf_map.push(mapped);
        }
        (palette, xf_map)
    }
}

fn format_border_side(side: &ParsedBorderSide) -> Option<String> {
    let border_style = side.style.as_deref()?;
    if border_style.eq_ignore_ascii_case("none") || border_style.is_empty() {
        return None;
    }
    let width = if border_style.contains("medium") {
        2
    } else if border_style == "thick" {
        3
    } else {
        1
    };
    let line_style = if border_style == "double" {
        "double"
    } else if border_style.contains("dash") {
        "dashed"
    } else if border_style == "dotted" {
        "dotted"
    } else {
        "solid"
    };
    let color = side.color.as_deref().unwrap_or("#cbd2dc");
    Some(format!("{width}px {line_style} {color}"))
}

fn normalize_horizontal(value: &str) -> &'static str {
    match value {
        "right" => "right",
        "center" | "centerContinuous" => "center",
        "justify" | "distributed" => "justify",
        _ => "left",
    }
}

fn normalize_vertical(value: &str) -> &'static str {
    match value {
        "top" => "top",
        "center" | "middle" => "middle",
        _ => "bottom",
    }
}

#[derive(PartialEq, Eq)]
enum StylesSection {
    Root,
    Fonts,
    Fills,
    Borders,
    CellXfs,
}

#[derive(PartialEq, Eq)]
enum BorderSideTarget {
    Left,
    Right,
    Top,
    Bottom,
}

fn parse_styles<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
    theme: &[(u8, u8, u8); 12],
) -> Result<Stylesheet, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut skip_buf = Vec::with_capacity(256);
    let mut styles = Stylesheet::default();
    let mut section = StylesSection::Root;
    let mut current_font: Option<ParsedFont> = None;
    let mut in_fill = false;
    let mut current_fill_solid = false;
    let mut current_fill_color: Option<String> = None;
    let mut current_border: Option<ParsedBorder> = None;
    let mut current_border_side: Option<BorderSideTarget> = None;
    let mut current_xf: Option<ParsedXf> = None;

    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) => match e.local_name().as_ref() {
                "extLst" => skip_element_with_buf(&mut reader, &mut skip_buf)?,
                "fonts" => section = StylesSection::Fonts,
                "fills" => section = StylesSection::Fills,
                "borders" => section = StylesSection::Borders,
                "cellXfs" => section = StylesSection::CellXfs,
                "numFmt" => record_num_fmt(e, &mut styles.num_fmts),
                "font" if section == StylesSection::Fonts => {
                    current_font = Some(ParsedFont::default());
                }
                "fill" if section == StylesSection::Fills => {
                    in_fill = true;
                    current_fill_solid = false;
                    current_fill_color = None;
                }
                "patternFill" if in_fill => {
                    current_fill_solid = attr_eq(e, "patternType", "solid");
                }
                "border" if section == StylesSection::Borders => {
                    current_border = Some(ParsedBorder::default());
                }
                "left" if current_border.is_some() => {
                    current_border_side = Some(BorderSideTarget::Left);
                    if let Some(border) = current_border.as_mut() {
                        border.left.style = attr_value(e, "style");
                    }
                }
                "right" if current_border.is_some() => {
                    current_border_side = Some(BorderSideTarget::Right);
                    if let Some(border) = current_border.as_mut() {
                        border.right.style = attr_value(e, "style");
                    }
                }
                "top" if current_border.is_some() => {
                    current_border_side = Some(BorderSideTarget::Top);
                    if let Some(border) = current_border.as_mut() {
                        border.top.style = attr_value(e, "style");
                    }
                }
                "bottom" if current_border.is_some() => {
                    current_border_side = Some(BorderSideTarget::Bottom);
                    if let Some(border) = current_border.as_mut() {
                        border.bottom.style = attr_value(e, "style");
                    }
                }
                "xf" if section == StylesSection::CellXfs => {
                    current_xf = Some(parse_xf_attrs(e));
                }
                _ => handle_style_leaf(
                    e,
                    theme,
                    &mut current_font,
                    in_fill && current_fill_solid,
                    &mut current_fill_color,
                    current_border.as_mut().zip(current_border_side.as_ref()),
                    current_xf.as_mut(),
                ),
            },
            Event::Empty(ref e) => match e.local_name().as_ref() {
                "numFmt" => record_num_fmt(e, &mut styles.num_fmts),
                "font" if section == StylesSection::Fonts => {
                    styles.fonts.push(ParsedFont::default());
                }
                "fill" if section == StylesSection::Fills => {
                    styles.fills.push(None);
                }
                "patternFill" if in_fill => {
                    current_fill_solid = attr_eq(e, "patternType", "solid");
                }
                "border" if section == StylesSection::Borders => {
                    styles.borders.push(ParsedBorder::default());
                }
                "left" if current_border.is_some() => {
                    if let Some(border) = current_border.as_mut() {
                        border.left.style = attr_value(e, "style");
                    }
                }
                "right" if current_border.is_some() => {
                    if let Some(border) = current_border.as_mut() {
                        border.right.style = attr_value(e, "style");
                    }
                }
                "top" if current_border.is_some() => {
                    if let Some(border) = current_border.as_mut() {
                        border.top.style = attr_value(e, "style");
                    }
                }
                "bottom" if current_border.is_some() => {
                    if let Some(border) = current_border.as_mut() {
                        border.bottom.style = attr_value(e, "style");
                    }
                }
                "xf" if section == StylesSection::CellXfs => {
                    styles.cell_xfs.push(parse_xf_attrs(e));
                }
                _ => handle_style_leaf(
                    e,
                    theme,
                    &mut current_font,
                    in_fill && current_fill_solid,
                    &mut current_fill_color,
                    current_border.as_mut().zip(current_border_side.as_ref()),
                    current_xf.as_mut(),
                ),
            },
            Event::End(ref e) => match e.local_name().as_ref() {
                "fonts" | "fills" | "borders" | "cellXfs" => section = StylesSection::Root,
                "font" => {
                    if let Some(font) = current_font.take() {
                        styles.fonts.push(font);
                    }
                }
                "fill" => {
                    if in_fill {
                        styles.fills.push(if current_fill_solid {
                            current_fill_color.take()
                        } else {
                            None
                        });
                    }
                    in_fill = false;
                    current_fill_solid = false;
                    current_fill_color = None;
                }
                "left" | "right" | "top" | "bottom" => current_border_side = None,
                "border" => {
                    if let Some(border) = current_border.take() {
                        styles.borders.push(border);
                    }
                }
                "xf" => {
                    if let Some(xf) = current_xf.take() {
                        styles.cell_xfs.push(xf);
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(styles)
}

fn with_attr<T>(element: &BytesStart<'_>, local: &str, f: impl FnOnce(&str) -> T) -> Option<T> {
    element
        .attributes()
        .flatten()
        .find(|attr| attr.key.local_name().as_ref() == local)
        .map(|attr| f(attr.value.as_ref()))
}

fn attr_eq(element: &BytesStart<'_>, local: &str, expected: &str) -> bool {
    with_attr(element, local, |val| val == expected).unwrap_or(false)
}

fn record_num_fmt(element: &BytesStart<'_>, num_fmts: &mut HashMap<u32, String>) {
    let mut id = None;
    let mut code = None;
    for attr in element.attributes().flatten() {
        match attr.key.local_name().as_ref() {
            "numFmtId" => id = attr.value.as_ref().parse::<u32>().ok(),
            "formatCode" => {
                code = attr
                    .normalized_value(XmlVersion::Implicit1_0)
                    .ok()
                    .map(|value| value.into_owned());
            }
            _ => {}
        }
    }
    if let (Some(id), Some(code)) = (id, code) {
        num_fmts.insert(id, code);
    }
}

fn parse_xf_attrs(e: &BytesStart<'_>) -> ParsedXf {
    let mut xf = ParsedXf::default();
    for attr in e.attributes().flatten() {
        let val = attr.value.as_ref();
        match attr.key.local_name().as_ref() {
            "numFmtId" => {
                if let Ok(parsed) = val.parse::<u32>() {
                    xf.num_fmt_id = parsed;
                }
            }
            "fontId" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    xf.font_id = parsed;
                }
            }
            "fillId" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    xf.fill_id = parsed;
                }
            }
            "borderId" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    xf.border_id = parsed;
                }
            }
            _ => {}
        }
    }
    xf
}

fn handle_style_leaf(
    e: &BytesStart<'_>,
    theme: &[(u8, u8, u8); 12],
    current_font: &mut Option<ParsedFont>,
    accept_fill_fg: bool,
    current_fill_color: &mut Option<String>,
    border_target: Option<(&mut ParsedBorder, &BorderSideTarget)>,
    current_xf: Option<&mut ParsedXf>,
) {
    match e.local_name().as_ref() {
        "name" => {
            if let Some(font) = current_font.as_mut() {
                font.name = attr_value(e, "val");
            }
        }
        "sz" => {
            if let Some(font) = current_font.as_mut() {
                font.size = with_attr(e, "val", |s| s.parse().ok()).flatten();
            }
        }
        "b" => {
            if let Some(font) = current_font.as_mut() {
                font.bold = with_attr(e, "val", |val| val != "0" && val != "false").unwrap_or(true);
            }
        }
        "i" => {
            if let Some(font) = current_font.as_mut() {
                font.italic =
                    with_attr(e, "val", |val| val != "0" && val != "false").unwrap_or(true);
            }
        }
        "u" => {
            if let Some(font) = current_font.as_mut() {
                font.underline = with_attr(e, "val", |val| val != "none").unwrap_or(true);
            }
        }
        "strike" => {
            if let Some(font) = current_font.as_mut() {
                font.strike =
                    with_attr(e, "val", |val| val != "0" && val != "false").unwrap_or(true);
            }
        }
        "fgColor" if accept_fill_fg => {
            *current_fill_color = resolve_ooxml_color(e, theme);
        }
        "color" => {
            if let Some(font) = current_font.as_mut() {
                font.color = resolve_ooxml_color(e, theme);
            } else if let Some((border, side)) = border_target {
                let color = resolve_ooxml_color(e, theme);
                match side {
                    BorderSideTarget::Left => border.left.color = color,
                    BorderSideTarget::Right => border.right.color = color,
                    BorderSideTarget::Top => border.top.color = color,
                    BorderSideTarget::Bottom => border.bottom.color = color,
                }
            }
        }
        "alignment" => {
            if let Some(xf) = current_xf {
                for attr in e.attributes().flatten() {
                    let val = attr.value.as_ref();
                    match attr.key.local_name().as_ref() {
                        "horizontal" => xf.horizontal = Some(val.to_owned()),
                        "vertical" => xf.vertical = Some(val.to_owned()),
                        "wrapText" => xf.wrap_text = is_xml_true(val),
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

fn resolve_ooxml_color(e: &BytesStart<'_>, theme: &[(u8, u8, u8); 12]) -> Option<String> {
    let mut tint = 0.0_f64;
    let mut transparent_rgb = false;
    let mut parsed_rgb: Option<(u8, u8, u8)> = None;
    let mut theme_idx: Option<usize> = None;
    let mut indexed: Option<usize> = None;
    for attr in e.attributes().flatten() {
        let val = attr.value.as_ref();
        match attr.key.local_name().as_ref() {
            "tint" => tint = val.parse::<f64>().unwrap_or(0.0),
            "rgb" => {
                let hex = val.trim_start_matches('#');
                if hex.len() == 8 && hex.starts_with("00") {
                    transparent_rgb = true;
                } else if hex.is_ascii() && hex.len() >= 6 {
                    parsed_rgb = parse_hex_rgb(&hex[hex.len() - 6..]);
                }
            }
            "theme" => theme_idx = val.parse::<usize>().ok(),
            "indexed" => indexed = val.parse::<usize>().ok(),
            _ => {}
        }
    }
    if transparent_rgb {
        return None;
    }
    if let Some(rgb) = parsed_rgb {
        return Some(format_rgb(apply_tint(rgb, tint)));
    }
    if let Some(idx) = theme_idx {
        if let Some(&base) = theme.get(idx) {
            return Some(format_rgb(apply_tint(base, tint)));
        }
    }
    if let Some(idx) = indexed {
        if let Some(rgb) = INDEXED_COLORS.get(idx).copied().flatten() {
            return Some(format_rgb(apply_tint(rgb, tint)));
        }
    }
    None
}

fn parse_hex_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    if !hex.is_ascii() || hex.len() < 6 {
        return None;
    }
    let slice = &hex[hex.len() - 6..];
    let r = u8::from_str_radix(&slice[0..2], 16).ok()?;
    let g = u8::from_str_radix(&slice[2..4], 16).ok()?;
    let b = u8::from_str_radix(&slice[4..6], 16).ok()?;
    Some((r, g, b))
}

fn apply_tint((r, g, b): (u8, u8, u8), tint: f64) -> (u8, u8, u8) {
    if tint.abs() < f64::EPSILON {
        return (r, g, b);
    }
    let adjust = |channel: u8| -> u8 {
        let value = channel as f64;
        let tinted = if tint < 0.0 {
            value * (1.0 + tint)
        } else {
            value + (255.0 - value) * tint
        };
        tinted.round().clamp(0.0, 255.0) as u8
    };
    (adjust(r), adjust(g), adjust(b))
}

fn format_rgb((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

#[derive(Clone, Copy)]
struct ColDef {
    min: usize,
    max: usize,
    width: Option<f64>,
    hidden: bool,
}

struct ParsedRow {
    index: usize,
    height_px: u32,
    cells: HashMap<usize, WorkbookCell>,
}

#[derive(Clone, Copy)]
enum CellValueKind {
    SharedString,
    InlineOrStr,
    Boolean,
    Numeric,
}

struct RowAttrs {
    row_num: usize,
    hidden: bool,
    height_px: u32,
}

fn parse_row_attrs(element: &BytesStart<'_>, fallback_row_num: usize) -> RowAttrs {
    let mut row_num = fallback_row_num;
    let mut hidden = false;
    let mut height_pt = 15.0_f64;
    for attr in element.attributes().flatten() {
        let val = attr.value.as_ref();
        match attr.key.local_name().as_ref() {
            "r" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    row_num = parsed;
                }
            }
            "hidden" => hidden = is_xml_true(val),
            "ht" => {
                if let Ok(parsed) = val.parse::<f64>() {
                    height_pt = parsed;
                }
            }
            _ => {}
        }
    }
    RowAttrs {
        row_num,
        hidden,
        height_px: ((height_pt * 96.0) / 72.0).round().clamp(20.0, 180.0) as u32,
    }
}

fn parse_cell_attrs(
    element: &BytesStart<'_>,
    fallback_col: usize,
) -> (usize, CellValueKind, usize) {
    let mut col_idx = fallback_col;
    let mut kind = CellValueKind::Numeric;
    let mut style_idx = 0usize;
    for attr in element.attributes().flatten() {
        let val = attr.value.as_ref();
        match attr.key.local_name().as_ref() {
            "r" => {
                if let Some((_, c)) = parse_cell_address(val) {
                    col_idx = c;
                }
            }
            "t" => {
                kind = match val {
                    "s" => CellValueKind::SharedString,
                    "inlineStr" | "str" | "e" => CellValueKind::InlineOrStr,
                    "b" => CellValueKind::Boolean,
                    _ => CellValueKind::Numeric,
                };
            }
            "s" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    style_idx = parsed;
                }
            }
            _ => {}
        }
    }
    (col_idx, kind, style_idx)
}

fn parse_worksheet<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
    sheet_name: &str,
    shared_strings: &[String],
    styles: &Stylesheet,
    xf_style_indices: &[Option<usize>],
    date_1904: bool,
) -> Result<WorkbookSheet, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(1024);
    let mut cell_buf = Vec::with_capacity(512);
    let mut text_buf = Vec::with_capacity(256);
    let mut col_defs: Vec<ColDef> = Vec::new();
    let mut rows: Vec<ParsedRow> = Vec::with_capacity(64);
    let mut merges: Vec<(usize, usize, usize, usize)> = Vec::new();
    let mut max_seen_col = 0usize;
    let mut prev_row_num = 0usize;
    let mut stop_rows = false;
    let mut truncated_rows = false;

    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) => match e.local_name().as_ref() {
                "extLst" => skip_element_with_buf(&mut reader, &mut cell_buf)?,
                "col" => push_col_def(e, &mut col_defs, &mut max_seen_col),
                "row" => {
                    let row_attrs = parse_row_attrs(e, prev_row_num + 1);
                    prev_row_num = row_attrs.row_num;
                    if stop_rows
                        || row_attrs.hidden
                        || row_attrs.row_num > MAX_SPREADSHEET_ROW_SCAN
                        || rows.len() >= MAX_SPREADSHEET_ROWS
                    {
                        if !row_attrs.hidden
                            && (row_attrs.row_num > MAX_SPREADSHEET_ROW_SCAN
                                || rows.len() >= MAX_SPREADSHEET_ROWS)
                        {
                            stop_rows = true;
                            truncated_rows = true;
                        }
                        skip_element_with_buf(&mut reader, &mut cell_buf)?;
                    } else {
                        let cells = parse_row_cells(
                            &mut reader,
                            shared_strings,
                            styles,
                            xf_style_indices,
                            date_1904,
                            &mut max_seen_col,
                            &mut cell_buf,
                            &mut text_buf,
                        )?;
                        rows.push(ParsedRow {
                            index: row_attrs.row_num,
                            height_px: row_attrs.height_px,
                            cells,
                        });
                    }
                }
                "mergeCell" => {
                    if let Some(range) = with_attr(e, "ref", parse_cell_range).flatten() {
                        merges.push(range);
                    }
                }
                _ => {}
            },
            Event::Empty(ref e) => match e.local_name().as_ref() {
                "col" => push_col_def(e, &mut col_defs, &mut max_seen_col),
                "row" => {
                    let row_attrs = parse_row_attrs(e, prev_row_num + 1);
                    prev_row_num = row_attrs.row_num;
                    if !row_attrs.hidden {
                        if stop_rows
                            || row_attrs.row_num > MAX_SPREADSHEET_ROW_SCAN
                            || rows.len() >= MAX_SPREADSHEET_ROWS
                        {
                            stop_rows = true;
                            truncated_rows = true;
                        } else {
                            rows.push(ParsedRow {
                                index: row_attrs.row_num,
                                height_px: row_attrs.height_px,
                                cells: HashMap::new(),
                            });
                        }
                    }
                }
                "mergeCell" => {
                    if let Some(range) = with_attr(e, "ref", parse_cell_range).flatten() {
                        merges.push(range);
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }

    let max_col = max_seen_col.min(MAX_SPREADSHEET_COLUMN_SCAN);
    let mut visible_col_indexes = Vec::with_capacity(max_col.min(MAX_SPREADSHEET_COLUMNS));
    let mut columns = Vec::with_capacity(max_col.min(MAX_SPREADSHEET_COLUMNS));
    let mut truncated_columns = max_seen_col > MAX_SPREADSHEET_COLUMN_SCAN;
    for col_idx in 1..=max_col {
        let col_info = lookup_col_def(&col_defs, col_idx);
        if col_info.is_some_and(|def| def.hidden) {
            continue;
        }
        if visible_col_indexes.len() >= MAX_SPREADSHEET_COLUMNS {
            truncated_columns = true;
            break;
        }
        let width_chars = col_info.and_then(|def| def.width).unwrap_or(12.0);
        let width_px = (width_chars * 7.0 + 12.0).round().clamp(38.0, 320.0) as u32;
        visible_col_indexes.push(col_idx);
        columns.push(WorkbookColumn {
            index: col_idx,
            label: to_column_label(col_idx),
            width_px,
        });
    }

    let visible_row_indexes: Vec<usize> = rows.iter().map(|row| row.index).collect();
    let visible_row_set: HashSet<usize> = visible_row_indexes.iter().copied().collect();
    let visible_col_set: HashSet<usize> = visible_col_indexes.iter().copied().collect();

    let mut covered: HashSet<(usize, usize)> = HashSet::new();
    let mut spans: HashMap<(usize, usize), (usize, usize)> = HashMap::new();
    for (start_row, start_col, end_row, end_col) in merges {
        if !visible_row_set.contains(&start_row) || !visible_col_set.contains(&start_col) {
            continue;
        }
        let merged_rows: Vec<usize> = visible_row_indexes
            .iter()
            .copied()
            .filter(|&r| r >= start_row && r <= end_row)
            .collect();
        let merged_cols: Vec<usize> = visible_col_indexes
            .iter()
            .copied()
            .filter(|&c| c >= start_col && c <= end_col)
            .collect();
        if merged_rows.is_empty() || merged_cols.is_empty() {
            continue;
        }
        spans.insert(
            (start_row, start_col),
            (merged_cols.len(), merged_rows.len()),
        );
        for &r in &merged_rows {
            for &c in &merged_cols {
                if r != start_row || c != start_col {
                    covered.insert((r, c));
                }
            }
        }
    }

    let built_rows = rows
        .into_iter()
        .map(|mut parsed_row| {
            let cells = visible_col_indexes
                .iter()
                .map(|&col_idx| {
                    let mut cell = parsed_row.cells.remove(&col_idx).unwrap_or(WorkbookCell {
                        value: String::new(),
                        style_index: None,
                        col_span: None,
                        row_span: None,
                        covered_by_merge: false,
                    });
                    if let Some(&(col_span, row_span)) = spans.get(&(parsed_row.index, col_idx)) {
                        cell.col_span = Some(col_span);
                        cell.row_span = Some(row_span);
                    }
                    if covered.contains(&(parsed_row.index, col_idx)) {
                        cell.covered_by_merge = true;
                    }
                    cell
                })
                .collect();
            WorkbookRow {
                index: parsed_row.index,
                height_px: parsed_row.height_px,
                cells,
            }
        })
        .collect();

    Ok(WorkbookSheet {
        name: sheet_name.to_owned(),
        columns,
        rows: built_rows,
        truncated_rows,
        truncated_columns,
        has_images: false,
        deferred: false,
    })
}

fn push_col_def(e: &BytesStart<'_>, col_defs: &mut Vec<ColDef>, max_seen_col: &mut usize) {
    let mut min = 1usize;
    let mut max: Option<usize> = None;
    let mut width: Option<f64> = None;
    let mut hidden = false;
    for attr in e.attributes().flatten() {
        let val = attr.value.as_ref();
        match attr.key.local_name().as_ref() {
            "min" => {
                if let Ok(parsed) = val.parse::<usize>() {
                    min = parsed;
                }
            }
            "max" => max = val.parse::<usize>().ok(),
            "width" => width = val.parse::<f64>().ok(),
            "hidden" => hidden = is_xml_true(val),
            _ => {}
        }
    }
    let max = max.unwrap_or(min);
    if max.saturating_sub(min) < 200 {
        *max_seen_col = (*max_seen_col).max(max.min(MAX_SPREADSHEET_COLUMN_SCAN));
    }
    col_defs.push(ColDef {
        min,
        max,
        width,
        hidden,
    });
}

fn lookup_col_def(col_defs: &[ColDef], col_idx: usize) -> Option<ColDef> {
    col_defs
        .iter()
        .rev()
        .find(|def| col_idx >= def.min && col_idx <= def.max)
        .copied()
}

#[allow(clippy::too_many_arguments)]
fn parse_row_cells<R: std::io::BufRead>(
    reader: &mut XmlReader<R>,
    shared_strings: &[String],
    styles: &Stylesheet,
    xf_style_indices: &[Option<usize>],
    date_1904: bool,
    max_seen_col: &mut usize,
    buf: &mut Vec<u8>,
    text_buf: &mut Vec<u8>,
) -> Result<HashMap<usize, WorkbookCell>, PreviewParseOutcome> {
    let mut cells = HashMap::new();
    let mut prev_col = 0usize;
    let mut current_col: Option<usize> = None;
    let mut current_kind = CellValueKind::Numeric;
    let mut current_style_idx = 0usize;
    let mut current_value = String::new();
    let mut in_is = false;

    loop {
        buf.clear();
        match reader
            .read_event_into(buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) => match e.local_name().as_ref() {
                "c" => {
                    let (col_idx, kind, style_idx) = parse_cell_attrs(e, prev_col + 1);
                    prev_col = col_idx;
                    current_col = Some(col_idx);
                    current_kind = kind;
                    current_style_idx = style_idx;
                    current_value.clear();
                    in_is = false;
                }
                "v" if current_col.is_some() => {
                    current_value.clear();
                    append_text_until_end(reader, "v", text_buf, &mut current_value)?;
                }
                "is" if current_col.is_some() => {
                    in_is = true;
                }
                "rPh" | "extLst" if current_col.is_some() && in_is => {
                    skip_element_with_buf(reader, text_buf)?;
                }
                "t" if current_col.is_some() && in_is => {
                    append_text_until_end(reader, "t", text_buf, &mut current_value)?;
                }
                "f" if current_col.is_some() => {
                    skip_element_with_buf(reader, text_buf)?;
                }
                _ => {}
            },
            Event::Empty(ref e) => {
                if e.local_name().as_ref() == "c" {
                    let (col_idx, _, style_idx) = parse_cell_attrs(e, prev_col + 1);
                    prev_col = col_idx;
                    if col_idx <= MAX_SPREADSHEET_COLUMN_SCAN {
                        let style_index = xf_style_indices.get(style_idx).copied().flatten();
                        if style_index.is_some() {
                            *max_seen_col = (*max_seen_col).max(col_idx);
                            cells.insert(
                                col_idx,
                                WorkbookCell {
                                    value: String::new(),
                                    style_index,
                                    col_span: None,
                                    row_span: None,
                                    covered_by_merge: false,
                                },
                            );
                        }
                    }
                }
            }
            Event::End(ref e) => match e.local_name().as_ref() {
                "is" => in_is = false,
                "c" => {
                    if let Some(col_idx) = current_col.take() {
                        if col_idx <= MAX_SPREADSHEET_COLUMN_SCAN {
                            let formatted = format_cell_value(
                                current_kind,
                                &current_value,
                                shared_strings,
                                styles,
                                current_style_idx,
                                date_1904,
                            );
                            let style_index =
                                xf_style_indices.get(current_style_idx).copied().flatten();
                            if !formatted.is_empty() || style_index.is_some() {
                                *max_seen_col = (*max_seen_col).max(col_idx);
                                cells.insert(
                                    col_idx,
                                    WorkbookCell {
                                        value: formatted,
                                        style_index,
                                        col_span: None,
                                        row_span: None,
                                        covered_by_merge: false,
                                    },
                                );
                            }
                        }
                    }
                    current_kind = CellValueKind::Numeric;
                    current_value.clear();
                    in_is = false;
                }
                "row" => break,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(cells)
}

fn format_cell_value(
    cell_kind: CellValueKind,
    raw: &str,
    shared_strings: &[String],
    styles: &Stylesheet,
    style_idx: usize,
    date_1904: bool,
) -> String {
    if raw.is_empty() {
        return String::new();
    }
    match cell_kind {
        CellValueKind::SharedString => raw
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|idx| shared_strings.get(idx))
            .cloned()
            .unwrap_or_default(),
        CellValueKind::InlineOrStr => raw.to_owned(),
        CellValueKind::Boolean => {
            if raw.trim() == "1" {
                "TRUE".to_owned()
            } else {
                "FALSE".to_owned()
            }
        }
        CellValueKind::Numeric => {
            let Ok(num) = raw.trim().parse::<f64>() else {
                return raw.to_owned();
            };
            let num_fmt_id = styles
                .cell_xfs
                .get(style_idx)
                .map(|xf| xf.num_fmt_id)
                .unwrap_or(0);
            let format_code = styles.format_code(num_fmt_id).unwrap_or("General");
            format_number_with_pattern(num, num_fmt_id, format_code, date_1904)
        }
    }
}

fn format_number_with_pattern(
    value: f64,
    num_fmt_id: u32,
    format_code: &str,
    date_1904: bool,
) -> String {
    if is_date_format(num_fmt_id, format_code) && (0.0..2_958_466.0).contains(&value) {
        return format_excel_serial_date(value, format_code, date_1904);
    }

    let primary_section = format_code.split(';').next().unwrap_or(format_code);
    let cleaned = strip_format_literals(primary_section);
    if cleaned.contains('%') {
        let decimals = count_decimal_places(&cleaned);
        return format!("{}%", format_fixed_or_clean(value * 100.0, decimals, false));
    }

    let use_commas = cleaned.contains(',');
    if cleaned.eq_ignore_ascii_case("General") || (!cleaned.contains('0') && !cleaned.contains('#'))
    {
        return format_clean_float(value);
    }

    let decimals = count_decimal_places(&cleaned);
    let prefix = extract_currency_prefix(primary_section);
    let formatted_num = format_fixed_or_clean(value.abs(), decimals, use_commas);
    if value < 0.0 {
        format!("-{prefix}{formatted_num}")
    } else {
        format!("{prefix}{formatted_num}")
    }
}

fn extract_currency_prefix(section: &str) -> String {
    if section.contains('£') {
        "£".to_owned()
    } else if section.contains('€') {
        "€".to_owned()
    } else if section.contains('¥') {
        "¥".to_owned()
    } else if section.contains("[$") {
        if let Some(start) = section.find("[$") {
            let rest = &section[start + 2..];
            if let Some(end) = rest.find(']') {
                let inner = &rest[..end];
                let symbol = inner.split('-').next().unwrap_or("");
                if !symbol.is_empty() {
                    return symbol.to_owned();
                }
            }
        }
        String::new()
    } else if section.contains('$') {
        "$".to_owned()
    } else {
        String::new()
    }
}

fn strip_format_literals(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut in_quotes = false;
    let mut bracket_depth = 0usize;
    let mut escaped = false;
    for ch in pattern.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && !in_quotes {
            escaped = true;
            continue;
        }
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if !in_quotes {
            if ch == '[' {
                bracket_depth += 1;
                continue;
            }
            if ch == ']' && bracket_depth > 0 {
                bracket_depth -= 1;
                continue;
            }
            if bracket_depth == 0 {
                out.push(ch);
            }
        }
    }
    out
}

fn count_decimal_places(cleaned: &str) -> Option<usize> {
    let (_, frac) = cleaned.split_once('.')?;
    let count = frac
        .chars()
        .take_while(|c| matches!(c, '0' | '#' | '?'))
        .count();
    Some(count)
}

fn format_fixed_or_clean(value: f64, decimals: Option<usize>, use_commas: bool) -> String {
    let raw = match decimals {
        Some(places) => format!("{value:.places$}"),
        None => format_clean_float(value),
    };
    if !use_commas {
        return raw;
    }
    let (sign, unsigned) = raw
        .strip_prefix('-')
        .map_or(("", raw.as_str()), |rest| ("-", rest));
    let (int_part, frac_part) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let grouped = group_thousands(int_part);
    if frac_part.is_empty() {
        format!("{sign}{grouped}")
    } else {
        format!("{sign}{grouped}.{frac_part}")
    }
}

fn group_thousands(digits: &str) -> String {
    let len = digits.len();
    if len <= 3 {
        return digits.to_owned();
    }
    let mut out = String::with_capacity(len + len / 3);
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (len - idx).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn format_clean_float(value: f64) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    if value.abs() < 1e-12 {
        return "0".to_owned();
    }
    let rounded = (value * 1e9).round() / 1e9;
    if (value - rounded).abs() < 1e-11 {
        if rounded.fract().abs() < 1e-11 {
            format!("{:.0}", rounded)
        } else {
            let mut text = format!("{rounded:.9}");
            while text.ends_with('0') {
                text.pop();
            }
            if text.ends_with('.') {
                text.pop();
            }
            text
        }
    } else {
        value.to_string()
    }
}

fn is_date_format(num_fmt_id: u32, format_code: &str) -> bool {
    if matches!(num_fmt_id, 14..=22 | 45..=47) {
        return true;
    }
    let cleaned = strip_format_literals(format_code.split(';').next().unwrap_or(format_code))
        .to_ascii_lowercase();
    let has_date_tokens = cleaned.chars().any(|c| matches!(c, 'y' | 'd' | 'h' | 's'));
    let has_numeric_placeholders = cleaned.chars().any(|c| matches!(c, '#' | '?'));
    has_date_tokens && !has_numeric_placeholders
}

fn format_excel_serial_date(serial: f64, format_code: &str, date_1904: bool) -> String {
    let total_days = serial.floor() as i64;
    let frac = (serial - serial.floor()).clamp(0.0, 0.999_999);
    let total_seconds = (frac * 86_400.0).round() as u32;
    let (days, extra_day) = if total_seconds >= 86_400 {
        (total_days + 1, 0)
    } else {
        (total_days, total_seconds)
    };

    let base_days = if date_1904 {
        days_from_civil(1904, 1, 1) + days
    } else {
        let adjusted = if days >= 60 { days - 1 } else { days };
        days_from_civil(1899, 12, 31) + adjusted
    };
    let (year, month, day) = civil_from_days(base_days);
    let hour = extra_day / 3600;
    let minute = (extra_day % 3600) / 60;
    let second = extra_day % 60;

    let lower = strip_format_literals(format_code).to_ascii_lowercase();
    let has_date = lower.contains('y') || lower.contains('d');
    let has_time = lower.contains('h') || lower.contains(":mm") || lower.contains('s');

    if has_date && has_time {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}")
    } else if has_time && !has_date {
        format!("{hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02}")
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn parse_cell_range(value: &str) -> Option<(usize, usize, usize, usize)> {
    let cleaned = value.replace('$', "");
    let (start, end) = cleaned
        .split_once(':')
        .unwrap_or((cleaned.as_str(), cleaned.as_str()));
    let (sr, sc) = parse_cell_address(start)?;
    let (er, ec) = parse_cell_address(end)?;
    Some((sr, sc, er, ec))
}

fn parse_cell_address(value: &str) -> Option<(usize, usize)> {
    let mut split = 0usize;
    for (idx, ch) in value.char_indices() {
        if ch.is_ascii_alphabetic() {
            split = idx + 1;
        } else {
            break;
        }
    }
    if split == 0 || split >= value.len() {
        return None;
    }
    let col_str = &value[..split];
    let row_str = &value[split..];
    let mut col = 0usize;
    for byte in col_str.bytes() {
        let upper = byte.to_ascii_uppercase();
        if !upper.is_ascii_uppercase() {
            return None;
        }
        col = col
            .checked_mul(26)?
            .checked_add((upper - b'A' + 1) as usize)?;
    }
    let row = row_str.parse::<usize>().ok()?;
    Some((row, col))
}

fn is_xml_true(value: &str) -> bool {
    value == "1" || value.eq_ignore_ascii_case("true")
}

pub fn to_column_label(mut index: usize) -> String {
    let mut label = Vec::new();
    while index > 0 {
        let letter = ((index - 1) % 26) as u8;
        label.push(b'A' + letter);
        index = (index - 1) / 26;
    }
    label.reverse();
    String::from_utf8(label).unwrap_or_default()
}

fn builtin_num_fmt(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        14 => "mm-dd-yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        _ => return None,
    })
}

const INDEXED_COLORS: &[Option<(u8, u8, u8)>] = &[
    Some((0x00, 0x00, 0x00)),
    Some((0xff, 0xff, 0xff)),
    Some((0xff, 0x00, 0x00)),
    Some((0x00, 0xff, 0x00)),
    Some((0x00, 0x00, 0xff)),
    Some((0xff, 0xff, 0x00)),
    Some((0xff, 0x00, 0xff)),
    Some((0x00, 0xff, 0xff)),
    Some((0x00, 0x00, 0x00)),
    Some((0xff, 0xff, 0xff)),
    Some((0xff, 0x00, 0x00)),
    Some((0x00, 0xff, 0x00)),
    Some((0x00, 0x00, 0xff)),
    Some((0xff, 0xff, 0x00)),
    Some((0xff, 0x00, 0xff)),
    Some((0x00, 0xff, 0xff)),
    Some((0x80, 0x00, 0x00)),
    Some((0x00, 0x80, 0x00)),
    Some((0x00, 0x00, 0x80)),
    Some((0x80, 0x80, 0x00)),
    Some((0x80, 0x00, 0x80)),
    Some((0x00, 0x80, 0x80)),
    Some((0xc0, 0xc0, 0xc0)),
    Some((0x80, 0x80, 0x80)),
    Some((0x99, 0x99, 0xff)),
    Some((0x99, 0x33, 0x66)),
    Some((0xff, 0xff, 0xcc)),
    Some((0xcc, 0xff, 0xff)),
    Some((0x66, 0x00, 0x66)),
    Some((0xff, 0x80, 0x80)),
    Some((0x00, 0x66, 0xcc)),
    Some((0xcc, 0xcc, 0xff)),
    Some((0x00, 0x00, 0x80)),
    Some((0xff, 0x00, 0xff)),
    Some((0xff, 0xff, 0x00)),
    Some((0x00, 0xff, 0xff)),
    Some((0x80, 0x00, 0x80)),
    Some((0x80, 0x00, 0x00)),
    Some((0x00, 0x80, 0x80)),
    Some((0x00, 0x00, 0xff)),
    Some((0x00, 0xcc, 0xff)),
    Some((0xcc, 0xff, 0xff)),
    Some((0xcc, 0xff, 0xcc)),
    Some((0xff, 0xff, 0x99)),
    Some((0x99, 0xcc, 0xff)),
    Some((0xff, 0x99, 0xcc)),
    Some((0xcc, 0x99, 0xff)),
    Some((0xff, 0xcc, 0x99)),
    Some((0x33, 0x66, 0xff)),
    Some((0x33, 0xcc, 0xcc)),
    Some((0x99, 0xcc, 0x00)),
    Some((0xff, 0xcc, 0x00)),
    Some((0xff, 0x99, 0x00)),
    Some((0xff, 0x66, 0x00)),
    Some((0x66, 0x66, 0x99)),
    Some((0x96, 0x96, 0x96)),
    Some((0x00, 0x33, 0x66)),
    Some((0x33, 0x99, 0x66)),
    Some((0x00, 0x33, 0x00)),
    Some((0x33, 0x33, 0x00)),
    Some((0x99, 0x33, 0x00)),
    Some((0x99, 0x33, 0x66)),
    Some((0x33, 0x33, 0x99)),
    Some((0x33, 0x33, 0x33)),
];

struct RelEntry {
    id: String,
    rel_type: String,
    target: String,
    external: bool,
}

fn rels_path_for(part_path: &str) -> String {
    match part_path.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
        None => format!("_rels/{part_path}.rels"),
    }
}

fn resolve_part_target(base_part_path: &str, target: &str) -> String {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        match base_part_path.rsplit_once('/') {
            Some((dir, _)) => dir.split('/').filter(|s| !s.is_empty()).collect(),
            None => Vec::new(),
        }
    };
    for segment in target.trim_start_matches('/').split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn parse_relationships<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> Result<Vec<RelEntry>, PreviewParseOutcome> {
    let mut reader = open_xml(archive, idx)?;
    let mut buf = Vec::with_capacity(512);
    let mut entries = Vec::new();
    loop {
        buf.clear();
        match reader
            .read_event_into(&mut buf)
            .map_err(|_| PreviewParseOutcome::Fallback)?
        {
            Event::Start(ref e) | Event::Empty(ref e)
                if e.local_name().as_ref() == "Relationship" =>
            {
                let id = attr_value(e, "Id");
                let rel_type = attr_value(e, "Type").unwrap_or_default();
                let target = attr_value(e, "Target");
                let external = attr_value(e, "TargetMode")
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("External"));
                if let (Some(id), Some(target)) = (id, target) {
                    entries.push(RelEntry {
                        id,
                        rel_type,
                        target,
                        external,
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(entries)
}

fn image_mime_for_path(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn sheet_drawing_targets<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_lookup: &HashMap<String, usize>,
    sheet_target: &str,
) -> Vec<String> {
    let rels_key = rels_path_for(sheet_target).to_ascii_lowercase();
    let Some(&rels_idx) = entry_lookup.get(&rels_key) else {
        return Vec::new();
    };
    let Ok(rels) = parse_relationships(archive, rels_idx) else {
        return Vec::new();
    };
    rels.into_iter()
        .filter(|rel| !rel.external && rel.rel_type.ends_with("/drawing"))
        .map(|rel| resolve_part_target(sheet_target, &rel.target))
        .collect()
}

fn sheet_has_images<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_lookup: &HashMap<String, usize>,
    sheet_target: &str,
) -> bool {
    for drawing_path in sheet_drawing_targets(archive, entry_lookup, sheet_target) {
        let drawing_rels_key = rels_path_for(&drawing_path).to_ascii_lowercase();
        let Some(&rels_idx) = entry_lookup.get(&drawing_rels_key) else {
            continue;
        };
        let Ok(rels) = parse_relationships(archive, rels_idx) else {
            continue;
        };
        for rel in rels {
            if rel.external {
                continue;
            }
            let target = resolve_part_target(&drawing_path, &rel.target);
            if image_mime_for_path(&target).is_some()
                && entry_lookup.contains_key(&target.to_ascii_lowercase())
            {
                return true;
            }
        }
    }
    false
}

struct SheetLayoutMetrics {
    col_defs: Vec<ColDef>,
    row_heights: HashMap<usize, f64>,
}

impl SheetLayoutMetrics {
    fn col_left_px(&self, col_0based: usize) -> f64 {
        let mut x = 0.0;
        for col_idx in 1..=col_0based {
            let info = lookup_col_def(&self.col_defs, col_idx);
            if info.is_some_and(|def| def.hidden) {
                continue;
            }
            let width_chars = info.and_then(|def| def.width).unwrap_or(12.0);
            let width_px = (width_chars * 7.0 + 12.0).round().clamp(38.0, 320.0);
            x += width_px;
        }
        x
    }

    fn row_top_px(&self, row_0based: usize) -> f64 {
        let mut y = 0.0;
        for row_idx in 1..=row_0based {
            y += self.row_heights.get(&row_idx).copied().unwrap_or(22.0);
        }
        y
    }
}

fn read_sheet_layout_metrics<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
) -> SheetLayoutMetrics {
    let mut col_defs = Vec::new();
    let mut row_heights = HashMap::new();
    let Ok(mut reader) = open_xml(archive, idx) else {
        return SheetLayoutMetrics {
            col_defs,
            row_heights,
        };
    };
    let mut buf = Vec::with_capacity(512);
    let mut skip_buf = Vec::with_capacity(256);
    let mut dummy_max_col = 0usize;
    let mut prev_row_num = 0usize;
    loop {
        buf.clear();
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => match e.local_name().as_ref() {
                "col" => push_col_def(e, &mut col_defs, &mut dummy_max_col),
                "row" => {
                    let attrs = parse_row_attrs(e, prev_row_num + 1);
                    prev_row_num = attrs.row_num;
                    let height = if attrs.hidden {
                        0.0
                    } else {
                        f64::from(attrs.height_px)
                    };
                    if attrs.row_num <= MAX_SPREADSHEET_ROW_SCAN {
                        row_heights.insert(attrs.row_num, height);
                    }
                    if skip_element_with_buf(&mut reader, &mut skip_buf).is_err() {
                        break;
                    }
                }
                "sheetData" | "cols" => {}
                "mergeCells" | "drawing" | "extLst"
                    if skip_element_with_buf(&mut reader, &mut skip_buf).is_err() =>
                {
                    break;
                }
                _ => {}
            },
            Ok(Event::Empty(ref e)) => match e.local_name().as_ref() {
                "col" => push_col_def(e, &mut col_defs, &mut dummy_max_col),
                "row" => {
                    let attrs = parse_row_attrs(e, prev_row_num + 1);
                    prev_row_num = attrs.row_num;
                    let height = if attrs.hidden {
                        0.0
                    } else {
                        f64::from(attrs.height_px)
                    };
                    if attrs.row_num <= MAX_SPREADSHEET_ROW_SCAN {
                        row_heights.insert(attrs.row_num, height);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    SheetLayoutMetrics {
        col_defs,
        row_heights,
    }
}

#[derive(Default)]
struct AnchorMarker {
    col: usize,
    col_off: i64,
    row: usize,
    row_off: i64,
}

enum AnchorKind {
    TwoCell,
    OneCell,
}

enum AnchorMarkerSection {
    From,
    To,
}

enum AnchorTextField {
    Col,
    ColOff,
    Row,
    RowOff,
}

struct ParsedDrawingImage {
    rel_id: String,
    left_px: f64,
    top_px: f64,
    width_px: f64,
    height_px: f64,
}

fn emu_to_px(emu: i64) -> f64 {
    emu as f64 / 9525.0
}

fn parse_drawing_anchors<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    idx: usize,
    metrics: &SheetLayoutMetrics,
) -> Vec<ParsedDrawingImage> {
    let Ok(mut reader) = open_xml(archive, idx) else {
        return Vec::new();
    };
    let mut buf = Vec::with_capacity(512);
    let mut anchors = Vec::new();

    let mut active_kind: Option<AnchorKind> = None;
    let mut active_section: Option<AnchorMarkerSection> = None;
    let mut active_field: Option<AnchorTextField> = None;
    let mut from_marker = AnchorMarker::default();
    let mut to_marker = AnchorMarker::default();
    let mut one_cell_ext: Option<(i64, i64)> = None;
    let mut embed_id: Option<String> = None;
    let mut field_text = String::new();

    loop {
        buf.clear();
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => match e.local_name().as_ref() {
                "twoCellAnchor" => {
                    active_kind = Some(AnchorKind::TwoCell);
                    active_section = None;
                    active_field = None;
                    from_marker = AnchorMarker::default();
                    to_marker = AnchorMarker::default();
                    one_cell_ext = None;
                    embed_id = None;
                }
                "oneCellAnchor" => {
                    active_kind = Some(AnchorKind::OneCell);
                    active_section = None;
                    active_field = None;
                    from_marker = AnchorMarker::default();
                    to_marker = AnchorMarker::default();
                    one_cell_ext = None;
                    embed_id = None;
                }
                "from" if active_kind.is_some() => {
                    active_section = Some(AnchorMarkerSection::From);
                }
                "to" if active_kind.is_some() => {
                    active_section = Some(AnchorMarkerSection::To);
                }
                "col" if active_section.is_some() => {
                    active_field = Some(AnchorTextField::Col);
                    field_text.clear();
                }
                "colOff" if active_section.is_some() => {
                    active_field = Some(AnchorTextField::ColOff);
                    field_text.clear();
                }
                "row" if active_section.is_some() => {
                    active_field = Some(AnchorTextField::Row);
                    field_text.clear();
                }
                "rowOff" if active_section.is_some() => {
                    active_field = Some(AnchorTextField::RowOff);
                    field_text.clear();
                }
                "ext"
                    if matches!(active_kind, Some(AnchorKind::OneCell))
                        && one_cell_ext.is_none() =>
                {
                    if let (Some(cx), Some(cy)) = (
                        attr_value(e, "cx").and_then(|v| v.parse::<i64>().ok()),
                        attr_value(e, "cy").and_then(|v| v.parse::<i64>().ok()),
                    ) {
                        one_cell_ext = Some((cx, cy));
                    }
                }
                "blip" if active_kind.is_some() && embed_id.is_none() => {
                    embed_id = attr_value(e, "embed");
                }
                _ => {}
            },
            Ok(Event::Empty(ref e)) => match e.local_name().as_ref() {
                "ext"
                    if matches!(active_kind, Some(AnchorKind::OneCell))
                        && one_cell_ext.is_none() =>
                {
                    if let (Some(cx), Some(cy)) = (
                        attr_value(e, "cx").and_then(|v| v.parse::<i64>().ok()),
                        attr_value(e, "cy").and_then(|v| v.parse::<i64>().ok()),
                    ) {
                        one_cell_ext = Some((cx, cy));
                    }
                }
                "blip" if active_kind.is_some() && embed_id.is_none() => {
                    embed_id = attr_value(e, "embed");
                }
                _ => {}
            },
            Ok(Event::Text(ref t)) if active_field.is_some() => {
                field_text.push_str(&t.xml10_content());
            }
            Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                "col" | "colOff" | "row" | "rowOff" => {
                    if let (Some(section), Some(field)) = (&active_section, active_field.take()) {
                        let target = match section {
                            AnchorMarkerSection::From => &mut from_marker,
                            AnchorMarkerSection::To => &mut to_marker,
                        };
                        let trimmed = field_text.trim();
                        match field {
                            AnchorTextField::Col => {
                                target.col = trimmed.parse::<usize>().unwrap_or(0);
                            }
                            AnchorTextField::ColOff => {
                                target.col_off = trimmed.parse::<i64>().unwrap_or(0);
                            }
                            AnchorTextField::Row => {
                                target.row = trimmed.parse::<usize>().unwrap_or(0);
                            }
                            AnchorTextField::RowOff => {
                                target.row_off = trimmed.parse::<i64>().unwrap_or(0);
                            }
                        }
                        field_text.clear();
                    }
                }
                "from" | "to" => {
                    active_section = None;
                }
                "twoCellAnchor" | "oneCellAnchor" => {
                    if let (Some(kind), Some(rel_id)) = (active_kind.take(), embed_id.take()) {
                        let left_px = (metrics.col_left_px(from_marker.col)
                            + emu_to_px(from_marker.col_off))
                        .max(0.0);
                        let top_px = (metrics.row_top_px(from_marker.row)
                            + emu_to_px(from_marker.row_off))
                        .max(0.0);
                        let (width_px, height_px) = match kind {
                            AnchorKind::TwoCell => {
                                let right_px = metrics.col_left_px(to_marker.col)
                                    + emu_to_px(to_marker.col_off);
                                let bottom_px = metrics.row_top_px(to_marker.row)
                                    + emu_to_px(to_marker.row_off);
                                (
                                    (right_px - left_px).max(16.0),
                                    (bottom_px - top_px).max(16.0),
                                )
                            }
                            AnchorKind::OneCell => {
                                let (cx, cy) = one_cell_ext.unwrap_or((914_400, 914_400));
                                (emu_to_px(cx).max(16.0), emu_to_px(cy).max(16.0))
                            }
                        };
                        anchors.push(ParsedDrawingImage {
                            rel_id,
                            left_px,
                            top_px,
                            width_px,
                            height_px,
                        });
                    }
                    active_section = None;
                    active_field = None;
                    one_cell_ext = None;
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    anchors
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn load_sheet_images(path: &Path, sheet_index: usize) -> Result<Vec<WorkbookImage>, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| format!("Unable to inspect spreadsheet: {error}"))?
        .len();
    if size > MAX_SPREADSHEET_PREVIEW_BYTES {
        return Err(format!(
            "This spreadsheet is {} MB. In-app preview supports files up to 64 MB; open it in Windows instead.",
            size.div_ceil(1024 * 1024)
        ));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(extension.as_str(), "xlsx" | "xlsm" | "xltx" | "xltm") {
        return Ok(Vec::new());
    }

    let mut file =
        File::open(path).map_err(|error| format!("Unable to open spreadsheet: {error}"))?;
    validate_spreadsheet_archive_file(&mut file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("Unable to read spreadsheet: {error}"))?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|_| "Unable to open spreadsheet archive.".to_owned())?;
    let mut entry_lookup = HashMap::with_capacity(archive.len());
    for idx in 0..archive.len() {
        if let Some(Ok(name)) = archive.name_for_index(idx) {
            entry_lookup.insert(name.to_ascii_lowercase(), idx);
        }
    }

    let Some(&workbook_idx) = entry_lookup.get("xl/workbook.xml") else {
        return Ok(Vec::new());
    };
    let Ok(workbook_meta) = parse_workbook(&mut archive, workbook_idx) else {
        return Ok(Vec::new());
    };
    let rels = match entry_lookup.get("xl/_rels/workbook.xml.rels").copied() {
        Some(idx) => parse_workbook_rels(&mut archive, idx).unwrap_or_default(),
        None => HashMap::new(),
    };
    let visible_sheets: Vec<&WorkbookSheetEntry> = workbook_meta
        .sheets
        .iter()
        .filter(|sheet| sheet.visible)
        .collect();
    let Some(sheet_entry) = visible_sheets.get(sheet_index) else {
        return Ok(Vec::new());
    };
    let Some(sheet_target) = rels.get(&sheet_entry.rel_id) else {
        return Ok(Vec::new());
    };
    let Some(&sheet_idx) = entry_lookup.get(&sheet_target.to_ascii_lowercase()) else {
        return Ok(Vec::new());
    };
    if !sheet_has_images(&mut archive, &entry_lookup, sheet_target) {
        return Ok(Vec::new());
    }

    let metrics = read_sheet_layout_metrics(&mut archive, sheet_idx);
    let drawing_paths = sheet_drawing_targets(&mut archive, &entry_lookup, sheet_target);
    let mut images = Vec::new();
    let mut encoded_cache: HashMap<String, String> = HashMap::new();
    let mut total_image_bytes = 0usize;

    for drawing_path in drawing_paths {
        if images.len() >= MAX_SHEET_IMAGES {
            break;
        }
        let Some(&drawing_idx) = entry_lookup.get(&drawing_path.to_ascii_lowercase()) else {
            continue;
        };
        let drawing_rels_key = rels_path_for(&drawing_path).to_ascii_lowercase();
        let Some(&rels_idx) = entry_lookup.get(&drawing_rels_key) else {
            continue;
        };
        let Ok(rels) = parse_relationships(&mut archive, rels_idx) else {
            continue;
        };
        let rel_targets: HashMap<String, String> = rels
            .into_iter()
            .filter(|rel| !rel.external)
            .map(|rel| (rel.id, resolve_part_target(&drawing_path, &rel.target)))
            .collect();

        let anchors = parse_drawing_anchors(&mut archive, drawing_idx, &metrics);
        for anchor in anchors {
            if images.len() >= MAX_SHEET_IMAGES {
                break;
            }
            let Some(image_path) = rel_targets.get(&anchor.rel_id) else {
                continue;
            };
            let Some(mime) = image_mime_for_path(image_path) else {
                continue;
            };
            let lookup_key = image_path.to_ascii_lowercase();
            let data_url = if let Some(cached) = encoded_cache.get(&lookup_key) {
                cached.clone()
            } else {
                let Some(&image_idx) = entry_lookup.get(&lookup_key) else {
                    continue;
                };
                let Ok(entry) = archive.by_index(image_idx) else {
                    continue;
                };
                if entry.size() > MAX_SINGLE_IMAGE_BYTES as u64 {
                    continue;
                }
                let mut bytes = Vec::with_capacity(entry.size() as usize);
                if entry
                    .take((MAX_SINGLE_IMAGE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .is_err()
                {
                    continue;
                }
                if bytes.len() > MAX_SINGLE_IMAGE_BYTES
                    || total_image_bytes.saturating_add(bytes.len()) > MAX_TOTAL_IMAGE_BYTES
                {
                    continue;
                }
                total_image_bytes += bytes.len();
                let url = format!("data:{mime};base64,{}", encode_base64(&bytes));
                encoded_cache.insert(lookup_key, url.clone());
                url
            };
            images.push(WorkbookImage {
                data_url,
                left_px: anchor.left_px,
                top_px: anchor.top_px,
                width_px: anchor.width_px,
                height_px: anchor.height_px,
            });
        }
    }

    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn write_test_xlsx(entries: &[(&str, &str)]) -> tempfile::NamedTempFile {
        let mut temp = tempfile::NamedTempFile::new().unwrap();
        let mut zip = ZipWriter::new(temp.as_file_mut());
        let opts = SimpleFileOptions::default();
        for (name, body) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        temp
    }

    #[test]
    fn parses_styled_workbook_with_hidden_sheets_merges_and_formats() {
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <bookViews><workbookView activeTab="1"/></bookViews>
  <sheets>
    <sheet name="Hidden" sheetId="1" state="hidden" r:id="rId1"/>
    <sheet name="Summary" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#;
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>"#;
        let sst_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>Budget &amp; Spend</t></si>
  <si><t>Total</t></si>
</sst>"#;
        let styles_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF101D3E"/></patternFill></fill>
  </fills>
  <borders count="1">
    <border><left style="thin"><color rgb="FFCBD2DC"/></left><right/><top/><bottom/></border>
  </borders>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0"><alignment horizontal="center" wrapText="1"/></xf>
    <xf numFmtId="9" fontId="0" fillId="0" borderId="0"/>
  </cellXfs>
</styleSheet>"#;
        let sheet1_xml = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>"#;
        let sheet2_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="24"/>
    <col min="2" max="2" width="12" hidden="1"/>
    <col min="3" max="3" width="14"/>
  </cols>
  <sheetData>
    <row r="1" ht="24">
      <c r="A1" t="s" s="1"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>Secret</t></is></c>
      <c r="C1" s="1"/>
    </row>
    <row r="2" hidden="1"><c r="A2"><v>999</v></c></row>
    <row r="3">
      <c r="A3" t="s"><v>1</v></c>
      <c r="C3" s="2"><v>0.42</v></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>
</worksheet>"#;

        let file = write_test_xlsx(&[
            ("xl/workbook.xml", workbook_xml),
            ("xl/_rels/workbook.xml.rels", rels_xml),
            ("xl/sharedStrings.xml", sst_xml),
            ("xl/styles.xml", styles_xml),
            ("xl/worksheets/sheet1.xml", sheet1_xml),
            ("xl/worksheets/sheet2.xml", sheet2_xml),
        ]);
        let preview = load_styled_ooxml(File::open(file.path()).unwrap()).unwrap();
        assert_eq!(preview.active_sheet, 0);
        assert_eq!(preview.sheets.len(), 1);
        let sheet = &preview.sheets[0];
        assert_eq!(sheet.name, "Summary");
        assert_eq!(
            sheet
                .columns
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "C"]
        );
        assert_eq!(sheet.columns[0].width_px, 180);
        assert_eq!(sheet.rows.len(), 2);
        assert_eq!(sheet.rows[0].height_px, 32);
        assert_eq!(sheet.rows[0].cells[0].value, "Budget & Spend");
        assert_eq!(sheet.rows[0].cells[0].col_span, Some(2));
        assert_eq!(sheet.rows[0].cells[0].row_span, Some(1));
        assert!(sheet.rows[0].cells[1].covered_by_merge);
        let style_index = sheet.rows[0].cells[0].style_index.unwrap();
        assert_eq!(sheet.rows[0].cells[1].style_index, Some(style_index));
        let style = &preview.styles[style_index];
        assert_eq!(style.background_color.as_deref(), Some("#101d3e"));
        assert_eq!(style.color.as_deref(), Some("#ffffff"));
        assert_eq!(style.font_weight, Some(700));
        assert_eq!(style.white_space.as_deref(), Some("normal"));
        assert_eq!(sheet.rows[1].cells[1].value, "42%");
        assert!(!sheet.truncated_rows);
        assert!(!sheet.truncated_columns);
    }

    #[test]
    fn deduplicates_identical_styles_and_ignores_phonetic_shared_string_runs() {
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        let sst_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><r><t>Hello </t></r><r><rPr><b/></rPr><t>World</t></r><rPh sb="0" eb="5"><t>ignored</t></rPh></si>
</sst>"#;
        let styles_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0"/>
  </cellXfs>
</styleSheet>"#;
        let sheet1_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s" s="1"><v>0</v></c>
      <c r="B1" s="2"/>
    </row>
  </sheetData>
</worksheet>"#;

        let file = write_test_xlsx(&[
            ("xl/workbook.xml", workbook_xml),
            ("xl/_rels/workbook.xml.rels", rels_xml),
            ("xl/sharedStrings.xml", sst_xml),
            ("xl/styles.xml", styles_xml),
            ("xl/worksheets/sheet1.xml", sheet1_xml),
        ]);
        let preview = load_styled_ooxml(File::open(file.path()).unwrap()).unwrap();
        assert_eq!(preview.styles.len(), 1);
        let row = &preview.sheets[0].rows[0];
        assert_eq!(row.cells[0].value, "Hello World");
        assert_eq!(row.cells[0].style_index, Some(0));
        assert_eq!(row.cells[1].value, "");
        assert_eq!(row.cells[1].style_index, Some(0));
        assert_eq!(preview.styles[0].font_weight, Some(700));
    }

    #[test]
    fn reports_truncation_when_sheet_exceeds_preview_limits() {
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Large" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        let mut rows_xml = String::new();
        for row_num in 1..=(MAX_SPREADSHEET_ROWS + 5) {
            rows_xml.push_str(&format!(
                "<row r=\"{row_num}\"><c r=\"A{row_num}\"><v>{row_num}</v></c>"
            ));
            if row_num == 1 {
                let wide_col = to_column_label(MAX_SPREADSHEET_COLUMNS + 3);
                rows_xml.push_str(&format!("<c r=\"{wide_col}1\"><v>1</v></c>"));
            }
            rows_xml.push_str("</row>");
        }
        let sheet1_xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows_xml}</sheetData></worksheet>"#
        );

        let file = write_test_xlsx(&[
            ("xl/workbook.xml", workbook_xml),
            ("xl/_rels/workbook.xml.rels", rels_xml),
            ("xl/worksheets/sheet1.xml", &sheet1_xml),
        ]);
        let preview = load_styled_ooxml(File::open(file.path()).unwrap()).unwrap();
        let sheet = &preview.sheets[0];
        assert_eq!(sheet.rows.len(), MAX_SPREADSHEET_ROWS);
        assert_eq!(sheet.columns.len(), MAX_SPREADSHEET_COLUMNS);
        assert!(sheet.truncated_rows);
        assert!(sheet.truncated_columns);
    }

    #[test]
    fn rejects_zip_compression_ratio_bombs_and_missing_files() {
        let repetitive = "A".repeat(300_000);
        let temp = write_test_xlsx(&[("xl/workbook.xml", &repetitive)]);
        let err = validate_spreadsheet_archive(temp.path()).unwrap_err();
        assert!(
            err.contains("safe in-app preview limit"),
            "unexpected error: {err}"
        );

        let missing = temp.path().with_file_name("does-not-exist.xls");
        let missing_err = preview_file(&missing).unwrap_err();
        assert!(
            missing_err.contains("Unable to inspect spreadsheet"),
            "unexpected: {missing_err}"
        );
    }

    #[test]
    fn column_labels_match_excel_conventions() {
        assert_eq!(to_column_label(1), "A");
        assert_eq!(to_column_label(26), "Z");
        assert_eq!(to_column_label(27), "AA");
        assert_eq!(to_column_label(702), "ZZ");
        assert_eq!(to_column_label(703), "AAA");
    }

    #[test]
    fn formats_excel_dates_and_currency() {
        assert_eq!(
            format_number_with_pattern(46168.0, 14, "mm-dd-yy", false),
            "2026-05-26"
        );
        assert_eq!(
            format_number_with_pattern(1234.5, 0, "$#,##0.00", false),
            "$1,234.50"
        );
    }

    #[test]
    fn parses_csv_and_tsv_with_bom_quotes_and_truncation() {
        let mut temp_csv = tempfile::Builder::new().suffix(".csv").tempfile().unwrap();
        temp_csv
            .write_all(
                "\u{feff}\"Task Name\",\"Notes\",Budget\r\n\"Launch, \"\"UK\"\"\",\"Line 1\nLine 2\",12500\r\n"
                    .as_bytes(),
            )
            .unwrap();
        let csv_preview = preview_file(temp_csv.path()).unwrap();
        assert_eq!(csv_preview.styles.len(), 1);
        assert_eq!(csv_preview.sheets.len(), 1);
        let sheet = &csv_preview.sheets[0];
        assert_eq!(sheet.rows.len(), 2);
        assert_eq!(sheet.columns.len(), 3);
        assert_eq!(sheet.rows[0].cells[0].value, "Task Name");
        assert_eq!(sheet.rows[0].cells[0].style_index, Some(0));
        assert_eq!(sheet.rows[1].cells[0].value, "Launch, \"UK\"");
        assert_eq!(sheet.rows[1].cells[1].value, "Line 1\nLine 2");
        assert_eq!(sheet.rows[1].cells[2].value, "12500");
        assert!(!sheet.truncated_rows);

        let mut large_csv = String::new();
        for i in 1..=(MAX_SPREADSHEET_ROWS + 3) {
            large_csv.push_str(&format!("colA;colB\nrow{i};{i}\n"));
        }
        let mut temp_semi = tempfile::Builder::new().suffix(".csv").tempfile().unwrap();
        temp_semi.write_all(large_csv.as_bytes()).unwrap();
        let semi_preview = preview_file(temp_semi.path()).unwrap();
        assert_eq!(semi_preview.sheets[0].rows.len(), MAX_SPREADSHEET_ROWS);
        assert_eq!(semi_preview.sheets[0].columns.len(), 2);
        assert!(semi_preview.sheets[0].truncated_rows);
    }

    #[test]
    fn encodes_base64_and_loads_ooxml_sheet_images_on_demand() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");

        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/relationships">
  <sheets><sheet name="Media" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
        let wb_rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>"#;
        let sheet1_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
           xmlns:r="http://schemas.openxmlformats.org/officeDocument/relationships">
  <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Logo</t></is></c></row></sheetData>
  <drawing r:id="rIdDraw"/>
</worksheet>"#;
        let sheet1_rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>"#;
        let drawing1_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/relationships">
  <xdr:oneCellAnchor>
    <xdr:from><xdr:col>1</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="952500" cy="476250"/>
    <xdr:pic><xdr:blipFill><a:blip r:embed="rIdImg"/></xdr:blipFill></xdr:pic>
    <xdr:clientData/>
  </xdr:oneCellAnchor>
</xdr:wsDr>"#;
        let drawing1_rels = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/>
</Relationships>"#;

        let temp = tempfile::Builder::new().suffix(".xlsx").tempfile().unwrap();
        let file = temp.reopen().unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, content) in [
            ("xl/workbook.xml", workbook_xml.as_bytes()),
            ("xl/_rels/workbook.xml.rels", wb_rels.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet1_xml.as_bytes()),
            (
                "xl/worksheets/_rels/sheet1.xml.rels",
                sheet1_rels.as_bytes(),
            ),
            ("xl/drawings/drawing1.xml", drawing1_xml.as_bytes()),
            (
                "xl/drawings/_rels/drawing1.xml.rels",
                drawing1_rels.as_bytes(),
            ),
            ("xl/media/logo.png", b"\x89PNG\r\n\x1a\n"),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap();

        let preview = preview_file(temp.path()).unwrap();
        assert!(preview.sheets[0].has_images);
        let images = load_sheet_images(temp.path(), 0).unwrap();
        assert_eq!(images.len(), 1);
        assert!(images[0].data_url.starts_with("data:image/png;base64,"));
        assert_eq!(images[0].width_px, 100.0);
        assert_eq!(images[0].height_px, 50.0);
        assert!(images[0].left_px > 96.0);
    }

    #[test]
    fn defers_non_active_ooxml_sheets_and_loads_them_on_demand() {
        let workbook_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/relationships">
  <bookViews><workbookView activeTab="1"/></bookViews>
  <sheets>
    <sheet name="First" sheetId="1" r:id="rId1"/>
    <sheet name="Second" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>"#;
        let rels_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>"#;
        let sst_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>Deferred Cell</t></si>
  <si><t>Active Cell</t></si>
</sst>"#;
        let styles_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/></border></borders>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>
</styleSheet>"#;
        let sheet1_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="s" s="0"><v>0</v></c></row></sheetData>
</worksheet>"#;
        let sheet2_xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1" t="s" s="0"><v>1</v></c></row></sheetData>
</worksheet>"#;
        let file = write_test_xlsx(&[
            ("xl/workbook.xml", workbook_xml),
            ("xl/_rels/workbook.xml.rels", rels_xml),
            ("xl/sharedStrings.xml", sst_xml),
            ("xl/styles.xml", styles_xml),
            ("xl/worksheets/sheet1.xml", sheet1_xml),
            ("xl/worksheets/sheet2.xml", sheet2_xml),
        ]);
        let preview = preview_file(file.path()).unwrap();
        assert_eq!(preview.active_sheet, 1);
        assert_eq!(preview.sheets.len(), 2);
        assert!(preview.sheets[0].deferred);
        assert!(preview.sheets[0].rows.is_empty());
        assert!(!preview.sheets[1].deferred);
        assert_eq!(preview.sheets[1].rows[0].cells[0].value, "Active Cell");

        let loaded_first = load_sheet(file.path(), 0).unwrap();
        assert!(!loaded_first.deferred);
        assert_eq!(loaded_first.name, "First");
        assert_eq!(loaded_first.rows[0].cells[0].value, "Deferred Cell");
        let style_idx = loaded_first.rows[0].cells[0].style_index.unwrap();
        assert_eq!(preview.styles[style_idx].font_weight, Some(700));
    }
}
