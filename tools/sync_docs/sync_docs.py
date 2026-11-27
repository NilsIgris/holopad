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


class RequestsHttp:
    def __init__(self) -> None:
        import requests

        self._session = requests.Session()
        self._session.headers["User-Agent"] = USER_AGENT

    def get(self, url: str) -> Response:
        import requests

        try:
            r = self._session.get(url, timeout=30, allow_redirects=True)
        except requests.RequestException as exc:
            raise FetchError(f"erreur réseau ({type(exc).__name__})") from None
        r.encoding = r.encoding if r.encoding and r.encoding.lower() != "iso-8859-1" else "utf-8"
        return Response(r.status_code, r.headers.get("Content-Type", ""), r.url, r.text)


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


def normalize_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = text.lstrip("﻿")
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def html_to_markdown(html: str, *, site: bool) -> str:
    from bs4 import BeautifulSoup
    from markdownify import markdownify

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "template", "iframe", "link", "meta"]):
        tag.decompose()
    root = None
    if site:
        root = soup.find(attrs={"role": "main"}) or soup.find("main")
        if root is not None:
            for tag in root.find_all(["nav", "header", "footer"]):
                tag.decompose()
    if root is None:
        root = soup.body or soup
        for tag in root.find_all(["nav", "header", "footer"]):
            tag.decompose()
    md = markdownify(str(root), heading_style="ATX", bullets="-", strip=["img"])
    return normalize_markdown(md)


def fetch_markdown(src: Source, http: Http) -> str:
    if src.kind == "gdoc":
        base = f"https://docs.google.com/document/d/{src.ref}/export"
        md = ""
        try:
            resp = http.get(f"{base}?format=md")
            _check(resp, expect_html=False)
            md = normalize_markdown(resp.text)
        except FetchError as first:
            # Repli : export HTML converti localement.
            try:
                resp = http.get(f"{base}?format=html")
                _check(resp, expect_html=True)
                md = html_to_markdown(resp.text, site=False)
            except FetchError:
                raise first from None
    else:
        resp = http.get(src.ref)
        _check(resp, expect_html=True)
        md = html_to_markdown(resp.text, site=True)
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
