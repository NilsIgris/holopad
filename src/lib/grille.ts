// Grille de notation des tests de recrutement.
//
// Le barème n'est PAS dans le code (dépôt public) : il est lu dans le document
// de recrutement déchiffré. Format attendu (export Markdown de Google Docs) :
//
//   - Théorique   →   /30
//     *Minimum 20/30*
//   **Total /100**
//   ***Minimum requis 80/100***
//   # **Théorique**
//   **1.1 :** Question ?  **/3**
//   *Réponse attendue*

export interface Question {
  id: string;
  text: string;
  points: number | null;
  reference: string;
}

export interface Section {
  name: string;
  max: number;
  min: number | null;
  notes: string[];
  questions: Question[];
}

export interface Grille {
  title: string;
  sections: Section[];
  total: number;
  minTotal: number | null;
}

export interface ScoreState {
  /** Note saisie directement, par nom de section. */
  sections: Record<string, number | null | undefined>;
  /** Note par question (id). */
  questions: Record<string, number | null | undefined>;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const toNum = (s: string) => Number(s.replace(",", "."));

/** Retire l'emphase Markdown et les échappements, normalise les espaces. */
export function cleanInline(text: string): string {
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clé de comparaison : minuscules, sans accents ni ponctuation. */
export function normKey(text: string): string {
  return cleanInline(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseGrille(markdown: string): Grille | null {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const sections: Section[] = [];
  let title = "";
  let total: number | null = null;
  let minTotal: number | null = null;
  let lastSummary: Section | null = null;

  // 1er passage : récapitulatif du barème.
  for (const raw of lines) {
    const bullet = raw.match(/^\s*[-+*]\s+(.*)$/);
    const text = cleanInline(bullet ? bullet[1] : raw);
    if (!title) {
      const h = raw.match(/^#{1,6}\s+(.*)$/);
      if (h && cleanInline(h[1])) title = cleanInline(h[1]);
    }
    let m: RegExpMatchArray | null;
    if (bullet && (m = text.match(new RegExp(`^(.+?)\\s*(?:→|->|=>|:)\\s*/\\s*${NUM}$`)))) {
      const name = m[1].trim();
      if (!sections.some((s) => normKey(s.name) === normKey(name))) {
        lastSummary = { name, max: toNum(m[2]), min: null, notes: [], questions: [] };
        sections.push(lastSummary);
      }
      continue;
    }
    if ((m = text.match(new RegExp(`^minimum requis\\s*:?\\s*${NUM}\\s*/\\s*${NUM}$`, "i")))) {
      minTotal = toNum(m[1]);
      lastSummary = null;
      continue;
    }
    if (lastSummary && (m = text.match(new RegExp(`^minimum\\s*:?\\s*${NUM}\\s*/\\s*${NUM}$`, "i")))) {
      lastSummary.min = toNum(m[1]);
      continue;
    }
    if ((m = text.match(new RegExp(`^total\\s*:?\\s*/\\s*${NUM}$`, "i")))) {
      total = toNum(m[1]);
      lastSummary = null;
    }
  }
  if (sections.length < 2) return null;
  if (total === null) total = sections.reduce((acc, s) => acc + s.max, 0);

  // 2e passage : questions rattachées aux titres qui portent le nom d'une section.
  let current: Section | null = null;
  let currentLevel = 0;
  let question: Question | null = null;
  const refLines: string[] = [];
  const flush = () => {
    if (question) question.reference = refLines.join("\n").trim();
    refLines.length = 0;
    question = null;
  };

  for (const raw of lines) {
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = cleanInline(heading[2]);
      const target = sections.find((s) => normKey(s.name) === normKey(text));
      if (target) {
        current = target;
        currentLevel = level;
      } else if (current && level > currentLevel) {
        if (text) current.notes.push(text);
      } else {
        current = null;
      }
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      flush();
      continue;
    }
    if (!current) continue;
    const text = cleanInline(raw);
    const q = text.match(/^(\d+)\.(\d+)\s*:\s*(.*)$/);
    if (q) {
      flush();
      let body = q[3];
      let points: number | null = null;
      const p = body.match(new RegExp(`(?:^|\\s)/\\s*${NUM}(?=\\s|$)`));
      if (p) {
        points = toNum(p[1]);
        body = (body.slice(0, p.index) + " " + body.slice((p.index ?? 0) + p[0].length)).replace(/\s+/g, " ").trim();
      }
      question = { id: `${q[1]}.${q[2]}`, text: body, points, reference: "" };
      current.questions.push(question);
      continue;
    }
    if (question && text) refLines.push(text);
  }
  flush();
  return { title, sections, total, minTotal };
}

// ---------------------------------------------------------------------------

export interface SectionResult {
  name: string;
  score: number;
  max: number;
  min: number | null;
  ok: boolean;
  complete: boolean;
}

export interface Evaluation {
  sections: SectionResult[];
  total: number;
  max: number;
  minTotal: number | null;
  passed: boolean;
  complete: boolean;
  reasons: string[];
  /** Somme des maxima différente du total annoncé dans le document. */
  maxMismatch: boolean;
}

const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ","));

export function hasScoredQuestions(section: Section): boolean {
  return section.questions.some((q) => q.points !== null);
}

export function evaluate(grille: Grille, state: ScoreState): Evaluation {
  const reasons: string[] = [];
  const sections = grille.sections.map((s): SectionResult => {
    let score = 0;
    let complete = true;
    if (hasScoredQuestions(s)) {
      for (const q of s.questions) {
        if (q.points === null) continue;
        const v = state.questions[q.id];
        if (v === null || v === undefined || Number.isNaN(v)) complete = false;
        else score += clamp(v, q.points);
      }
      score = clamp(score, s.max);
    } else {
      const v = state.sections[s.name];
      if (v === null || v === undefined || Number.isNaN(v)) complete = false;
      else score = clamp(v, s.max);
    }
    const ok = s.min === null || score >= s.min;
    if (!ok) reasons.push(`${s.name} sous le minimum (${fmt(score)}/${fmt(s.max)}, minimum ${fmt(s.min!)})`);
    return { name: s.name, score, max: s.max, min: s.min, ok, complete };
  });
  const total = sections.reduce((acc, s) => acc + s.score, 0);
  if (grille.minTotal !== null && total < grille.minTotal) {
    reasons.push(`Total insuffisant (${fmt(total)}/${fmt(grille.total)}, minimum ${fmt(grille.minTotal)})`);
  }
  const sumMax = grille.sections.reduce((acc, s) => acc + s.max, 0);
  return {
    sections,
    total,
    max: grille.total,
    minTotal: grille.minTotal,
    passed: reasons.length === 0,
    complete: sections.every((s) => s.complete),
    reasons,
    maxMismatch: Math.abs(sumMax - grille.total) > 1e-9,
  };
}

export interface ReportMeta {
  candidate: string;
  evaluator: string;
  date: string;
  remarks: string;
}

export function buildReport(grille: Grille, ev: Evaluation, meta: ReportMeta): string {
  const lines = [
    `**${grille.title || "Recrutement"}**`,
    `Candidat : ${meta.candidate.trim() || "N/A"}`,
    `Évaluateur : ${meta.evaluator.trim() || "N/A"}`,
    `Date : ${meta.date}`,
    "",
  ];
  for (const s of ev.sections) {
    const min = s.min !== null ? ` (min. ${fmt(s.min)})` : "";
    const mark = s.min !== null ? (s.ok ? " ✅" : " ❌") : "";
    lines.push(`${s.name} : ${fmt(s.score)}/${fmt(s.max)}${min}${mark}`);
  }
  const minTotal = ev.minTotal !== null ? ` (min. ${fmt(ev.minTotal)})` : "";
  lines.push("", `**Total : ${fmt(ev.total)}/${fmt(ev.max)}${minTotal} — ${ev.passed ? "ADMIS ✅" : "REFUSÉ ❌"}**`);
  if (!ev.passed) lines.push(...ev.reasons.map((r) => `- ${r}`));
  if (meta.remarks.trim()) lines.push("", `Remarques : ${meta.remarks.trim()}`);
  return lines.join("\n");
}
