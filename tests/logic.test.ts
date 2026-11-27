import { describe, expect, it } from "vitest";
import { buildAdvert, callsignFor, vehicleLetter } from "../src/lib/advert";
import { CHARACTERS, defaultSettings, mergeSettings } from "../src/lib/config";
import { buildReport, cleanInline, evaluate, parseGrille } from "../src/lib/grille";
import { buildPresence, formatMissionDate, fromLocalInput, roundToQuarter, splitNames, toLocalInput } from "../src/lib/presence";
import { countMatches, findMatches } from "../src/lib/search";
import { computeDiff } from "../src/lib/textdiff";

describe("advert", () => {
  it("reproduit exactement les deux exemples donnés", () => {
    expect(buildAdvert("Laat/i", "1004", "decollage", "demande")).toBe(
      "/advert *R* Laat/i-1004-L Demande autorisation décollage.",
    );
    expect(buildAdvert("Laat/i", "1004", "decollage", "prevenir")).toBe("/advert *R* Laat/i-1004-L décollage.");
  });

  it("gère l'atterrissage et les trois personnages", () => {
    expect(buildAdvert("ARC-170", "34", "atterrissage", "demande")).toBe(
      "/advert *R* ARC-170-34-A Demande autorisation atterrissage.",
    );
    expect(buildAdvert("Delta-7", "Ar'kar", "atterrissage", "prevenir")).toBe("/advert *R* Delta-7-Ar'kar-D atterrissage.");
    expect(CHARACTERS.map((c) => c.callsign)).toEqual(["1004", "34", "Ar'kar"]);
  });

  it("calcule la lettre du véhicule", () => {
    expect(vehicleLetter("laat/c")).toBe("L");
    expect(vehicleLetter("  v-wing")).toBe("V");
    expect(vehicleLetter("Éta-2")).toBe("É");
    expect(callsignFor(" Y-Wing ", " 34 ")).toBe("Y-Wing-34-Y");
  });
});

describe("paramètres", () => {
  it("Gree ne pilote que le Laat/i par défaut", () => {
    const s = defaultSettings();
    expect(s.vehicles.gree).toEqual(["Laat/i"]);
    expect(s.vehicles.alpha.length).toBeGreaterThan(5);
  });

  it("fusionne et nettoie les paramètres enregistrés", () => {
    const s = mergeSettings({
      repo: " nils/holopad ",
      vehicles: { gree: ["Laat/i", "Laat/i", " ", 3], alpha: [] },
      alphaMembers: ["A-12", "A-12", "A-17"],
      alwaysOnTop: false,
    });
    expect(s.repo).toBe("nils/holopad");
    expect(s.vehicles.gree).toEqual(["Laat/i"]);
    expect(s.vehicles.alpha).toEqual(defaultSettings().vehicles.alpha); // liste vide ignorée
    expect(s.alphaMembers).toEqual(["A-12", "A-17"]);
    expect(s.alwaysOnTop).toBe(false);
    expect(mergeSettings(null)).toEqual(defaultSettings());
  });
});

describe("présence", () => {
  it("reproduit le modèle", () => {
    const text = buildPresence({ matricule: "A-34", date: new Date(2026, 10, 25, 18, 0), present: [] });
    expect(text).toBe(
      "Matricule / nom de l'Arc Alpha : A-34\nDate de la mission : 25/11/2026 18h00\nArc Alpha présents : N/A",
    );
  });

  it("liste les autres Alphas sans doublon ni soi-même", () => {
    const text = buildPresence({ matricule: "A-34", date: new Date(2026, 0, 5, 9, 5), present: ["A-12", "A-34", " A-12", "A-77"] });
    expect(text.split("\n")[2]).toBe("Arc Alpha présents : A-12, A-77");
    expect(formatMissionDate(new Date(2026, 0, 5, 9, 5))).toBe("05/01/2026 09h05");
  });

  it("arrondit et convertit les dates", () => {
    expect(formatMissionDate(roundToQuarter(new Date(2026, 10, 25, 18, 7)))).toBe("25/11/2026 18h00");
    expect(formatMissionDate(roundToQuarter(new Date(2026, 10, 25, 18, 53)))).toBe("25/11/2026 19h00");
    const d = new Date(2026, 10, 25, 18, 30);
    expect(fromLocalInput(toLocalInput(d))?.getTime()).toBe(d.getTime());
    expect(fromLocalInput("n'importe quoi")).toBeNull();
    expect(splitNames("A-12, A-17 ;A-99\n")).toEqual(["A-12", "A-17", "A-99"]);
  });
});

// Document de recrutement FICTIF au format de l'export Markdown de Google Docs.
const FAKE_TEST = String.raw`# **Recrutement Exemple**

---

## **Le test est subdivisé comme suit :**

- Culture                       →   /9
  *Minimum   6/9*
- Tir                           →   /5
- Discipline                    →   /6
  *Minimum   6/6*

**Total   /20**
***Minimum requis 15/20***

---

# **Culture**

**1.1 :** Couleur du ciel par beau temps ?  **/3**
*Bleu*

**1.2 :** Combien de pattes \- en tout \- pour deux chats ?  **/3** (compter)
*Huit*

**1.3 :** Citer trois planètes.  **/3**
*Voir document annexe*

# **Discipline**

## *Éliminatoire pour les 2*

**2.1 :** Situation fictive.
Contexte :
*A NOTER*

**2.2 :** Seconde situation.
`;

