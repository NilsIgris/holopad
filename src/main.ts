import "./styles.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { html, nothing, render, svg, type SVGTemplateResult, type TemplateResult } from "lit-html";
import { live } from "lit-html/directives/live.js";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";

import { api, copyText, type Doc, type Status } from "./api";
import { buildAdvert, callsignFor, type AdvertMode, type FlightAction } from "./lib/advert";
import { CHARACTERS, defaultSettings, GAR_VEHICLES, mergeSettings, type CharacterId } from "./lib/config";
import {
  buildReport,
  evaluate,
  hasScoredQuestions,
  parseGrille,
  type Grille,
  type Question,
  type ScoreState,
  type Section,
} from "./lib/grille";
import { renderMarkdown } from "./lib/markdown";
import {
  buildPresence,
  formatMissionDate,
  fromLocalInput,
  roundToQuarter,
  splitNames,
  toLocalInput,
} from "./lib/presence";
import { countMatches } from "./lib/search";
import { computeDiff } from "./lib/textdiff";

type View = "advert" | "docs" | "grille" | "presence" | "settings";

const VIEWS: Record<CharacterId, View[]> = {
  gree: ["advert", "docs", "settings"],
  alpha: ["advert", "docs", "grille", "presence", "settings"],
  arkar: ["advert", "docs", "settings"],
};

const VIEW_LABELS: Record<View, string> = {
  advert: "Advert",
  docs: "Documents",
  grille: "Grille",
  presence: "Présence",
  settings: "",
};

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

const S = {
  ready: false,
  character: "gree" as CharacterId,
  view: "advert" as View,
  settings: defaultSettings(),
  status: null as Status | null,
  docs: null as Doc[] | null,
  docsError: "",
  syncing: false,
  syncMessage: "",
  openDoc: null as string | null,
  showDiff: false,
  docQuery: "",
  passphrase: "",
  unlocking: false,
  unlockError: "",
  advert: {
    vehicle: { gree: "", alpha: "", arkar: "" } as Record<CharacterId, string>,
    action: "decollage" as FlightAction,
    mode: "demande" as AdvertMode,
  },
  grille: {
    file: "",
    candidate: "",
    remarks: "",
    scores: { sections: {}, questions: {} } as ScoreState,
  },
  presence: {
    date: toLocalInput(roundToQuarter(new Date())),
    selected: new Set<string>(),
    extra: "",
    output: "",
  },
  update: null as Update | null,
  updating: false,
  toast: "",
};

let toastTimer = 0;
let saveTimer = 0;
const grilleCache = new Map<string, { md: string; grille: Grille | null }>();

const root = document.getElementById("app")!;
const rerender = () => render(app(), root);

function toast(message: string) {
  S.toast = message;
  rerender();
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    S.toast = "";
    rerender();
  }, 2200);
}

async function copy(text: string, label = "Copié dans le presse-papiers") {
  try {
    await copyText(text);
    toast(label);
  } catch (e) {
    toast(`Copie impossible : ${e}`);
  }
}

function saveSettings() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveSettings(S.settings).catch((e) => toast(`Paramètres non enregistrés : ${e}`));
  }, 300);
}

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : formatMissionDate(d).split(" ")[0];
};

const character = () => CHARACTERS.find((c) => c.id === S.character)!;
const docsFor = (id: CharacterId) => (S.docs ?? []).filter((d) => d.character === id);
const pendingFor = (id: CharacterId) => docsFor(id).filter((d) => d.status).length;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function refreshStatus() {
  try {
    S.status = await api.status();
  } catch (e) {
    S.syncMessage = String(e);
  }
}

async function loadDocs() {
  if (!S.status?.unlocked) {
    S.docs = null;
    return;
  }
  try {
    S.docs = await api.loadDocs();
    S.docsError = "";
  } catch (e) {
    S.docs = null;
    S.docsError = String(e);
  }
}

async function sync(manual: boolean) {
  if (S.syncing) return;
  S.syncing = true;
  rerender();
  try {
    const r = await api.syncDocs();
    const n = r.report.changed + r.report.added;
    S.syncMessage = `Synchronisé le ${fmtDate(new Date().toISOString())}`;
    if (r.report.rekeyed) toast("Phrase de passe changée : déverrouillez à nouveau");
    else if (n) toast(`${n} document${n > 1 ? "s" : ""} mis à jour`);
    else if (manual) toast("Documents à jour");
  } catch (e) {
    S.syncMessage = String(e);
    if (manual) toast(String(e));
  } finally {
    S.syncing = false;
    await refreshStatus();
    await loadDocs();
    rerender();
  }
}

