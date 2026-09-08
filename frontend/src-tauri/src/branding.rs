// Names this build writes into the user's filesystem.
//
// These are not the primary data location. Models and the database live under
// Tauri's app_data_dir(), which is derived from the `identifier` in
// tauri.conf.json, not from anything here. This constant covers the paths that
// are built by hand from dirs::data_dir() / dirs::config_dir(): custom summary
// templates, notification settings, and the engine fallback model directories.
pub const APP_DIR_NAME: &str = "JameelNote";
