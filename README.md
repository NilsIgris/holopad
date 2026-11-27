# Holopad

Tableau de bord Windows pour le RP Clone Wars sur Garry's Mod : une fenêtre étroite à garder sur le côté de l'écran.

- **Advert** : choisir le personnage, le véhicule et « demander » ou « prévenir ». La commande `/advert` est prête, un clic la copie.
- **Documents** : règlements et documents de chaque personnage, lisibles **hors ligne**, avec recherche, sommaire et alerte quand un document change (passages modifiés surlignés).
- **Grille** (Alpha) : notation des tests de recrutement. Le barème est lu dans le document de recrutement ; le rapport est prêt à coller sur Discord.
- **Présence** (Alpha) : fiche de présence de mission générée et copiée en un clic.

## Sécurité : dépôt public, documents protégés

Le dépôt est public, mais **les documents n'y sont jamais en clair** :

| Élément | Où il se trouve |
|---|---|
| Liens des documents (Google Docs / Sites) | Secret GitHub `DOCS_SOURCES` uniquement |
| Phrase de passe | Secret GitHub `DOCS_PASSPHRASE` + Gestionnaire d'identification Windows du PC |
| Contenu, titres, barème des tests | Fichiers chiffrés AES-256-GCM sur la branche `docs-data`, dans l'installateur et dans le cache local |

Sans la phrase de passe, l'application installée et la branche `docs-data` ne montrent rien. Un test de la CI échoue si un lien de document est un jour commité par erreur.

À savoir : le dépôt ne change rien à l'accès aux Google Docs eux-mêmes. Toute personne qui possède un lien peut toujours les ouvrir.

## Mise en place (une seule fois)

### 1. Créer le dépôt

Créer un dépôt **public** sur GitHub (par exemple `holopad`), puis :

```bash
git remote add origin https://github.com/<vous>/holopad.git
git push -u origin main
```

### 2. Secrets des documents

Dans *Settings → Secrets and variables → Actions → New repository secret* :

- `DOCS_PASSPHRASE` : une phrase de passe longue (au moins 4 mots, par exemple `Kamino pluie hangar 41`). C'est elle qui sera demandée au premier lancement de l'application.
- `DOCS_SOURCES` : la liste des documents au format JSON. Le fichier `DOCS_SOURCES.secret.json` fourni à part contient la liste déjà remplie. **Ne le commitez pas.** Format :

```json
{
  "documents": [
    { "key": "alpha-reglement", "title": "Règlement Alpha", "character": "alpha", "kind": "gdoc", "id": "VOTRE_ID" },
    { "key": "gree-reglement-rp", "title": "Règlement RP", "character": "gree", "kind": "gsite", "url": "https://sites.google.com/view/…" }
  ]
}
```

`character` vaut `gree`, `alpha` ou `arkar`. `kind` vaut `gdoc` (Google Doc, champ `id` = la partie entre `/d/` et `/edit` du lien) ou `gsite` (page Google Sites, champ `url`). Les documents doivent être partagés en « Tous les utilisateurs disposant du lien ».

### 3. Clé de signature des mises à jour

Elle garantit que l'application n'installe que des mises à jour qui viennent de vous :

```bash
npx tauri signer generate -w holopad.key
```

- Secret `TAURI_SIGNING_PRIVATE_KEY` : le contenu du fichier `holopad.key`
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : le mot de passe choisi
- **Variable** (onglet *Variables*) `TAURI_UPDATER_PUBKEY` : le contenu de `holopad.key.pub`

Gardez `holopad.key` en lieu sûr, hors du dépôt. Si vous le perdez, les applications déjà installées ne pourront plus se mettre à jour toutes seules : il faudra réinstaller.

### 4. Premier lancement des workflows

Dans l'onglet *Actions* :

1. **Synchronisation des documents** → *Run workflow*. Cela crée la branche `docs-data`. Le résumé indique les documents récupérés.
2. **Publier une version** → *Run workflow*, champ vide. Cela crée la version `v0.0.1` avec l'installateur.

### 5. Installer

Télécharger `Holopad_x.y.z_x64-setup.exe` dans *Releases* et l'installer. L'installateur n'est pas signé avec un certificat commercial : Windows SmartScreen affiche un avertissement au premier lancement (*Informations complémentaires → Exécuter quand même*).

Au premier lancement : onglet **Documents** → saisir la phrase de passe.

## Ce qui est automatique

| Workflow | Quand | Rôle |
|---|---|---|
| Synchronisation des documents | Tous les jours vers 5 h–6 h, ou à la demande | Récupère les documents, les chiffre, publie seulement si quelque chose a changé |
| CI | À chaque push et PR | Tests Python, TypeScript et Rust, compilation Windows |
| Publier une version | À la demande | Construit, signe et publie l'installateur ; les applications installées se mettent à jour |
| Dependabot | Chaque semaine | Ouvre des PR de mise à jour des dépendances, testées par la CI |

Côté application : synchronisation au démarrage puis toutes les 3 heures. Seuls les documents modifiés sont téléchargés, quelques Ko. Sans connexion, le cache local est utilisé.

GitHub suspend les workflows planifiés d'un dépôt public après 60 jours sans activité. Si cela arrive, un clic sur *Enable workflow* les relance.

## Changer la phrase de passe

Modifier le secret `DOCS_PASSPHRASE`, puis lancer **Synchronisation des documents**. Tout est rechiffré, et l'application redemande la phrase à la synchronisation suivante.

## Développement

Prérequis : Node 22, Rust stable, Python 3.12.

```bash
npm install
npm run dev          # interface dans le navigateur, avec des données fictives
npx tauri dev        # application complète
npm test             # tests de l'interface
cargo test --workspace
pip install -r tools/sync_docs/requirements.txt && python -m pytest tools/sync_docs
```

Organisation :

- `src/` : interface (TypeScript, lit-html). La logique testée est dans `src/lib/`.
- `src-tauri/` : application Tauri (commandes, synchronisation, Gestionnaire d'identification Windows).
- `crates/rp-core/` : déchiffrement et cache, testés avec des données produites par le script Python.
- `tools/sync_docs/` : récupération et chiffrement des documents (workflow).

Les véhicules de chaque personnage se modifient directement dans l'application (Paramètres).
