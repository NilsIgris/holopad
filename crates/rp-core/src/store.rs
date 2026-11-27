//! Cache local des documents. Les fichiers restent chiffrés sur le disque ;
//! ils ne sont déchiffrés qu'en mémoire, à l'affichage.
//!
//! Disposition du dossier :
//!   index.json          dernier index appliqué
//!   <id>.enc            version courante
//!   <id>.prev.enc       version précédente, gardée tant que le changement n'est pas « vu »
//!   changes.json        { "<id>.enc": "changed" | "new" }

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::crypto::{self, KeyRecord};
use crate::index::{valid_file_name, Index};
use crate::Error;

const INDEX: &str = "index.json";
const CHANGES: &str = "changes.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Changed,
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Payload {
    key: String,
    title: String,
    character: String,
    markdown: String,
    changed_at: String,
}

/// Document prêt à afficher.
#[derive(Debug, Clone, Serialize)]
pub struct Doc {
    pub file: String,
    pub key: String,
    pub title: String,
    pub character: String,
    pub markdown: String,
    pub changed_at: String,
    pub status: Option<ChangeKind>,
    pub previous_markdown: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct ApplyReport {
    pub changed: usize,
    pub added: usize,
    pub removed: usize,
    pub rekeyed: bool,
}

pub struct Store {
    dir: PathBuf,
}

fn prev_name(file: &str) -> String {
    format!("{}.prev.enc", file.trim_end_matches(".enc"))
}

fn write_atomic(path: &Path, data: &[u8]) -> Result<(), Error> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

impl Store {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, Error> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn index(&self) -> Result<Option<Index>, Error> {
        match fs::read(self.dir.join(INDEX)) {
            Ok(raw) => Index::parse(&raw).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn changes(&self) -> BTreeMap<String, ChangeKind> {
        fs::read(self.dir.join(CHANGES))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn save_changes(&self, changes: &BTreeMap<String, ChangeKind>) -> Result<(), Error> {
        write_atomic(
            &self.dir.join(CHANGES),
            &serde_json::to_vec_pretty(changes)?,
        )
    }

    /// Copie les données embarquées dans l'installateur si le cache est vide.
    pub fn seed_from(&self, seed_dir: &Path) -> Result<bool, Error> {
        if self.index()?.is_some() {
            return Ok(false);
        }
        let raw = match fs::read(seed_dir.join(INDEX)) {
            Ok(raw) => raw,
            Err(_) => return Ok(false),
        };
        let index = Index::parse(&raw)?;
        let mut files = Vec::new();
        for entry in &index.docs {
            if let Ok(blob) = fs::read(seed_dir.join(&entry.file)) {
                files.push((entry.file.clone(), blob));
            }
        }
        self.apply(&raw, files)?;
        Ok(true)
    }

    /// Fichiers à télécharger pour passer de l'index local à `remote`.
    pub fn plan(&self, remote: &Index) -> Result<Vec<String>, Error> {
        let local = self.index()?;
        Ok(remote
            .docs
            .iter()
            .filter(|e| {
                let same = local.as_ref().and_then(|l| l.mac_of(&e.file)) == Some(e.mac.as_str());
                !same || !self.dir.join(&e.file).exists()
            })
            .map(|e| e.file.clone())
            .collect())
    }

    /// Applique un nouvel index et les fichiers téléchargés.
    pub fn apply(
        &self,
        remote_raw: &[u8],
        downloads: Vec<(String, Vec<u8>)>,
    ) -> Result<ApplyReport, Error> {
        let remote = Index::parse(remote_raw)?;
        let local = self.index()?;
        let mut report = ApplyReport::default();
        let rekeyed = local.as_ref().map(|l| l.kdf != remote.kdf).unwrap_or(false);
        let track = local.is_some() && !rekeyed;
        report.rekeyed = rekeyed;
        let mut changes = if rekeyed {
            BTreeMap::new()
        } else {
            self.changes()
        };

        for (file, blob) in downloads {
            if !valid_file_name(&file) || remote.mac_of(&file).is_none() {
                return Err(Error::Format(format!("fichier inattendu : {file:.40}")));
            }
            if !crypto::looks_encrypted(&blob) {
                return Err(Error::Format(
                    "fichier téléchargé non chiffré ou corrompu".into(),
                ));
            }
            let path = self.dir.join(&file);
            let prev = self.dir.join(prev_name(&file));
            if path.exists() {
                if track && !prev.exists() {
                    fs::rename(&path, &prev)?;
                }
                if track {
                    changes.entry(file.clone()).or_insert(ChangeKind::Changed);
                    report.changed += 1;
                }
            } else if track {
                changes.insert(file.clone(), ChangeKind::New);
                report.added += 1;
            }
            write_atomic(&path, &blob)?;
        }

        // Nettoyage des fichiers qui ne sont plus dans l'index distant.
        for entry in fs::read_dir(&self.dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let base = name.replace(".prev.enc", ".enc");
            let known = remote.mac_of(&base).is_some();
            let is_data = name.ends_with(".enc");
            if is_data && (!known || (rekeyed && name.ends_with(".prev.enc"))) {
                fs::remove_file(self.dir.join(&name))?;
                if !name.ends_with(".prev.enc") && local.is_some() {
                    report.removed += 1;
                }
            }
        }
        changes.retain(|file, _| remote.mac_of(file).is_some());
        self.save_changes(&changes)?;
        write_atomic(&self.dir.join(INDEX), remote_raw)?;
        Ok(report)
    }

    pub fn unlock(&self, passphrase: &str) -> Result<KeyRecord, Error> {
        let index = self.index()?.ok_or(Error::NoData)?;
        crypto::unlock(passphrase, &index)
    }

    fn decrypt_file(&self, key: &[u8; 32], name: &str, aad: &str) -> Result<Payload, Error> {
        let blob = fs::read(self.dir.join(name))?;
        let plain = crypto::decrypt(key, &blob, aad.as_bytes())?;
        serde_json::from_slice(&plain)
            .map_err(|e| Error::Format(format!("document illisible : {e}")))
    }

    pub fn load(&self, record: &KeyRecord) -> Result<Vec<Doc>, Error> {
        let index = self.index()?.ok_or(Error::NoData)?;
        if !record.matches(&index) {
            return Err(Error::Locked);
        }
        let key = record.key()?;
        let changes = self.changes();
        let mut docs = Vec::with_capacity(index.docs.len());
        for entry in &index.docs {
            let payload = match self.decrypt_file(&key, &entry.file, &entry.file) {
                Ok(p) => p,
                Err(Error::Io(_)) => continue, // fichier pas encore téléchargé
                Err(e) => return Err(e),
            };
            let status = changes.get(&entry.file).copied();
            let previous_markdown = if status == Some(ChangeKind::Changed) {
                self.decrypt_file(&key, &prev_name(&entry.file), &entry.file)
                    .ok()
                    .map(|p| p.markdown)
            } else {
                None
            };
            docs.push(Doc {
                file: entry.file.clone(),
                key: payload.key,
                title: payload.title,
                character: payload.character,
                markdown: payload.markdown,
                changed_at: payload.changed_at,
                status,
                previous_markdown,
            });
        }
        docs.sort_by_key(|d| d.title.to_lowercase());
        Ok(docs)
    }

    pub fn mark_seen(&self, file: &str) -> Result<(), Error> {
        if !valid_file_name(file) {
            return Err(Error::Format("nom de fichier refusé".into()));
        }
        let mut changes = self.changes();
        changes.remove(file);
        self.save_changes(&changes)?;
        let prev = self.dir.join(prev_name(file));
        if prev.exists() {
            fs::remove_file(prev)?;
        }
        Ok(())
    }

    pub fn pending_changes(&self) -> usize {
        self.changes().len()
    }
}