async function unlock(ev: Event) {
  ev.preventDefault();
  if (!S.passphrase) return;
  S.unlocking = true;
  S.unlockError = "";
  rerender();
  try {
    await api.unlock(S.passphrase);
    S.passphrase = "";
    await refreshStatus();
    await loadDocs();
    toast("Documents déverrouillés");
  } catch (e) {
    S.unlockError = String(e);
  } finally {
    S.unlocking = false;
    rerender();
  }
}

async function lock() {
  await api.lock();
  await refreshStatus();
  await loadDocs();
  S.openDoc = null;
  rerender();
}

async function markSeen(file: string) {
  await api.markDocSeen(file);
  S.showDiff = false;
  await refreshStatus();
  await loadDocs();
  rerender();
}

async function applyPin() {
  try {
    await getCurrentWindow().setAlwaysOnTop(S.settings.alwaysOnTop);
  } catch {
    /* hors Tauri */
  }
}

async function checkUpdate(manual = false) {
  try {
    S.update = await check();
    if (!S.update && manual) toast("Holopad est à jour");
  } catch (e) {
    if (manual) toast(`Vérification impossible : ${e}`);
  }
  rerender();
}

async function installUpdate() {
  if (!S.update) return;
  S.updating = true;
  rerender();
  try {
    await S.update.downloadAndInstall();
    await relaunch();
  } catch (e) {
    S.updating = false;
    toast(`Mise à jour impossible : ${e}`);
  }
}

function selectCharacter(id: CharacterId) {
  S.character = id;
  S.openDoc = null;
  S.showDiff = false;
  if (!VIEWS[id].includes(S.view)) S.view = "advert";
  S.settings.lastCharacter = id;
  saveSettings();
  rerender();
}

