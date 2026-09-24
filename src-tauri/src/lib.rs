// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;
mod recent_files;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_pdf_file,
            commands::open_pdf_path,
            commands::get_launch_path,
            commands::get_recent_files,
            commands::toggle_pin,
            commands::remove_recent_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
