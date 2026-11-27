#!/usr/bin/env python3
"""Synchronise les documents RP vers des fichiers chiffrés.

Lancé par le workflow « docs-sync ». Les sources (identifiants Google Docs,
URL de Google Sites) et la phrase de passe viennent uniquement de variables
d'environnement alimentées par les secrets GitHub :

  DOCS_SOURCES     JSON : {"documents": [{key, title, character, kind, id|url}]}
  DOCS_PASSPHRASE  phrase de passe partagée avec l'application

Rien de ce qui est écrit dans le dossier de sortie n'est lisible sans la
phrase de passe : contenu, titres et sources sont chiffrés (AES-256-GCM).
Le script n'affiche jamais une URL, un identifiant ou un extrait de contenu.

Codes de sortie : 0 = OK, 1 = erreur de configuration, 2 = au moins une
source n'a pas pu être récupérée (les autres ont quand même été traitées).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol
from urllib.parse import urlparse

FORMAT_VERSION = 1
MAGIC = b"HPD1"
CHECK_PLAINTEXT = b"holopad-check-v1"
DEFAULT_ITERATIONS = 600_000
CHARACTERS = ("gree", "alpha", "arkar")
KINDS = ("gdoc", "gsite")
MIN_CONTENT_CHARS = 40
INDEX_NAME = "index.json"
USER_AGENT = "holopad-docs-sync/1.0 (+github actions)"


# --------------------------------------------------------------------------
# Cryptographie (doit rester identique à crates/rp-core/src/crypto.rs)
# --------------------------------------------------------------------------

def derive_master(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, dklen=32)


def subkey(master: bytes, label: str) -> bytes:
    return hmac.new(master, f"holopad/{label}".encode(), hashlib.sha256).digest()


@dataclass(frozen=True)
class Keys:
    enc: bytes
    mac: bytes
    name: bytes

    @classmethod
    def derive(cls, passphrase: str, salt: bytes, iterations: int) -> "Keys":
        master = derive_master(passphrase, salt, iterations)
        return cls(subkey(master, "enc"), subkey(master, "mac"), subkey(master, "name"))


def encrypt(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def decrypt(key: bytes, blob: bytes, aad: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if len(blob) < len(MAGIC) + 12 + 16 or not blob.startswith(MAGIC):
        raise ValueError("format de fichier chiffré inconnu")
    nonce = blob[len(MAGIC):len(MAGIC) + 12]
    return AESGCM(key).decrypt(nonce, blob[len(MAGIC) + 12:], aad)


def keyed_mac(key: bytes, data: bytes) -> str:
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def file_name_for(keys: Keys, doc_key: str) -> str:
    return keyed_mac(keys.name, f"file:{doc_key}".encode())[:24] + ".enc"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


# --------------------------------------------------------------------------
# Configuration des sources
# --------------------------------------------------------------------------

class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Source:
    key: str
    title: str
    character: str
    kind: str
    ref: str  # identifiant Google Doc ou URL Google Sites

    def secret_values(self) -> list[str]:
        return [self.ref]


def parse_sources(raw: str) -> list[Source]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:  # pas de contenu dans le message
        raise ConfigError(f"DOCS_SOURCES n'est pas du JSON valide (ligne {exc.lineno})") from None
    docs = data.get("documents") if isinstance(data, dict) else None
    if not isinstance(docs, list) or not docs:
        raise ConfigError("DOCS_SOURCES doit contenir une liste « documents » non vide")
    seen: set[str] = set()
    sources: list[Source] = []
    for i, item in enumerate(docs):
        if not isinstance(item, dict):
            raise ConfigError(f"documents[{i}] doit être un objet")
        key = str(item.get("key", "")).strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,60}", key):
            raise ConfigError(f"documents[{i}].key invalide (minuscules, chiffres, tirets)")
        if key in seen:
            raise ConfigError(f"clé en double : {key}")
        seen.add(key)
        character = item.get("character")
        if character not in CHARACTERS:
            raise ConfigError(f"{key} : character doit valoir {', '.join(CHARACTERS)}")
        kind = item.get("kind")
        if kind not in KINDS:
            raise ConfigError(f"{key} : kind doit valoir {', '.join(KINDS)}")
        title = str(item.get("title", "")).strip()
        if not title:
            raise ConfigError(f"{key} : title manquant")
        if kind == "gdoc":
            ref = str(item.get("id", "")).strip()
            if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", ref):
                raise ConfigError(f"{key} : id Google Doc invalide")
        else:
            ref = str(item.get("url", "")).strip()
            parsed = urlparse(ref)
            if parsed.scheme != "https" or parsed.hostname != "sites.google.com":
                raise ConfigError(f"{key} : url doit être une page https://sites.google.com/…")
        sources.append(Source(key, title, character, kind, ref))
    return sources


# --------------------------------------------------------------------------
# Récupération et conversion en Markdown
# --------------------------------------------------------------------------

class FetchError(Exception):
    """Erreur de récupération. Le message ne contient jamais l'URL."""


