// Simulation de la partie Rust pour `npm run dev` dans un navigateur.
// Contenu 100 % fictif : les vrais documents ne sont jamais dans le dépôt.
// Ce fichier n'est chargé qu'en mode développement.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const REGLEMENT_V1 = `# ***Règlement d'exemple***

---

*Document fictif utilisé pour prévisualiser l'interface.*

## ***Article 1 : Comportement***

***1.01** : Chaque membre doit faire honneur à son unité.*

***1.02** : Les ordres du commandement de mission sont suivis.*

## ***Article 2 : Véhicules***

***2.01** : Tout décollage est annoncé sur la radio.*`;

const REGLEMENT_V2 = REGLEMENT_V1.replace(
  "***2.01** : Tout décollage est annoncé sur la radio.*",
  "***2.01** : Tout décollage et tout atterrissage sont annoncés sur la radio.*\n\n***2.02** : Le hangar doit être dégagé avant l'atterrissage.*",
);

const GRILLE = String.raw`# **Recrutement d'exemple**

## **Le test est subdivisé comme suit :**

- Théorique                       →   /9
  *Minimum   6/9*
- Tir de précision              →   /6
- Ordre                             →   /5
  *Minimum   5/5*

**Total   /20**
***Minimum requis 15/20***

# **Théorique**

**1.1 :** Question fictive numéro un ?  **/3**
*Réponse fictive*

**1.2 :** Question fictive numéro deux ?  **/3**
*Autre réponse*

**1.3 :** Question fictive numéro trois ?  **/3**
*Voir document*

# **Ordre**

## *Éliminatoire*

**2.1 :** Situation fictive à noter.
`;

interface MockDoc {
  file: string;
  key: string;
  title: string;
  character: string;
  markdown: string;
  changed_at: string;
  status: "changed" | "new" | null;
  previous_markdown: string | null;
}

const docs: MockDoc[] = [
  { file: "a".repeat(24) + ".enc", key: "alpha-reglement", title: "[Exemple] Règlement", character: "alpha", markdown: REGLEMENT_V2, changed_at: "2026-11-26T05:00:00Z", status: "changed", previous_markdown: REGLEMENT_V1 },
  { file: "b".repeat(24) + ".enc", key: "alpha-grille", title: "[Exemple] Test de recrutement", character: "alpha", markdown: GRILLE, changed_at: "2026-11-01T05:00:00Z", status: null, previous_markdown: null },
  { file: "c".repeat(24) + ".enc", key: "gree-rp", title: "[Exemple] Règlement RP", character: "gree", markdown: REGLEMENT_V1, changed_at: "2026-11-01T05:00:00Z", status: "new", previous_markdown: null },
  { file: "d".repeat(24) + ".enc", key: "arkar-shock", title: "[Exemple] Règlement Shock", character: "arkar", markdown: REGLEMENT_V1, changed_at: "2026-11-01T05:00:00Z", status: null, previous_markdown: null },
];

export function installMock() {
  let unlocked = new URLSearchParams(location.search).has("unlocked");
  let settings: unknown = { alphaMembers: ["A-12", "A-17", "A-77"], lastCharacter: new URLSearchParams(location.search).get("c") ?? "alpha" };
  mockWindows("main");
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_settings":
        return settings;
      case "save_settings":
        settings = a.settings;
        return null;
      case "status":
        return { has_data: true, unlocked, repo: "exemple/holopad", pending_changes: docs.filter((d) => d.status).length, generated_at: "2026-11-27T05:00:00Z", version: "0.1.0-dev" };
      case "unlock":
        if (a.passphrase === "faux") throw "phrase de passe incorrecte";
        unlocked = true;
        return null;
      case "lock":
        unlocked = false;
        return null;
      case "sync_docs":
        return new Promise((r) => setTimeout(() => r({ downloaded: 0, report: { changed: 0, added: 0, removed: 0, rekeyed: false }, generated_at: "2026-11-27T05:00:00Z" }), 400));
      case "load_docs":
        if (!unlocked) throw "documents verrouillés";
        return docs;
      case "mark_doc_seen": {
        const d = docs.find((x) => x.file === a.file);
        if (d) {
          d.status = null;
          d.previous_markdown = null;
        }
        return null;
      }
      case "plugin:clipboard-manager|write_text":
        return null;
      case "plugin:updater|check":
        return null;
      default:
        return null;
    }
  });
}
