//! Tests d'interopérabilité : données produites par le script Python
//! (`tools/sync_docs/make_test_vector.py`, contenu fictif).

use std::fs;
use std::path::{Path, PathBuf};

use rp_core::{ChangeKind, Error, Index, Store};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn passphrase() -> String {
    fs::read_to_string(fixtures().join("PASSPHRASE.txt"))
        .unwrap()
        .trim()
        .to_string()
}

fn read_version(v: &str) -> (Vec<u8>, Vec<(String, Vec<u8>)>) {
    let dir = fixtures().join(v);
    let raw = fs::read(dir.join("index.json")).unwrap();
    let index = Index::parse(&raw).unwrap();
    let files = index
        .docs
        .iter()
        .map(|e| (e.file.clone(), fs::read(dir.join(&e.file)).unwrap()))
        .collect();
    (raw, files)
}

fn store_with(v: &str) -> (tempfile::TempDir, Store) {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (raw, files) = read_version(v);
    store.apply(&raw, files).unwrap();
    (tmp, store)
}

#[test]
fn decrypts_python_output() {
    let (_tmp, store) = store_with("v1");
    let key = store.unlock(&passphrase()).unwrap();
    let docs = store.load(&key).unwrap();
    assert_eq!(docs.len(), 2);
    let alpha = docs.iter().find(|d| d.key == "alpha-test").unwrap();
    assert_eq!(alpha.character, "alpha");
    assert_eq!(alpha.title, "Document fictif");
    assert!(alpha.markdown.starts_with("# Règlement fictif"));
    assert_eq!(alpha.status, None, "la première synchro ne signale rien");
    let gree = docs.iter().find(|d| d.key == "gree-test").unwrap();
    assert!(gree.markdown.contains("# Page fictive"));
}

#[test]
fn wrong_passphrase_is_rejected() {
    let (_tmp, store) = store_with("v1");
    assert!(matches!(
        store.unlock("pas la bonne phrase"),
        Err(Error::WrongPassphrase)
    ));
}

#[test]
fn no_data_before_first_sync() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    assert!(matches!(store.unlock("x"), Err(Error::NoData)));
}

#[test]
fn update_tracks_changes_and_keeps_previous_version() {
    let (_tmp, store) = store_with("v1");
    let key = store.unlock(&passphrase()).unwrap();

    let (raw2, files2) = read_version("v2");
    let remote = Index::parse(&raw2).unwrap();
    let plan = store.plan(&remote).unwrap();
    assert_eq!(plan.len(), 1, "seul le document modifié est téléchargé");
    let downloads = files2
        .into_iter()
        .filter(|(f, _)| plan.contains(f))
        .collect();
    let report = store.apply(&raw2, downloads).unwrap();
    assert_eq!(report.changed, 1);
    assert!(!report.rekeyed);

    let docs = store.load(&key).unwrap();
    let alpha = docs.iter().find(|d| d.key == "alpha-test").unwrap();
    assert_eq!(alpha.status, Some(ChangeKind::Changed));
    assert!(alpha.markdown.contains("Article ajouté"));
    let prev = alpha.previous_markdown.as_deref().unwrap();
    assert!(!prev.contains("Article ajouté"));
    assert_eq!(store.pending_changes(), 1);

    store.mark_seen(&alpha.file).unwrap();
    let docs = store.load(&key).unwrap();
    let alpha = docs.iter().find(|d| d.key == "alpha-test").unwrap();
    assert_eq!(alpha.status, None);
    assert!(alpha.previous_markdown.is_none());
    assert_eq!(store.plan(&remote).unwrap().len(), 0);
}

#[test]
fn seed_is_used_only_when_cache_is_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    assert!(store.seed_from(&fixtures().join("v1")).unwrap());
    assert!(!store.seed_from(&fixtures().join("v2")).unwrap());
    let key = store.unlock(&passphrase()).unwrap();
    assert_eq!(store.load(&key).unwrap().len(), 2);
}

#[test]
fn rejects_path_traversal_in_index() {
    let (raw, _) = read_version("v1");
    let text = String::from_utf8(raw).unwrap();
    let first = Index::parse(text.as_bytes()).unwrap().docs[0].file.clone();
    let evil = text.replace(&first, "../../evil.enc");
    assert!(Index::parse(evil.as_bytes()).is_err());
}

#[test]
fn rejects_unencrypted_download() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Store::open(tmp.path()).unwrap();
    let (raw, files) = read_version("v1");
    let name = files[0].0.clone();
    let err = store.apply(&raw, vec![(name, b"<html>pas chiffre</html>".to_vec())]);
    assert!(err.is_err());
}

#[test]
fn removed_documents_are_deleted() {
    let (tmp, store) = store_with("v1");
    let (raw, _) = read_version("v1");
    let mut index: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    let removed = index["docs"][0]["file"].as_str().unwrap().to_string();
    index["docs"].as_array_mut().unwrap().remove(0);
    let report = store
        .apply(&serde_json::to_vec(&index).unwrap(), vec![])
        .unwrap();
    assert_eq!(report.removed, 1);
    assert!(!tmp.path().join(removed).exists());
}

#[test]
fn key_from_another_index_is_locked() {
    let (_tmp, store) = store_with("v1");
    let mut key = store.unlock(&passphrase()).unwrap();
    key.salt = "AAAAAAAAAAAAAAAAAAAAAA==".into();
    assert!(matches!(store.load(&key), Err(Error::Locked)));
}