function selectView(view: View) {
  S.view = view;
  S.openDoc = null;
  S.showDiff = false;
  rerender();
  root.querySelector(".content")?.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Icônes
// ---------------------------------------------------------------------------

const icon = (path: SVGTemplateResult, cls = "") =>
  html`<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  sync: (spin: boolean) =>
    icon(svg`<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>`, spin ? "spin" : ""),
  pin: () => icon(svg`<path d="M12 17v5"/><path d="M9 3h6l-1 7 4 3v2H6v-2l4-3z"/>`),
  gear: () =>
    icon(svg`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  copy: () => icon(svg`<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
  back: () => icon(svg`<path d="M15 18l-6-6 6-6"/>`),
  lock: () => icon(svg`<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`),
};

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

function app(): TemplateResult {
  if (!S.ready) return html`<div class="splash">Initialisation…</div>`;
  const c = character();
  return html`
    <div class="shell char-${c.id}">
      <header class="top">
        <div class="brand"><span class="logo">◈</span>HOLOPAD</div>
        <div class="top-actions">
          <button class="icon-btn" title="Synchroniser les documents" ?disabled=${S.syncing} @click=${() => sync(true)}>
            ${icons.sync(S.syncing)}
          </button>
          <button
            class="icon-btn ${S.settings.alwaysOnTop ? "on" : ""}"
            title="Toujours au premier plan"
            @click=${() => {
              S.settings.alwaysOnTop = !S.settings.alwaysOnTop;
              applyPin();
              saveSettings();
              rerender();
            }}
          >
            ${icons.pin()}
          </button>
        </div>
      </header>
      ${S.update
        ? html`<div class="banner">
            Version ${S.update.version} disponible
            <button class="btn small" ?disabled=${S.updating} @click=${installUpdate}>
              ${S.updating ? "Installation…" : "Installer"}
            </button>
          </div>`
        : nothing}
      <nav class="chars">
        ${CHARACTERS.map(
          (ch) => html`<button
            class="char char-${ch.id} ${ch.id === S.character ? "active" : ""}"
            @click=${() => selectCharacter(ch.id)}
          >
            ${ch.label}${pendingFor(ch.id) ? html`<span class="dot"></span>` : nothing}
          </button>`,
        )}
      </nav>
      <nav class="tabs">
        ${VIEWS[c.id].map((v) =>
          v === "settings"
            ? html`<button class="tab tab-icon ${S.view === v ? "active" : ""}" title="Paramètres" @click=${() => selectView(v)}>
                ${icons.gear()}
              </button>`
            : html`<button class="tab ${S.view === v ? "active" : ""}" @click=${() => selectView(v)}>
                ${VIEW_LABELS[v]}${v === "docs" && pendingFor(c.id)
                  ? html`<span class="badge">${pendingFor(c.id)}</span>`
                  : nothing}
              </button>`,
        )}
      </nav>
      <main class="content">${viewContent()}</main>
      ${S.toast ? html`<div class="toast">${S.toast}</div>` : nothing}
    </div>
  `;
}

function viewContent(): TemplateResult {
  switch (S.view) {
    case "advert":
      return advertView();
    case "docs":
      return docsView();
    case "grille":
      return grilleView();
    case "presence":
      return presenceView();
    case "settings":
      return settingsView();
  }
}

// --- Advert ---------------------------------------------------------------

function advertView(): TemplateResult {
  const c = character();
  const vehicles = S.settings.vehicles[c.id];
  if (!vehicles.includes(S.advert.vehicle[c.id])) S.advert.vehicle[c.id] = vehicles[0] ?? "";
  const vehicle = S.advert.vehicle[c.id];
  const cmd = vehicle ? buildAdvert(vehicle, c.callsign, S.advert.action, S.advert.mode) : "";
  const seg = <T extends string>(value: T, current: T, label: string, set: (v: T) => void) =>
    html`<button class="seg-btn ${value === current ? "active" : ""}" @click=${() => (set(value), rerender())}>${label}</button>`;

  return html`
    <section class="card">
      <h2>Véhicule</h2>
      <div class="chips">
        ${vehicles.map(
          (v) => html`<button
            class="chip ${v === vehicle ? "active" : ""}"
            @click=${() => {
              S.advert.vehicle[c.id] = v;
              rerender();
            }}
          >
            ${v}
          </button>`,
        )}
      </div>
      <h2>Manœuvre</h2>
      <div class="seg">
        ${seg<FlightAction>("decollage", S.advert.action, "Décollage", (v) => (S.advert.action = v))}
        ${seg<FlightAction>("atterrissage", S.advert.action, "Atterrissage", (v) => (S.advert.action = v))}
      </div>
      <div class="seg">
        ${seg<AdvertMode>("demande", S.advert.mode, "Demander l'autorisation", (v) => (S.advert.mode = v))}
        ${seg<AdvertMode>("prevenir", S.advert.mode, "Prévenir", (v) => (S.advert.mode = v))}
      </div>
    </section>
    ${cmd
      ? html`<button class="command" @click=${() => copy(cmd, "Commande copiée — colle-la dans le chat")}>
            <code>${cmd}</code>
            <span class="command-hint">${icons.copy()} Cliquer pour copier</span>
          </button>
          <p class="muted center">Indicatif : <b>${callsignFor(vehicle, c.callsign)}</b></p>`
      : html`<p class="muted">Aucun véhicule configuré pour ce personnage (Paramètres).</p>`}
  `;
}

// --- Documents --------------------------------------------------------------

function docsGate(): TemplateResult | null {
  const st = S.status;
  if (!st?.has_data) {
    return html`<section class="card empty">
      <h2>Aucun document en cache</h2>
      <p class="muted">${S.syncMessage || "Lancez une synchronisation (connexion requise une seule fois)."}</p>
      <button class="btn" ?disabled=${S.syncing} @click=${() => sync(true)}>Synchroniser</button>
    </section>`;
  }
  if (!st.unlocked) {
    return html`<form class="card unlock" @submit=${unlock}>
      <h2>${icons.lock()} Documents chiffrés</h2>
      <p class="muted">Saisissez la phrase de passe une fois : elle est gardée dans le Gestionnaire d'identification Windows.</p>
      <input
        type="password"
        placeholder="Phrase de passe"
        autocomplete="current-password"
        .value=${live(S.passphrase)}
        @input=${(e: Event) => (S.passphrase = (e.target as HTMLInputElement).value)}
      />
      ${S.unlockError ? html`<p class="error">${S.unlockError}</p>` : nothing}
      <button class="btn" type="submit" ?disabled=${S.unlocking}>${S.unlocking ? "Vérification…" : "Déverrouiller"}</button>
    </form>`;
  }
  if (S.docsError) return html`<section class="card"><p class="error">${S.docsError}</p></section>`;
  return null;
}

function docsView(): TemplateResult {
  const gate = docsGate();
  if (gate) return gate;
  const docs = docsFor(S.character);
  const open = docs.find((d) => d.file === S.openDoc);
  if (open) return docReader(open);
  const q = S.docQuery.trim();
  const rows = docs
    .map((d) => ({ d, hits: q ? countMatches(d.markdown, q) + countMatches(d.title, q) : 0 }))
    .filter((r) => !q || r.hits > 0);
  return html`
    <input
      class="search"
      type="search"
      placeholder="Rechercher dans les documents…"
      .value=${live(S.docQuery)}
      @input=${(e: Event) => {
        S.docQuery = (e.target as HTMLInputElement).value;
        rerender();
      }}
    />
    ${docs.length === 0 ? html`<p class="muted">Aucun document pour ce personnage.</p>` : nothing}
    ${q && rows.length === 0 ? html`<p class="muted">Aucun résultat.</p>` : nothing}
    <div class="doc-list">
      ${rows.map(
        ({ d, hits }) => html`<button
          class="doc-item"
          @click=${() => {
            S.openDoc = d.file;
            S.showDiff = false;
            rerender();
            root.querySelector(".content")?.scrollTo(0, 0);
          }}
        >
          <span class="doc-title">${d.title}</span>
          <span class="doc-meta">
            ${d.status === "changed" ? html`<span class="pill warn">Modifié</span>` : nothing}
            ${d.status === "new" ? html`<span class="pill info">Nouveau</span>` : nothing}
            ${q ? html`<span class="pill">${hits} résultat${hits > 1 ? "s" : ""}</span>` : nothing}
            <span>MAJ ${fmtDate(d.changed_at)}</span>
          </span>
        </button>`,
      )}
    </div>
    <p class="muted small">${S.syncMessage}</p>
  `;
}

function diffView(doc: Doc): TemplateResult {
  const d = computeDiff(doc.previous_markdown ?? "", doc.markdown);
  return html`<div class="diff">
    <p class="muted small">+${d.added} ligne(s), −${d.removed} ligne(s)</p>
    ${d.rows.map((r) =>
      r.kind === "skip"
        ? html`<div class="diff-skip">··· ${r.count} ligne(s) inchangée(s) ···</div>`
        : html`<div class="diff-row ${r.kind}">${r.kind === "add" ? "+ " : r.kind === "del" ? "− " : "  "}${r.text || " "}</div>`,
    )}
  </div>`;
}

function docReader(doc: Doc): TemplateResult {
  const rendered = renderMarkdown(doc.markdown, S.docQuery);
  const onBodyClick = (e: Event) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    copy(href, "Lien copié (pas d'ouverture du navigateur)");
  };
  return html`
    <div class="reader-head">
      <button class="icon-btn" title="Retour" @click=${() => ((S.openDoc = null), rerender())}>${icons.back()}</button>
      <h2 class="reader-title">${doc.title}</h2>
    </div>
    ${doc.status
      ? html`<div class="banner ${doc.status === "changed" ? "warn" : "info"}">
          ${doc.status === "changed" ? `Modifié le ${fmtDate(doc.changed_at)}` : "Nouveau document"}
          <span class="banner-actions">
            ${doc.previous_markdown !== null
              ? html`<button class="btn small ghost" @click=${() => ((S.showDiff = !S.showDiff), rerender())}>
                  ${S.showDiff ? "Voir le document" : "Voir les modifications"}
                </button>`
              : nothing}
            <button class="btn small" @click=${() => markSeen(doc.file)}>Marquer comme lu</button>
          </span>
        </div>`
      : nothing}
    ${S.showDiff
      ? diffView(doc)
      : html`
          <div class="reader-tools">
            <input
              class="search"
              type="search"
              placeholder="Rechercher…"
              .value=${live(S.docQuery)}
              @input=${(e: Event) => {
                S.docQuery = (e.target as HTMLInputElement).value;
                rerender();
              }}
            />
            ${S.docQuery.trim().length >= 2 ? html`<span class="pill">${rendered.hits}</span>` : nothing}
            ${rendered.toc.length > 2
              ? html`<select
                  class="toc"
                  @change=${(e: Event) => {
                    const sel = e.target as HTMLSelectElement;
                    root.querySelector(`#${CSS.escape(sel.value)}`)?.scrollIntoView({ block: "start" });
                    sel.value = "";
                  }}
                >
                  <option value="">Sommaire</option>
                  ${rendered.toc.map(
                    (t) => html`<option value=${t.id}>${"  ".repeat(t.level - 1)}${t.text.slice(0, 60)}</option>`,
                  )}
                </select>`
              : nothing}
            ${rendered.hits
              ? html`<button class="btn small ghost" @click=${() => root.querySelector("mark.hit")?.scrollIntoView({ block: "center" })}>
                  1er résultat
                </button>`
              : nothing}
          </div>
          <article class="md" @click=${onBodyClick}>${unsafeHTML(rendered.html)}</article>
        `}
  `;
}

// --- Grille ---------------------------------------------------------------

function grilleFor(doc: Doc): Grille | null {
  const hit = grilleCache.get(doc.file);
  if (hit && hit.md === doc.markdown) return hit.grille;
  const grille = parseGrille(doc.markdown);
  grilleCache.set(doc.file, { md: doc.markdown, grille });
  return grille;
}

function resetGrille() {
  S.grille.candidate = "";
  S.grille.remarks = "";
  S.grille.scores = { sections: {}, questions: {} };
}

function questionRow(q: Question): TemplateResult {
  const value = S.grille.scores.questions[q.id];
  const setQ = (v: number | null) => {
    S.grille.scores.questions[q.id] = v;
    rerender();
  };
  const pts = q.points;
  let control: TemplateResult | typeof nothing = nothing;
  if (pts !== null && Number.isInteger(pts) && pts <= 5) {
    control = html`<div class="points">
      ${Array.from({ length: pts + 1 }, (_, i) => i).map(
        (i) => html`<button class="pt ${value === i ? "active" : ""}" @click=${() => setQ(value === i ? null : i)}>${i}</button>`,
      )}
    </div>`;
  } else if (pts !== null) {
    control = html`<input
      class="num"
      type="number"
      min="0"
      max=${pts}
      step="0.5"
      .value=${live(value ?? "")}
      @input=${(e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        setQ(raw === "" ? null : Number(raw));
      }}
    />
    <span class="muted">/ ${pts}</span>`;
  }
  return html`<div class="question">
    <div class="q-text"><b>${q.id}</b> ${q.text}${pts !== null ? html` <span class="muted">/${pts}</span>` : nothing}</div>
    ${q.reference
      ? html`<details class="ref"><summary>Réponse / consigne</summary><div class="ref-body">${q.reference}</div></details>`
      : nothing}
    ${control}
  </div>`;
}

function sectionBlock(s: Section, score: number, ok: boolean): TemplateResult {
  const scored = hasScoredQuestions(s);
  const manual = S.grille.scores.sections[s.name];
  const setManual = (v: number | null) => {
    S.grille.scores.sections[s.name] = v;
    rerender();
  };
  return html`<section class="card section">
    <div class="section-head">
      <h3>${s.name}</h3>
      <span class="score ${s.min !== null && !ok ? "bad" : ""}">${score}/${s.max}</span>
    </div>
    ${s.min !== null ? html`<p class="muted small">Minimum ${s.min}/${s.max}${s.min === s.max ? " — éliminatoire" : ""}</p>` : nothing}
    ${s.notes.map((n) => html`<p class="note">${n}</p>`)}
    ${scored
      ? s.questions.map(questionRow)
      : html`
          ${s.questions.map(questionRow)}
          <div class="manual">
            <input
              class="num"
              type="number"
              min="0"
              max=${s.max}
              step="0.5"
              .value=${live(manual ?? "")}
              @input=${(e: Event) => {
                const raw = (e.target as HTMLInputElement).value;
                setManual(raw === "" ? null : Number(raw));
              }}
            />
            <span class="muted">/ ${s.max}</span>
            <button class="btn small ghost" @click=${() => setManual(0)}>0</button>
            <button class="btn small ghost" @click=${() => setManual(s.max)}>Max</button>
          </div>
        `}
  </section>`;
}

function grilleView(): TemplateResult {
  const gate = docsGate();
  if (gate) return gate;
  const tests = docsFor("alpha")
    .map((d) => ({ d, g: grilleFor(d) }))
    .filter((t): t is { d: Doc; g: Grille } => t.g !== null);
  if (!tests.length) {
    return html`<section class="card"><p class="muted">Aucun document de recrutement avec barème n'a été trouvé dans les documents Alpha.</p></section>`;
  }
  if (!tests.some((t) => t.d.file === S.grille.file)) {
    S.grille.file = tests[0].d.file;
    resetGrille();
  }
  const { g } = tests.find((t) => t.d.file === S.grille.file)!;
  const ev = evaluate(g, S.grille.scores);
  const report = buildReport(g, ev, {
    candidate: S.grille.candidate,
    evaluator: S.settings.alphaMatricule,
    date: formatMissionDate(new Date()).split(" ")[0],
    remarks: S.grille.remarks,
  });

  return html`
    <section class="card">
      <label class="field">
        <span>Test</span>
        <select
          @change=${(e: Event) => {
            S.grille.file = (e.target as HTMLSelectElement).value;
            resetGrille();
            rerender();
          }}
        >
          ${tests.map((t) => html`<option value=${t.d.file} ?selected=${t.d.file === S.grille.file}>${t.d.title}</option>`)}
        </select>
      </label>
      <label class="field">
        <span>Candidat</span>
        <input
          placeholder="Matricule / nom"
          .value=${live(S.grille.candidate)}
          @input=${(e: Event) => {
            S.grille.candidate = (e.target as HTMLInputElement).value;
            rerender();
          }}
        />
      </label>
      ${ev.maxMismatch
        ? html`<p class="error small">Attention : la somme des barèmes ne correspond pas au total du document (/${g.total}).</p>`
        : nothing}
    </section>
    ${g.sections.map((s, i) => sectionBlock(s, ev.sections[i].score, ev.sections[i].ok))}
    <section class="card result ${ev.passed ? "pass" : "fail"}">
      <div class="section-head">
        <h3>Total</h3>
        <span class="score big">${ev.total}/${ev.max}</span>
      </div>
      <p class="verdict">${ev.passed ? "ADMIS" : "REFUSÉ"}${ev.complete ? "" : " (grille incomplète)"}</p>
      ${ev.reasons.map((r) => html`<p class="small">• ${r}</p>`)}
      <label class="field">
        <span>Remarques</span>
        <textarea
          rows="2"
          .value=${live(S.grille.remarks)}
          @input=${(e: Event) => {
            S.grille.remarks = (e.target as HTMLTextAreaElement).value;
            rerender();
          }}
        ></textarea>
      </label>
      <pre class="output">${report}</pre>
      <div class="row">
        <button class="btn" @click=${() => copy(report, "Rapport copié")}>${icons.copy()} Copier le rapport</button>
        <button
          class="btn ghost"
          @click=${() => {
            resetGrille();
            rerender();
          }}
        >
          Nouvelle grille
        </button>
      </div>
    </section>
  `;
}

