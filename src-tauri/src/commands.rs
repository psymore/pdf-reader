use crate::recent_files::{self, RecentEntry};
use std::fs;
use std::path::Path;

pub fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
}

fn file_name_or_path(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Reads a PDF's bytes, records it in the recent-files list, and returns
/// the bytes as an IPC response. Shared by both `open_pdf_file` (native
/// dialog) and `open_pdf_path` (drag-drop / sidebar reopen).
fn open_path_and_record(
    app: &tauri::AppHandle,
    path: &Path,
) -> Result<tauri::ipc::Response, String> {
    let bytes = read_pdf_bytes(path)?;

    let path_str = path.to_string_lossy().to_string();
    let name = file_name_or_path(path);
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
        Some(path) => {
            let path = path
                .as_path()
                .ok_or_else(|| "Invalid file path".to_string())?;
            open_path_and_record(&app, path)
        }
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn open_pdf_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    open_path_and_record(&app, Path::new(&path))
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
}
