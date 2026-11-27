//! Couche Tauri : commandes appelées par l'interface.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use rp_core::{ApplyReport, Doc, Index, KeyRecord, Store};
use serde::Serialize;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{Manager, State};

const KEYRING_SERVICE: &str = "holopad";
const KEYRING_USER: &str = "docs-key";
const DATA_BRANCH: &str = "docs-data";
/// Dépôt GitHub injecté à la compilation par le workflow de release.
const BUILD_REPO: Option<&str> = option_env!("HOLOPAD_REPO");

struct AppState {
    store: Store,
    settings_path: PathBuf,
    key: Mutex<Option<KeyRecord>>,
    sync_lock: AsyncMutex<()>,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct Status {
    has_data: bool,
    unlocked: bool,
    repo: Option<String>,
    pending_changes: usize,
    generated_at: Option<String>,
    version: String,
}

#[derive(Serialize)]
struct SyncResult {
    downloaded: usize,
    report: ApplyReport,
    generated_at: String,
}

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

fn load_key() -> Option<KeyRecord> {
    let secret = keyring_entry()?.get_password().ok()?;
    serde_json::from_str(&secret).ok()
}

fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |s: Option<&str>| {
        s.map(|s| {
            !s.is_empty()
                && s.len() <= 100
                && !s.starts_with('.')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .unwrap_or(false)
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn read_settings(state: &AppState) -> serde_json::Value {
    fs::read(&state.settings_path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn current_repo(state: &AppState) -> Option<String> {
    let from_settings = read_settings(state)
        .get("repo")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    from_settings
        .or_else(|| BUILD_REPO.map(str::to_string))
        .filter(|r| valid_repo(r))
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> serde_json::Value {
    read_settings(&state)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: serde_json::Value) -> CmdResult<()> {
    if !settings.is_object() {
        return Err("paramètres invalides".into());
    }
    let data = serde_json::to_vec_pretty(&settings).map_err(err)?;
    let tmp = state.settings_path.with_extension("tmp");
    fs::write(&tmp, data).map_err(err)?;
    fs::rename(&tmp, &state.settings_path).map_err(err)
}

#[tauri::command]
fn status(app: tauri::AppHandle, state: State<'_, AppState>) -> CmdResult<Status> {
    let index = state.store.index().map_err(err)?;
    let unlocked = match (&*state.key.lock().unwrap(), &index) {
        (Some(key), Some(index)) => key.matches(index),
        _ => false,
    };
    Ok(Status {
        has_data: index.as_ref().map(|i| !i.docs.is_empty()).unwrap_or(false),
        unlocked,
        repo: current_repo(&state),
        pending_changes: state.store.pending_changes(),
        generated_at: index.map(|i| i.generated_at),
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
async fn unlock(state: State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let dir = state.store.dir().to_path_buf();
    // PBKDF2 (600 000 itérations) : hors du fil de l'interface.
    let record =
        tauri::async_runtime::spawn_blocking(move || Store::open(dir)?.unlock(&passphrase))
            .await
            .map_err(err)?
            .map_err(err)?;
    if let Some(entry) = keyring_entry() {
        let _ = entry.set_password(&serde_json::to_string(&record).map_err(err)?);
    }
    *state.key.lock().unwrap() = Some(record);
    Ok(())
}

#[tauri::command]
fn lock(state: State<'_, AppState>) {
    if let Some(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    *state.key.lock().unwrap() = None;
}

#[tauri::command]
async fn sync_docs(state: State<'_, AppState>) -> CmdResult<SyncResult> {
    let _guard = state.sync_lock.lock().await;
    let repo = current_repo(&state).ok_or(
        "Dépôt GitHub non configuré (Paramètres → Dépôt GitHub, format propriétaire/nom).",
    )?;
    let base = format!("https://raw.githubusercontent.com/{repo}/{DATA_BRANCH}");
    let bust = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();

    let resp = state
        .http
        .get(format!("{base}/index.json?t={bust}"))
        .send()
        .await
        .map_err(|_| {
            "Pas de connexion : les documents en cache restent disponibles.".to_string()
        })?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Aucune donnée publiée sur le dépôt (le workflow de synchronisation n'a pas encore tourné ?).".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub a répondu {}", resp.status()));
    }
    let raw = resp.bytes().await.map_err(err)?.to_vec();
    let remote = Index::parse(&raw).map_err(err)?;
    let plan = state.store.plan(&remote).map_err(err)?;

    let mut downloads = Vec::with_capacity(plan.len());
    for file in plan {
        let resp = state
            .http
            .get(format!("{base}/{file}?t={bust}"))
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?;
        downloads.push((file, resp.bytes().await.map_err(err)?.to_vec()));
    }
    let downloaded = downloads.len();
    let report = state.store.apply(&raw, downloads).map_err(err)?;
    Ok(SyncResult {
        downloaded,
        report,
        generated_at: remote.generated_at,
    })
}

#[tauri::command]
async fn load_docs(state: State<'_, AppState>) -> CmdResult<Vec<Doc>> {
    let key = state
        .key
        .lock()
        .unwrap()
        .clone()
        .ok_or(rp_core::Error::Locked.to_string())?;
    state.store.load(&key).map_err(err)
}

#[tauri::command]
fn mark_doc_seen(state: State<'_, AppState>, file: String) -> CmdResult<()> {
    state.store.mark_seen(&file).map_err(err)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&data_dir)?;
            let store = Store::open(data_dir.join("docs"))?;
            if let Ok(resources) = app.path().resource_dir() {
                // Documents chiffrés embarqués à l'installation : lecture hors ligne dès le 1er lancement.
                let _ = store.seed_from(&resources.join("docs-seed"));
            }
            let http = reqwest::Client::builder()
                .user_agent(concat!("holopad/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(20))
                .build()?;
            app.manage(AppState {
                store,
                settings_path: data_dir.join("settings.json"),
                key: Mutex::new(load_key()),
                sync_lock: AsyncMutex::new(()),
                http,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            status,
            unlock,
            lock,
            sync_docs,
            load_docs,
            mark_doc_seen
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Holopad");
}

#[cfg(test)]
mod tests {
    use super::valid_repo;

    #[test]
    fn repo_validation() {
        assert!(valid_repo("nils/holopad"));
        assert!(valid_repo("Some-Org/repo.name_2"));
        assert!(!valid_repo("nils"));
        assert!(!valid_repo("nils/holo/pad"));
        assert!(!valid_repo("../etc"));
        assert!(!valid_repo("nils/holo pad"));
        assert!(!valid_repo("/holopad"));
    }
}
