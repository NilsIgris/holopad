// Personnages, véhicules et paramètres par défaut.
// Rien de sensible ici : le dépôt est public.

export type CharacterId = "gree" | "alpha" | "arkar";

export interface Character {
  id: CharacterId;
  label: string;
  /** Matricule utilisé dans les commandes /advert. */
  callsign: string;
}

export const CHARACTERS: readonly Character[] = [
  { id: "gree", label: "CC-1004 Gree", callsign: "1004" },
  { id: "alpha", label: "Alpha-34", callsign: "34" },
  { id: "arkar", label: "Général Ar'kar", callsign: "Ar'kar" },
];

/** Appareils volants de la Grande Armée de la République (modifiables dans les paramètres). */
export const GAR_VEHICLES: readonly string[] = [
  "Laat/i",
  "Laat/c",
  "ARC-170",
  "V-Wing",
  "Y-Wing",
  "Z-95",
  "Delta-7",
  "Eta-2",
  "Nu-Class",
];

export interface Settings {
  repo: string;
  alwaysOnTop: boolean;
  vehicles: Record<CharacterId, string[]>;
  alphaMatricule: string;
  alphaMembers: string[];
  lastCharacter: CharacterId;
}

export function defaultSettings(): Settings {
  return {
    repo: "",
    alwaysOnTop: true,
    vehicles: {
      gree: ["Laat/i"],
      alpha: [...GAR_VEHICLES],
      arkar: [...GAR_VEHICLES],
    },
    alphaMatricule: "A-34",
    alphaMembers: [],
    lastCharacter: "gree",
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  return [...new Set(list)];
}

/** Fusionne des paramètres lus sur le disque avec les valeurs par défaut. */
export function mergeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (typeof r.repo === "string") base.repo = r.repo.trim();
  if (typeof r.alwaysOnTop === "boolean") base.alwaysOnTop = r.alwaysOnTop;
  if (typeof r.alphaMatricule === "string" && r.alphaMatricule.trim()) base.alphaMatricule = r.alphaMatricule.trim();
  base.alphaMembers = stringList(r.alphaMembers) ?? base.alphaMembers;
  if (CHARACTERS.some((c) => c.id === r.lastCharacter)) base.lastCharacter = r.lastCharacter as CharacterId;
  if (r.vehicles && typeof r.vehicles === "object") {
    const v = r.vehicles as Record<string, unknown>;
    for (const c of CHARACTERS) {
      const list = stringList(v[c.id]);
      if (list && list.length) base.vehicles[c.id] = list;
    }
  }
  return base;
}
