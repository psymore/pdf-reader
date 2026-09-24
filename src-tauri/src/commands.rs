use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::io::Read as _;
use std::path::Path;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

pub fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

fn file_name_or_path(file_path: &FilePath) -> String {
    match file_path.as_path() {
        Some(p) => p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string()),
        // content:// URIs have no filesystem file name; fall back to decoding
        // one out of the URI itself instead of showing the raw content:// string.
        None => extract_display_name(&file_path.to_string()),
    }
}

/// Android SAF `content://` URIs encode the underlying path/display name in
/// their last segment — e.g. `.../document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Ffoo.pdf`
/// (downloads provider) or `.../document/primary%3ADownload%2Ffoo.pdf` (external
/// storage provider). Percent-decode that segment and pull "foo.pdf" out of it
/// so the sidebar/recent list shows a real name instead of the raw URI.
fn extract_display_name(uri: &str) -> String {
    let last_segment = uri.rsplit('/').next().unwrap_or(uri);
    let decoded = percent_decode(last_segment);
    basename_ending_in_pdf(&decoded)
        .or_else(|| {
            decoded
                .rsplit(|c| c == '/' || c == ':')
                .find(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| uri.to_string())
}

/// Anchors on the `.pdf` extension itself and takes everything back to the
/// nearest `/` or `:` before it, rather than assuming the filename is the
/// whole trailing segment — some providers tack extra suffixes (a revision
/// id, a query-like fragment) onto the segment after the real file name.
fn basename_ending_in_pdf(decoded: &str) -> Option<String> {
    let ext_at = decoded.to_lowercase().rfind(".pdf")?;
    let end = ext_at + 4;
    let start = decoded[..ext_at]
        .rfind(|c| c == '/' || c == ':')
        .map(|i| i + 1)
        .unwrap_or(0);
    Some(decoded[start..end].to_string())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Reads a PDF's bytes — via a direct filesystem read for a regular path, or
/// via the fs plugin's Android content-resolver bridge for a `content://`
/// URI (what the native file picker returns on Android/scoped storage).
fn read_bytes(app: &tauri::AppHandle, file_path: &FilePath) -> Result<Vec<u8>, String> {
    if let Some(path) = file_path.as_path() {
        return read_pdf_bytes(path);
    }

    let mut file = app
        .fs()
        .open(file_path.clone(), OpenOptions::new().read(true).clone())
        .map_err(|e| format!("Failed to open file: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(bytes)
}

/// Reads a PDF's bytes, records it in the recent-files list, and returns
/// the bytes as an IPC response. Shared by both `open_pdf_file` (native
/// dialog) and `open_pdf_path` (drag-drop / sidebar reopen).
fn open_filepath_and_record(
    app: &tauri::AppHandle,
    file_path: FilePath,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_bytes(app, &file_path)?;

    let path_str = file_path.to_string();
    let name = file_name_or_path(&file_path);
    let entries = recent_files::load(app);
    let entries = recent_files::upsert_and_trim(
        entries,
        &path_str,
        &name,
        recent_files::now_millis(),
        recent_files::RECENT_CAP,
    );
    recent_files::save(app, &entries)?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn open_pdf_file(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file();

    match file_path {
        Some(path) => open_filepath_and_record(&app, path),
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_pdf_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let file_path: FilePath = path.parse().expect("FilePath parsing is infallible");
    open_filepath_and_record(&app, file_path)
}

/// Returns the PDF path passed on the command line, if any — this is how
/// Windows launches the app for "Open with" / file-association double-click.
#[tauri::command]
pub fn get_launch_path() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| arg.to_lowercase().ends_with(".pdf"))
}

#[tauri::command]
pub fn get_recent_files(app: tauri::AppHandle) -> Vec<RecentEntry> {
    recent_files::load(&app)
}

#[tauri::command]
pub fn toggle_pin(app: tauri::AppHandle, path: String) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::toggle_pin(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}

#[tauri::command]
pub fn remove_recent_entry(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<RecentEntry>, String> {
    let entries = recent_files::load(&app);
    let entries = recent_files::remove_entry(entries, &path);
    recent_files::save(&app, &entries)?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_existing_file_bytes() {
        let mut tmp = std::env::temp_dir();
        tmp.push("pdf_reader_test_read.bin");
        let mut f = fs::File::create(&tmp).unwrap();
        f.write_all(b"%PDF-1.4 test bytes").unwrap();

        let result = read_pdf_bytes(&tmp).unwrap();
        assert_eq!(result, b"%PDF-1.4 test bytes");

        fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn errors_on_missing_file() {
        let missing = Path::new("this_file_does_not_exist_pdf_reader.pdf");
        let result = read_pdf_bytes(missing);
        assert!(result.is_err());
    }

    #[test]
    fn extracts_name_from_downloads_provider_uri() {
        let uri = "content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FEgeOzel_CV.pdf";
        assert_eq!(extract_display_name(uri), "EgeOzel_CV.pdf");
    }

    #[test]
    fn extracts_name_from_external_storage_provider_uri() {
        let uri = "content://com.android.externalstorage.documents/document/primary%3ADownload%2FEgeOzel_CV.pdf";
        assert_eq!(extract_display_name(uri), "EgeOzel_CV.pdf");
    }

    #[test]
    fn falls_back_to_full_uri_when_no_basename_found() {
        let uri = "content://com.example.provider/document/12345";
        assert_eq!(extract_display_name(uri), "12345");
    }

    #[test]
    fn strips_trailing_suffix_after_pdf_extension() {
        let uri = "content://com.example.provider/document/primary%3ADownload%2FEgeOzel_CV.pdf%3Frev%3D3";
        assert_eq!(extract_display_name(uri), "EgeOzel_CV.pdf");
    }
}
