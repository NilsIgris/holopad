// Construction des commandes /advert de contrôle aérien.
//   /advert *R* Laat/i-1004-L Demande autorisation décollage.
//   /advert *R* Laat/i-1004-L décollage.

export type FlightAction = "decollage" | "atterrissage";
export type AdvertMode = "demande" | "prevenir";

const WORDS: Record<FlightAction, string> = {
  decollage: "décollage",
  atterrissage: "atterrissage",
};

/** Première lettre (ou chiffre) du véhicule, en majuscule. */
export function vehicleLetter(vehicle: string): string {
  const match = vehicle.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase("fr-FR") : "";
}

export function callsignFor(vehicle: string, matricule: string): string {
  return `${vehicle.trim()}-${matricule.trim()}-${vehicleLetter(vehicle)}`;
}

export function buildAdvert(vehicle: string, matricule: string, action: FlightAction, mode: AdvertMode): string {
  const word = WORDS[action];
  const message = mode === "demande" ? `Demande autorisation ${word}.` : `${word}.`;
  return `/advert *R* ${callsignFor(vehicle, matricule)} ${message}`;
}