@dataclass
class Response:
    status: int
    content_type: str
    final_url: str
    text: str


class Http(Protocol):
    def get(self, url: str) -> Response: ...


RETRY_STATUSES = {429, 500, 502, 503, 504}


class RequestsHttp:
    def __init__(self, retries: int = 3, backoff: float = 5.0) -> None:
        import requests

        self._session = requests.Session()
        self._session.headers["User-Agent"] = USER_AGENT
        self._retries = retries
        self._backoff = backoff

    def get(self, url: str) -> Response:
        import time

        import requests

        for attempt in range(self._retries):
            try:
                r = self._session.get(url, timeout=30, allow_redirects=True)
            except requests.RequestException as exc:
                if attempt + 1 < self._retries:
                    time.sleep(self._backoff * (attempt + 1))
                    continue
                raise FetchError(f"erreur réseau ({type(exc).__name__})") from None
            if r.status_code in RETRY_STATUSES and attempt + 1 < self._retries:
                time.sleep(self._backoff * (attempt + 1))
                continue
            r.encoding = r.encoding if r.encoding and r.encoding.lower() != "iso-8859-1" else "utf-8"
            return Response(r.status_code, r.headers.get("Content-Type", ""), r.url, r.text)
        raise FetchError("erreur réseau")  # pragma: no cover


def _is_login_page(resp: Response) -> bool:
    host = urlparse(resp.final_url).hostname or ""
    return host.endswith("accounts.google.com") or "ServiceLogin" in resp.final_url


def _check(resp: Response, expect_html: bool) -> None:
    if _is_login_page(resp):
        raise FetchError("le document n'est plus public (redirection vers la connexion Google)")
    if resp.status != 200:
        raise FetchError(f"HTTP {resp.status}")
    is_html = "html" in resp.content_type.lower()
    if not expect_html and is_html:
        raise FetchError("réponse HTML inattendue (document privé ou format refusé)")


_IMAGE_DEF = re.compile(r"^\[image\d+\]:\s*<?data:[^\n]*$", re.M | re.I)
_IMAGE_REF = re.compile(r"!\[[^\]]*\]\[image\d+\]", re.I)


def strip_embedded_images(md: str) -> str:
    """L'export Markdown de Google Docs embarque les images en base64 (souvent > 100 Ko)."""
    md = _IMAGE_DEF.sub("", md)
    return _IMAGE_REF.sub("*[image]*", md)


def normalize_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = text.lstrip("﻿")
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


# Texte de la table des matières vide de Google Sites (selon la langue du site).
SITES_PLACEHOLDERS = ("Ajoutez des titres qui apparaîtront", "Add headings")
SPACER_TEXT = {"", ".", "·", "-", "_"}


def _style(tag) -> str:
    return (tag.get("style") or "").replace(" ", "").lower()


def _apply_class_styles(soup) -> None:
    """Google Docs (export HTML, mobilebasic) met le gras / italique dans des classes CSS."""
    rules: dict[str, str] = {}
    for style in soup.find_all("style"):
        for name, body in re.findall(r"\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}", style.get_text()):
            rules[name] = rules.get(name, "") + ";" + body
    if not rules:
        return
    for tag in soup.find_all(class_=True):
        extra = ";".join(rules[c] for c in tag.get("class", []) if c in rules)
        if extra:
            tag["style"] = (tag.get("style") or "") + ";" + extra


