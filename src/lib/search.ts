// Recherche insensible à la casse et aux accents.

/** Replie chaque caractère individuellement pour garder les positions alignées. */
export function foldChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const folded = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += folded.length === ch.length ? folded : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

/** Positions [début, fin[ des occurrences de `query` dans `text`. */
export function findMatches(text: string, query: string): [number, number][] {
  const q = foldChars(query.trim());
  if (q.length < 2) return [];
  const hay = foldChars(text);
  const out: [number, number][] = [];
  let i = hay.indexOf(q);
  while (i !== -1) {
    out.push([i, i + q.length]);
    i = hay.indexOf(q, i + q.length);
  }
  return out;
}

export function countMatches(text: string, query: string): number {
  return findMatches(text, query).length;
}
