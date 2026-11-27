// Fiche de présence ARC Alpha.

export interface PresenceInput {
  matricule: string;
  date: Date;
  present: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 25/11/2026 18h00 */
export function formatMissionDate(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

/** Arrondit au quart d'heure le plus proche (18h07 → 18h00, 18h08 → 18h15). */
export function roundToQuarter(d: Date): Date {
  const r = new Date(d);
  const minutes = Math.round(r.getMinutes() / 15) * 15;
  r.setMinutes(minutes, 0, 0);
  return r;
}

/** Valeur pour un <input type="datetime-local"> (heure locale). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Découpe « A-12, A-17 ; A-99 » en liste propre. */
export function splitNames(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildPresence({ matricule, date, present }: PresenceInput): string {
  const others = [...new Set(present.map((p) => p.trim()).filter((p) => p && p !== matricule.trim()))];
  return [
    `Matricule / nom de l'Arc Alpha : ${matricule.trim()}`,
    `Date de la mission : ${formatMissionDate(date)}`,
    `Arc Alpha présents : ${others.length ? others.join(", ") : "N/A"}`,
  ].join("\n");
}