def _flags(span) -> tuple[bool, bool, bool]:
    st = _style(span)
    weight = re.search(r"font-weight:(bold|\d+)", st)
    bold = bool(weight) and (weight.group(1) == "bold" or int(weight.group(1)) >= 600)
    return bold, "font-style:italic" in st, "underline" in st


def _split_paragraphs_on_br(soup, root) -> None:
    """Un <p> qui contient des <br> devient un <p> par ligne (une règle par ligne sur ces pages)."""
    for p in list(root.find_all("p")):
        if not p.find("br"):
            continue
        # Sortir les <br> des <span> pour qu'ils soient enfants directs du <p>.
        for br in list(p.find_all("br")):
            while br.parent is not None and br.parent is not p and br.parent.name in ("span", "strong", "em", "b", "i", "u"):
                parent = br.parent
                if parent.parent is None:  # span déjà retiré (plusieurs <br> dans le même span vide)
                    break
                # <span>avant<br>après</span> → <span>avant</span><br><span>après</span>
                after = soup.new_tag(parent.name, attrs=dict(parent.attrs))
                for sib in list(br.next_siblings):
                    after.append(sib.extract())
                br.extract()
                parent.insert_after(br)
                if after.get_text(strip=True) or after.find(["img", "br"]):
                    br.insert_after(after)
                if not parent.get_text(strip=True) and not parent.find(["img", "br"]):
                    parent.decompose()
        lines: list[list] = [[]]
        for child in list(p.contents):
            if getattr(child, "name", None) == "br":
                lines.append([])
            else:
                lines[-1].append(child.extract())
        new_ps = []
        for line in lines:
            if not any((c.get_text() if hasattr(c, "get_text") else str(c)).strip() for c in line):
                continue
            np = soup.new_tag("p")
            for c in line:
                np.append(c)
            new_ps.append(np)
        for np in new_ps:
            p.insert_before(np)
        p.decompose()


def _enrich(soup, root) -> None:
    """Traduit la mise en forme par style en balises que markdownify comprend."""
    _split_paragraphs_on_br(soup, root)
    # Points d'espacement en très petite police (6 pt).
    for span in root.find_all("span"):
        size = re.search(r"font-size:([\d.]+)pt", _style(span))
        if span.get_text(strip=True) in SPACER_TEXT - {""} and size and float(size.group(1)) <= 8:
            span.decompose()
    for p in root.find_all("p"):
        if p.get_text(strip=True) in SPACER_TEXT and not p.find("img"):
            p.decompose()

    # Fusionne les morceaux voisins de même mise en forme (sinon « *a**b* »).
    for span in root.find_all("span"):
        if span.parent is None or not span.get_text(strip=True):
            continue
        mine = _flags(span)
        nxt = span.next_sibling
        while nxt is not None:
            if isinstance(nxt, str) and not nxt.strip():
                nxt = nxt.next_sibling
                continue
            if getattr(nxt, "name", None) == "span" and nxt.get_text(strip=True) and _flags(nxt) == mine:
                following = nxt.next_sibling
                for child in list(nxt.contents):
                    span.append(child.extract())
                nxt.decompose()
                nxt = following
                continue
            break

    # Paragraphe court entièrement souligné = intertitre (convention de ces pages).
    for p in root.find_all("p"):
        spans = [s for s in p.find_all("span") if s.get_text(strip=True)]
        text = p.get_text(" ", strip=True)
        if spans and len(text) <= 120 and all(_flags(s)[2] for s in spans):
            p.name = "h2"

    for span in root.find_all("span"):
        if not span.get_text(strip=True) or span.find_parent(["h1", "h2", "h3", "h4", "h5", "h6"]):
            continue
        bold, italic, _ = _flags(span)
        for flag, name in ((bold, "strong"), (italic, "em")):
            if flag:
                inner = soup.new_tag(name)
                for child in list(span.contents):
                    inner.append(child.extract())
                span.append(inner)