// --- Présence ---------------------------------------------------------------

function presenceView(): TemplateResult {
  const me = S.settings.alphaMatricule;
  const members = S.settings.alphaMembers.filter((m) => m !== me);
  const generate = () => {
    const date = fromLocalInput(S.presence.date) ?? new Date();
    S.presence.output = buildPresence({
      matricule: me,
      date,
      present: [...members.filter((m) => S.presence.selected.has(m)), ...splitNames(S.presence.extra)],
    });
    copy(S.presence.output, "Présence copiée");
  };
  return html`
    <section class="card">
      <label class="field">
        <span>Matricule / nom</span>
        <input
          .value=${live(me)}
          @input=${(e: Event) => {
            S.settings.alphaMatricule = (e.target as HTMLInputElement).value;
            saveSettings();
          }}
        />
      </label>
      <label class="field">
        <span>Date de la mission</span>
        <div class="row">
          <input
            type="datetime-local"
            .value=${live(S.presence.date)}
            @input=${(e: Event) => (S.presence.date = (e.target as HTMLInputElement).value)}
          />
          <button
            class="btn small ghost"
            @click=${() => {
              S.presence.date = toLocalInput(roundToQuarter(new Date()));
              rerender();
            }}
          >
            Maintenant
          </button>
        </div>
      </label>
      <div class="field">
        <span>Arc Alpha présents</span>
        ${members.length
          ? html`<div class="chips">
              ${members.map(
                (m) => html`<button
                  class="chip ${S.presence.selected.has(m) ? "active" : ""}"
                  @click=${() => {
                    if (S.presence.selected.has(m)) S.presence.selected.delete(m);
                    else S.presence.selected.add(m);
                    rerender();
                  }}
                >
                  ${m}
                </button>`,
              )}
            </div>`
          : html`<p class="muted small">Ajoutez les membres Alpha dans les paramètres pour les cocher ici.</p>`}
        <input
          placeholder="Autres (séparés par des virgules)"
          .value=${live(S.presence.extra)}
          @input=${(e: Event) => (S.presence.extra = (e.target as HTMLInputElement).value)}
        />
      </div>
      <button class="btn wide" @click=${generate}>Générer ma présence</button>
    </section>
    ${S.presence.output
      ? html`<button class="command" @click=${() => copy(S.presence.output, "Présence copiée")}>
          <pre>${S.presence.output}</pre>
          <span class="command-hint">${icons.copy()} Cliquer pour copier à nouveau</span>
        </button>`
      : nothing}
  `;
}