describe("grille", () => {
  const grille = parseGrille(FAKE_TEST)!;

  it("lit le barème depuis le document", () => {
    expect(grille).not.toBeNull();
    expect(grille.title).toBe("Recrutement Exemple");
    expect(grille.total).toBe(20);
    expect(grille.minTotal).toBe(15);
    expect(grille.sections.map((s) => [s.name, s.max, s.min])).toEqual([
      ["Culture", 9, 6],
      ["Tir", 5, null],
      ["Discipline", 6, 6],
    ]);
  });

  it("rattache les questions et réponses aux sections", () => {
    const culture = grille.sections[0];
    expect(culture.questions.map((q) => [q.id, q.points])).toEqual([
      ["1.1", 3],
      ["1.2", 3],
      ["1.3", 3],
    ]);
    expect(culture.questions[0].reference).toBe("Bleu");
    expect(culture.questions[1].text).toBe("Combien de pattes - en tout - pour deux chats ? (compter)");
    const discipline = grille.sections[2];
    expect(discipline.notes).toEqual(["Éliminatoire pour les 2"]);
    expect(discipline.questions.map((q) => [q.id, q.points])).toEqual([
      ["2.1", null],
      ["2.2", null],
    ]);
    expect(discipline.questions[0].reference).toBe("Contexte :\nA NOTER");
  });

  it("calcule une réussite", () => {
    const ev = evaluate(grille, {
      questions: { "1.1": 3, "1.2": 3, "1.3": 1.5 },
      sections: { Tir: 4, Discipline: 6 },
    });
    expect(ev.total).toBe(17.5);
    expect(ev.passed).toBe(true);
    expect(ev.complete).toBe(true);
    expect(ev.maxMismatch).toBe(false);
    const report = buildReport(grille, ev, { candidate: "CT-1234", evaluator: "A-34", date: "27/11/2026", remarks: "" });
    expect(report).toContain("Culture : 7,5/9 (min. 6) ✅");
    expect(report).toContain("Tir : 4/5\n");
    expect(report).toContain("**Total : 17,5/20 (min. 15) — ADMIS ✅**");
    expect(report).toContain("Candidat : CT-1234");
  });

  it("refuse si un minimum éliminatoire n'est pas atteint, même avec un bon total", () => {
    const ev = evaluate(grille, {
      questions: { "1.1": 3, "1.2": 3, "1.3": 3 },
      sections: { Tir: 5, Discipline: 3 },
    });
    expect(ev.total).toBe(17);
    expect(ev.passed).toBe(false);
    expect(ev.reasons[0]).toContain("Discipline sous le minimum");
    const report = buildReport(grille, ev, { candidate: "", evaluator: "A-34", date: "x", remarks: "À revoir" });
    expect(report).toContain("REFUSÉ ❌");
    expect(report).toContain("Discipline : 3/6 (min. 6) ❌");
    expect(report).toContain("Remarques : À revoir");
  });

  it("signale une grille incomplète et borne les notes", () => {
    const ev = evaluate(grille, { questions: { "1.1": 99 }, sections: { Tir: -4 } });
    expect(ev.complete).toBe(false);
    expect(ev.sections[0].score).toBe(3);
    expect(ev.sections[1].score).toBe(0);
  });

  it("ignore les documents qui ne sont pas des grilles", () => {
    expect(parseGrille("# Règlement\n\n**1.01** : article.\n")).toBeNull();
  });

  it("nettoie le Markdown en ligne", () => {
    expect(cleanInline("***Minimum   requis 80/100***  ")).toBe("Minimum requis 80/100");
    expect(cleanInline("Cf. Article 2\\)")).toBe("Cf. Article 2)");
  });
});

describe("recherche", () => {
  it("ignore casse et accents", () => {
    expect(findMatches("Le Règlement et le reglement", "REGLEMENT")).toEqual([
      [3, 12],
      [19, 28],
    ]);
    expect(countMatches("Décollage décollage", "decol")).toBe(2);
    expect(findMatches("abc", "a")).toEqual([]);
  });
});

describe("diff", () => {
  it("montre ajouts et suppressions avec contexte réduit", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E2", "f", "g", "h", "i"].join("\n");
    const d = computeDiff(before, after, 1);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.rows[0]).toEqual({ kind: "skip", count: 3 });
    expect(d.rows.some((r) => r.kind === "del" && r.text === "e")).toBe(true);
    expect(d.rows.some((r) => r.kind === "add" && r.text === "E2")).toBe(true);
  });

  it("documents identiques : rien à afficher", () => {
    const d = computeDiff("x\ny", "x\ny");
    expect(d.added + d.removed).toBe(0);
  });
});