def _sites_root(soup):
    for tag in soup.find_all(["header", "nav", "footer"]):
        tag.decompose()
    sections = []
    for sec in soup.find_all("section"):
        if sec.find_parent("section"):
            continue
        text = sec.get_text(" ", strip=True)
        if text and not text.startswith(SITES_PLACEHOLDERS):
            sections.append(sec)
    if sections:
        container = soup.new_tag("div")
        for sec in sections:
            container.append(sec.extract())
        return container
    return soup.find(attrs={"role": "main"}) or soup.find("main") or soup.body or soup


def html_to_markdown(html: str, *, mode: str) -> str:
    """mode : « site » (Google Sites), « docs » (export HTML / mobilebasic de Google Docs)."""
    from bs4 import BeautifulSoup
    from markdownify import markdownify

    soup = BeautifulSoup(html, "html.parser")
    if mode == "docs":
        _apply_class_styles(soup)
    for tag in soup(["script", "style", "noscript", "svg", "template", "iframe", "link", "meta", "input"]):
        tag.decompose()
    if mode == "site":
        root = _sites_root(soup)
    else:
        root = soup.select_one(".doc-content") or soup.body or soup
        for tag in root.find_all(["nav", "header", "footer"]):
            tag.decompose()
    _enrich(soup, root)
    md = markdownify(str(root), heading_style="ATX", bullets="-", strip=["img"])
    md = re.sub(r"\*\*\s*\*\*", "", md)  # gras adjacents fusionnés
    return normalize_markdown(md)


def fetch_markdown(src: Source, http: Http) -> str:
    if src.kind == "gdoc":
        base = f"https://docs.google.com/document/d/{src.ref}"
        attempts = (
            # 1. export Markdown natif ; 2. export HTML ; 3. version mobile (seule
            #    possibilité quand le téléchargement est désactivé pour les lecteurs).
            (f"{base}/export?format=md", False, lambda t: normalize_markdown(strip_embedded_images(t))),
            (f"{base}/export?format=html", True, lambda t: html_to_markdown(t, mode="docs")),
            (f"{base}/mobilebasic", True, lambda t: html_to_markdown(t, mode="docs")),
        )
        first_error: FetchError | None = None
        md = ""
        for url, expect_html, convert in attempts:
            try:
                resp = http.get(url)
                _check(resp, expect_html=expect_html)
                md = convert(resp.text)
                if len(md.strip()) >= MIN_CONTENT_CHARS:
                    break
                raise FetchError("contenu vide ou trop court")
            except FetchError as exc:
                first_error = first_error or exc
                md = ""
        if not md:
            raise first_error or FetchError("aucun format récupérable")
    else:
        resp = http.get(src.ref)
        _check(resp, expect_html=True)
        md = html_to_markdown(resp.text, mode="site")
    if len(md.strip()) < MIN_CONTENT_CHARS:
        raise FetchError("contenu vide ou trop court")
    return md


# --------------------------------------------------------------------------
# Synchronisation
# --------------------------------------------------------------------------

@dataclass
class Report:
    changed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    removed: int = 0
    rekeyed: bool = False

    @property
    def wrote(self) -> bool:
        return bool(self.changed or self.removed or self.rekeyed)


def _canonical(src: Source, markdown: str) -> bytes:
    return json.dumps(
        {"key": src.key, "title": src.title, "character": src.character, "markdown": markdown},
        ensure_ascii=False, sort_keys=True,
    ).encode("utf-8")


def _load_index(out: Path) -> dict | None:
    path = out / INDEX_NAME
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _keys_from_index(index: dict | None, passphrase: str) -> Keys | None:
    if not index or index.get("format") != FORMAT_VERSION:
        return None
    try:
        kdf = index["kdf"]
        keys = Keys.derive(passphrase, unb64(kdf["salt"]), int(kdf["iterations"]))
        if decrypt(keys.enc, unb64(index["check"]), b"check") != CHECK_PLAINTEXT:
            return None
        return keys
    except Exception:
        return None


