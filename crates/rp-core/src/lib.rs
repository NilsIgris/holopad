//! Cœur de Holopad, indépendant de Tauri pour être testé facilement.

pub mod crypto;
pub mod index;
pub mod store;

pub use crypto::KeyRecord;
pub use index::Index;
pub use store::{ApplyReport, ChangeKind, Doc, Store};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("phrase de passe incorrecte")]
    WrongPassphrase,
    #[error("documents verrouillés : saisissez la phrase de passe")]
    Locked,
    #[error("clé invalide pour ces données")]
    BadKey,
    #[error("aucun document en cache : lancez une synchronisation")]
    NoData,
    #[error("{0}")]
    Format(String),
    #[error("erreur disque : {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON : {0}")]
    Json(#[from] serde_json::Error),
}
