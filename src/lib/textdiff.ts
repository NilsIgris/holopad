// Comparaison ligne à ligne entre deux versions d'un document.

import { diffLines } from "diff";

export type DiffRow =
  | { kind: "add" | "del" | "ctx"; text: string }
  | { kind: "skip"; count: number };

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
}

export function computeDiff(before: string, after: string, context = 2): DiffResult {
  // Fin de texte homogène : sinon la dernière ligne apparaît toujours modifiée.
  const norm = (s: string) => (s.endsWith("\n") ? s : s + "\n");
  const parts = diffLines(norm(before), norm(after));
  const flat: { kind: "add" | "del" | "ctx"; text: string }[] = [];
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const kind = part.added ? "add" : part.removed ? "del" : "ctx";
    const lines = part.value.replace(/\n$/, "").split("\n");
    for (const text of lines) flat.push({ kind, text });
    if (kind === "add") added += lines.length;
    if (kind === "del") removed += lines.length;
  }

  // Ne garde que `context` lignes autour des changements.
  const keep = new Array<boolean>(flat.length).fill(false);
  flat.forEach((row, i) => {
    if (row.kind === "ctx") return;
    for (let j = Math.max(0, i - context); j <= Math.min(flat.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  flat.forEach((row, i) => {
    if (keep[i]) {
      if (skipped) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ kind: "skip", count: skipped });
  return { rows, added, removed };
}
