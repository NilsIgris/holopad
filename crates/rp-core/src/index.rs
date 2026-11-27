use serde::{Deserialize, Serialize};

use crate::Error;

pub const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Kdf {
    pub alg: String,
    pub iterations: u32,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub file: String,
    pub mac: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Index {
    pub format: u32,
    pub kdf: Kdf,
    pub check: String,
    pub generated_at: String,
    pub docs: Vec<Entry>,
}

/// Nom de fichier attendu : 24 caractères hexadécimaux + ".enc".
/// Empêche toute traversée de répertoire via un index modifié.
pub fn valid_file_name(name: &str) -> bool {
    name.len() == 28
        && name.ends_with(".enc")
        && name[..24]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Index {
    pub fn parse(raw: &[u8]) -> Result<Self, Error> {
        let index: Index = serde_json::from_slice(raw)
            .map_err(|e| Error::Format(format!("index illisible : {e}")))?;
        if index.format != FORMAT_VERSION {
            return Err(Error::Format(format!(
                "format d'index {} non pris en charge, mettez l'application à jour",
                index.format
            )));
        }
        if let Some(bad) = index.docs.iter().find(|e| !valid_file_name(&e.file)) {
            return Err(Error::Format(format!(
                "nom de fichier refusé : {:.40}",
                bad.file
            )));
        }
        Ok(index)
    }

    pub fn mac_of(&self, file: &str) -> Option<&str> {
        self.docs
            .iter()
            .find(|e| e.file == file)
            .map(|e| e.mac.as_str())
    }
}
