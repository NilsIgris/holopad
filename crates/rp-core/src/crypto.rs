//! Cryptographie — miroir exact de `tools/sync_docs/sync_docs.py`.
//!
//! master = PBKDF2-HMAC-SHA256(phrase, sel, itérations, 32 octets)
//! enc    = HMAC-SHA256(master, "holopad/enc")
//! fichier chiffré = "HPD1" || nonce(12) || AES-256-GCM(enc, clair, aad = nom du fichier)

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

use crate::index::Index;
use crate::Error;

pub const MAGIC: &[u8; 4] = b"HPD1";
const CHECK_PLAINTEXT: &[u8] = b"holopad-check-v1";
const MIN_ITERATIONS: u32 = 1_000;
const MAX_ITERATIONS: u32 = 10_000_000;

/// Clé de déchiffrement, liée au sel de l'index qui l'a produite.
/// C'est ce qui est rangé dans le Gestionnaire d'identification Windows.
#[derive(Clone, Serialize, Deserialize)]
pub struct KeyRecord {
    pub salt: String,
    pub iterations: u32,
    pub enc_key: String,
}

impl std::fmt::Debug for KeyRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyRecord")
            .field("salt", &self.salt)
            .finish_non_exhaustive()
    }
}

impl KeyRecord {
    pub fn matches(&self, index: &Index) -> bool {
        self.salt == index.kdf.salt && self.iterations == index.kdf.iterations
    }

    pub fn key(&self) -> Result<[u8; 32], Error> {
        let bytes = hex::decode(&self.enc_key).map_err(|_| Error::BadKey)?;
        bytes.try_into().map_err(|_| Error::BadKey)
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepte toute taille de clé");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Dérive la clé à partir de la phrase de passe et vérifie qu'elle ouvre l'index.
pub fn unlock(passphrase: &str, index: &Index) -> Result<KeyRecord, Error> {
    if index.kdf.alg != "pbkdf2-sha256" {
        return Err(Error::Format("algorithme de dérivation inconnu".into()));
    }
    let iterations = index.kdf.iterations;
    if !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&iterations) {
        return Err(Error::Format("nombre d'itérations hors limites".into()));
    }
    let salt = B64
        .decode(&index.kdf.salt)
        .map_err(|_| Error::Format("sel invalide".into()))?;
    let mut master = [0u8; 32];
    pbkdf2::pbkdf2::<Hmac<Sha256>>(passphrase.as_bytes(), &salt, iterations, &mut master)
        .map_err(|_| Error::Format("dérivation impossible".into()))?;
    let mut enc = hmac_sha256(&master, b"holopad/enc");
    master.zeroize();

    let check = B64
        .decode(&index.check)
        .map_err(|_| Error::Format("contrôle invalide".into()))?;
    let ok = decrypt(&enc, &check, b"check")
        .map(|p| p == CHECK_PLAINTEXT)
        .unwrap_or(false);
    if !ok {
        enc.zeroize();
        return Err(Error::WrongPassphrase);
    }
    let record = KeyRecord {
        salt: index.kdf.salt.clone(),
        iterations,
        enc_key: hex::encode(enc),
    };
    enc.zeroize();
    Ok(record)
}

pub fn decrypt(key: &[u8; 32], blob: &[u8], aad: &[u8]) -> Result<Vec<u8>, Error> {
    if blob.len() < MAGIC.len() + 12 + 16 || &blob[..4] != MAGIC {
        return Err(Error::Format("fichier chiffré invalide".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| Error::BadKey)?;
    let nonce = Nonce::from_slice(&blob[4..16]);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &blob[16..],
                aad,
            },
        )
        .map_err(|_| Error::BadKey)
}

pub fn looks_encrypted(blob: &[u8]) -> bool {
    blob.len() >= MAGIC.len() + 12 + 16 && &blob[..4] == MAGIC
}