def sync(
    sources: list[Source],
    passphrase: str,
    out: Path,
    http: Http,
    *,
    now: Callable[[], dt.datetime] = lambda: dt.datetime.now(dt.timezone.utc),
    iterations: int = DEFAULT_ITERATIONS,
    log: Callable[[str], None] = print,
) -> Report:
    out.mkdir(parents=True, exist_ok=True)
    report = Report()
    old_index = _load_index(out)
    keys = _keys_from_index(old_index, passphrase)
    if keys is not None:
        kdf = old_index["kdf"]  # type: ignore[index]
        salt, iters = unb64(kdf["salt"]), int(kdf["iterations"])
        check = old_index["check"]  # type: ignore[index]
        old_entries = {e["file"]: e for e in old_index.get("docs", [])}  # type: ignore[union-attr]
    else:
        # Première exécution ou phrase de passe changée : tout est rechiffré.
        salt, iters = os.urandom(16), iterations
        keys = Keys.derive(passphrase, salt, iters)
        check = b64(encrypt(keys.enc, CHECK_PLAINTEXT, b"check"))
        old_entries = {}
        report.rekeyed = old_index is not None
    timestamp = now().replace(microsecond=0).isoformat()

    new_entries: list[dict] = []
    for src in sources:
        fname = file_name_for(keys, src.key)
        previous = old_entries.get(fname)
        has_previous = previous is not None and (out / fname).exists()
        try:
            markdown = fetch_markdown(src, http)
        except FetchError as exc:
            report.failed.append((src.key, str(exc)))
            log(f"::warning::{src.key} : {exc}")
            if has_previous:
                new_entries.append(previous)  # on garde la dernière version connue
            continue
        mac = keyed_mac(keys.mac, _canonical(src, markdown))
        if has_previous and previous.get("mac") == mac:
            new_entries.append(previous)
            report.unchanged.append(src.key)
            log(f"{src.key} : inchangé")
            continue
        payload = {
            "v": 1,
            "key": src.key,
            "title": src.title,
            "character": src.character,
            "markdown": markdown,
            "changed_at": timestamp,
        }
        blob = encrypt(keys.enc, json.dumps(payload, ensure_ascii=False).encode("utf-8"), fname.encode())
        (out / fname).write_bytes(blob)
        new_entries.append({"file": fname, "mac": mac})
        report.changed.append(src.key)
        log(f"{src.key} : {'mis à jour' if has_previous else 'ajouté'}")

    keep = {e["file"] for e in new_entries}
    for stale in out.glob("*.enc"):
        if stale.name not in keep:
            stale.unlink()
            report.removed += 1

    if report.wrote or old_index is None:
        index = {
            "format": FORMAT_VERSION,
            "kdf": {"alg": "pbkdf2-sha256", "iterations": iters, "salt": b64(salt)},
            "check": check,
            "generated_at": timestamp,
            "docs": sorted(new_entries, key=lambda e: e["file"]),
        }
        (out / INDEX_NAME).write_text(json.dumps(index, indent=2) + "\n", "utf-8")
    return report


def _mask(values: list[str]) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for value in values:
            print(f"::add-mask::{value}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True, help="dossier des données chiffrées")
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    args = parser.parse_args(argv)

    passphrase = os.environ.get("DOCS_PASSPHRASE", "")
    raw = os.environ.get("DOCS_SOURCES", "")
    if len(passphrase) < 12:
        print("::error::DOCS_PASSPHRASE absente ou trop courte (12 caractères minimum)")
        return 1
    try:
        sources = parse_sources(raw)
    except ConfigError as exc:
        print(f"::error::{exc}")
        return 1
    _mask([v for s in sources for v in s.secret_values()])

    report = sync(sources, passphrase, args.out, RequestsHttp(), iterations=args.iterations)

    summary = [
        "### Synchronisation des documents",
        f"- Modifiés ou ajoutés : {len(report.changed)}",
        f"- Inchangés : {len(report.unchanged)}",
        f"- Supprimés : {report.removed}",
        f"- Échecs : {len(report.failed)}",
    ]
    if report.rekeyed:
        summary.append("- Phrase de passe changée : tout a été rechiffré")
    summary += [f"  - `{key}` : {reason}" for key, reason in report.failed]
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(summary) + "\n")
    if path := os.environ.get("GITHUB_OUTPUT"):
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if report.wrote else 'false'}\n")
    print("\n".join(summary))
    return 2 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