// --- Paramètres ---------------------------------------------------------------

function listArea(value: string[], onSave: (list: string[]) => void, rows = 4) {
  return html`<textarea
    rows=${rows}
    .value=${live(value.join("\n"))}
    @change=${(e: Event) => {
      onSave(splitNames((e.target as HTMLTextAreaElement).value));
      saveSettings();
      rerender();
    }}
  ></textarea>`;
}

function settingsView(): TemplateResult {
  const st = S.status;
  const c = character();
  return html`
    <section class="card">
      <h2>Documents</h2>
      <p class="small">
        État : ${!st?.has_data ? "aucune donnée" : st.unlocked ? "déverrouillés" : "verrouillés"} · données du
        ${fmtDate(st?.generated_at ?? null)}
      </p>
      <label class="field">
        <span>Dépôt GitHub (propriétaire/nom)</span>
        <input
          placeholder=${st?.repo ?? "propriétaire/holopad"}
          .value=${live(S.settings.repo)}
          @change=${(e: Event) => {
            S.settings.repo = (e.target as HTMLInputElement).value.trim();
            saveSettings();
          }}
        />
      </label>
      <div class="row">
        <button class="btn small" ?disabled=${S.syncing} @click=${() => sync(true)}>Synchroniser</button>
        ${st?.unlocked ? html`<button class="btn small ghost" @click=${lock}>Verrouiller / oublier la phrase</button>` : nothing}
      </div>
    </section>
    <section class="card">
      <h2>Véhicules — ${c.label}</h2>
      <p class="muted small">Un par ligne, écrit exactement comme dans la commande.</p>
      ${listArea(S.settings.vehicles[c.id], (l) => {
        if (l.length) S.settings.vehicles[c.id] = l;
      }, 6)}
      <button
        class="btn small ghost"
        @click=${() => {
          S.settings.vehicles[c.id] = c.id === "gree" ? ["Laat/i"] : [...GAR_VEHICLES];
          saveSettings();
          rerender();
        }}
      >
        Valeurs par défaut
      </button>
    </section>
    ${c.id === "alpha"
      ? html`<section class="card">
          <h2>ARC Alpha</h2>
          <label class="field">
            <span>Mon matricule</span>
            <input
              .value=${live(S.settings.alphaMatricule)}
              @change=${(e: Event) => {
                S.settings.alphaMatricule = (e.target as HTMLInputElement).value.trim() || "A-34";
                saveSettings();
              }}
            />
          </label>
          <div class="field">
            <span>Membres Alpha (un par ligne)</span>
            ${listArea(S.settings.alphaMembers, (l) => (S.settings.alphaMembers = l))}
          </div>
        </section>`
      : nothing}
    <section class="card">
      <h2>Application</h2>
      <label class="check">
        <input
          type="checkbox"
          .checked=${live(S.settings.alwaysOnTop)}
          @change=${(e: Event) => {
            S.settings.alwaysOnTop = (e.target as HTMLInputElement).checked;
            applyPin();
            saveSettings();
            rerender();
          }}
        />
        Toujours au premier plan
      </label>
      <p class="small">Version ${st?.version ?? "?"}</p>
      <button class="btn small ghost" @click=${() => checkUpdate(true)}>Vérifier les mises à jour</button>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./dev/mock")).installMock();
  }
  S.settings = mergeSettings(await api.getSettings().catch(() => ({})));
  S.character = S.settings.lastCharacter;
  applyPin();
  await refreshStatus();
  await loadDocs();
  S.ready = true;
  rerender();
  sync(false);
  window.setInterval(() => sync(false), 3 * 60 * 60 * 1000);
  window.setTimeout(() => checkUpdate(false), 4000);
}

init();
