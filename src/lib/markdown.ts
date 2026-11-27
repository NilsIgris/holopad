// Rendu Markdown → HTML assaini (le contenu vient de documents externes).

import DOMPurify from "dompurify";
import { marked } from "marked";
import { findMatches } from "./search";

export interface Rendered {
  html: string;
  hits: number;
  toc: { id: string; level: number; text: string }[];
}

const cache = new Map<string, Rendered>();

function highlight(root: Node, query: string): number {
  let hits = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const matches = findMatches(text, query);
    if (!matches.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [start, end] of matches) {
      frag.append(text.slice(last, start));
      const mark = document.createElement("mark");
      mark.className = "hit";
      mark.textContent = text.slice(start, end);
      frag.append(mark);
      last = end;
      hits++;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return hits;
}

export function renderMarkdown(markdown: string, query = ""): Rendered {
  const cacheKey = `${query}\u0000${markdown}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe", "img"],
    FORBID_ATTR: ["style", "id", "class"],
  });
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;
  const toc: Rendered["toc"] = [];
  tpl.content.querySelectorAll("h1, h2, h3").forEach((h, i) => {
    const text = (h.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) return;
    h.id = `h-${i}`;
    toc.push({ id: h.id, level: Number(h.tagName[1]), text });
  });
  const hits = query ? highlight(tpl.content, query) : 0;
  const result = { html: tpl.innerHTML, hits, toc };
  if (cache.size > 40) cache.clear();
  cache.set(cacheKey, result);
  return result;
}
