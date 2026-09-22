use std::fs;
use std::path::Path;

pub fn read_pdf_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("Failed to read file: {e}"))
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
            let bytes = read_pdf_bytes(path)?;
            Ok(tauri::ipc::Response::new(bytes))
        }
        None => Err("cancelled".to_string()),
    }
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
