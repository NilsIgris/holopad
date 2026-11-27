"""Tests du pipeline de synchronisation (aucun appel réseau)."""

from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sync_docs as sd  # noqa: E402

PASS = "phrase de passe de test assez longue"
DOC_ID = "TESTdocID_abcdefghijklmnop123"
SITE_URL = "https://sites.google.com/view/exemple-test/page"
ITER = 1000  # rapide pour les tests


def make_sources(**overrides) -> list[sd.Source]:
    srcs = [
        sd.Source("alpha-reglement", "Règlement test", "alpha", "gdoc", DOC_ID),
        sd.Source("gree-site", "Site test", "gree", "gsite", SITE_URL),
    ]
    return srcs


class FakeHttp:
    def __init__(self, pages: dict[str, sd.Response]):
        self.pages = pages
        self.calls: list[str] = []

    def get(self, url: str) -> sd.Response:
        self.calls.append(url)
        if url not in self.pages:
            raise sd.FetchError("erreur réseau (Timeout)")
        return self.pages[url]


MD_TEXT = "# Règles\n\n**1.01** : Premier article du règlement fictif.  \nLigne suivante.\n"
SITE_HTML = """<html><body><header>Menu du site</header>
<div role="main"><h1>Règlement RP</h1><p>Article fictif <b>important</b>.</p>
<ul><li>Point un</li><li>Point deux</li></ul></div><footer>bas</footer>
<script>alert(1)</script></body></html>"""


def pages(md: str = MD_TEXT, site: str = SITE_HTML) -> dict[str, sd.Response]:
    return {
        f"https://docs.google.com/document/d/{DOC_ID}/export?format=md":
            sd.Response(200, "text/markdown; charset=utf-8", "https://docs.google.com/x", md),
        SITE_URL: sd.Response(200, "text/html; charset=utf-8", SITE_URL, site),
    }


def clock(day: int):
    return lambda: dt.datetime(2026, 11, day, 5, 0, tzinfo=dt.timezone.utc)


def run(out: Path, http, passphrase=PASS, day=1):
    logs: list[str] = []
    rep = sd.sync(make_sources(), passphrase, out, http, now=clock(day), iterations=ITER, log=logs.append)
    return rep, logs


def decrypt_all(out: Path, passphrase=PASS) -> dict[str, dict]:
    index = json.loads((out / "index.json").read_text())
    keys = sd.Keys.derive(passphrase, sd.unb64(index["kdf"]["salt"]), index["kdf"]["iterations"])
    docs = {}
    for e in index["docs"]:
        blob = (out / e["file"]).read_bytes()
        doc = json.loads(sd.decrypt(keys.enc, blob, e["file"].encode()))
        docs[doc["key"]] = doc
    return docs


# --- crypto ---------------------------------------------------------------

def test_encrypt_roundtrip_and_tamper():
    keys = sd.Keys.derive(PASS, b"0" * 16, ITER)
    blob = sd.encrypt(keys.enc, b"secret", b"aad")
    assert sd.decrypt(keys.enc, blob, b"aad") == b"secret"
    with pytest.raises(Exception):
        sd.decrypt(keys.enc, blob, b"autre-aad")
    tampered = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(Exception):
        sd.decrypt(keys.enc, tampered, b"aad")
    with pytest.raises(Exception):
        sd.decrypt(sd.Keys.derive("mauvaise phrase!!", b"0" * 16, ITER).enc, blob, b"aad")


def test_subkeys_are_distinct():
    keys = sd.Keys.derive(PASS, b"1" * 16, ITER)
    assert len({keys.enc, keys.mac, keys.name}) == 3


# --- configuration --------------------------------------------------------

def test_parse_sources_ok():
    raw = json.dumps({"documents": [
        {"key": "alpha-doc", "title": "Doc", "character": "alpha", "kind": "gdoc", "id": DOC_ID},
        {"key": "gree-rp", "title": "RP", "character": "gree", "kind": "gsite", "url": SITE_URL},
    ]})
    srcs = sd.parse_sources(raw)
    assert [s.key for s in srcs] == ["alpha-doc", "gree-rp"]


@pytest.mark.parametrize("doc,msg", [
    ({"key": "Bad Key", "title": "t", "character": "alpha", "kind": "gdoc", "id": DOC_ID}, "key invalide"),
    ({"key": "ok-key", "title": "t", "character": "jedi", "kind": "gdoc", "id": DOC_ID}, "character"),
    ({"key": "ok-key", "title": "t", "character": "alpha", "kind": "pdf", "id": DOC_ID}, "kind"),
    ({"key": "ok-key", "title": "t", "character": "alpha", "kind": "gdoc", "id": "court"}, "id Google Doc"),
    ({"key": "ok-key", "title": "t", "character": "gree", "kind": "gsite", "url": "https://evil.example/x"}, "sites.google.com"),
    ({"key": "ok-key", "title": "", "character": "gree", "kind": "gsite", "url": SITE_URL}, "title"),
])
def test_parse_sources_rejects(doc, msg):
    with pytest.raises(sd.ConfigError, match=msg):
        sd.parse_sources(json.dumps({"documents": [doc]}))


def test_parse_sources_errors_never_echo_values():
    secret = "SECRETVALUE_should_not_leak_123456"
    try:
        sd.parse_sources('{"documents": [{"key": "a-b", "id": "' + secret + '"')
    except sd.ConfigError as exc:
        assert secret not in str(exc)
    try:
        sd.parse_sources(json.dumps({"documents": [{"key": "ok-key", "title": "t", "character": "alpha",
                                                    "kind": "gsite", "url": "https://x.example/" + secret}]}))
    except sd.ConfigError as exc:
        assert secret not in str(exc)


# --- conversion -----------------------------------------------------------

def test_site_html_extracts_main_only():
    md = sd.html_to_markdown(SITE_HTML, mode="site")
    assert "# Règlement RP" in md
    assert "**important**" in md
    assert "- Point un" in md
    assert "Menu du site" not in md and "alert" not in md and "bas" not in md


def test_normalize_markdown():
    assert sd.normalize_markdown("﻿a  \r\n\r\n\r\n\r\nb c  ") == "a\n\nb c\n"


def test_gdoc_falls_back_to_html_export():
    p = {
        f"https://docs.google.com/document/d/{DOC_ID}/export?format=md":
            sd.Response(400, "text/html", "https://docs.google.com/x", "<html>err</html>"),
        f"https://docs.google.com/document/d/{DOC_ID}/export?format=html":
            sd.Response(200, "text/html", "https://docs.google.com/x",
                        "<html><body><h1>Titre</h1><p>Un paragraphe assez long pour passer le seuil.</p></body></html>"),
    }
    md = sd.fetch_markdown(make_sources()[0], FakeHttp(p))
    assert md.startswith("# Titre")


def test_login_redirect_is_an_error():
    p = pages()
    p[SITE_URL] = sd.Response(200, "text/html", "https://accounts.google.com/ServiceLogin?x", "<html>login</html>")
    with pytest.raises(sd.FetchError, match="plus public"):
        sd.fetch_markdown(make_sources()[1], FakeHttp(p))


def test_too_short_content_is_an_error():
    with pytest.raises(sd.FetchError, match="trop court"):
        sd.fetch_markdown(make_sources()[0], FakeHttp(pages(md="# vide")))


# --- synchronisation ------------------------------------------------------

def test_first_run_writes_everything(tmp_path):
    rep, logs = run(tmp_path, FakeHttp(pages()))
    assert sorted(rep.changed) == ["alpha-reglement", "gree-site"]
    docs = decrypt_all(tmp_path)
    assert docs["alpha-reglement"]["markdown"].startswith("# Règles")
    assert docs["gree-site"]["character"] == "gree"
    assert docs["alpha-reglement"]["changed_at"] == "2026-11-01T05:00:00+00:00"


def test_output_contains_no_plaintext(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    blob = b"".join(p.read_bytes() for p in tmp_path.iterdir())
    for needle in ["Règles", "Premier article", "Règlement test", "alpha-reglement", DOC_ID, "sites.google"]:
        assert needle.encode() not in blob, needle


def test_logs_never_contain_sources_or_content(tmp_path):
    p = pages()
    del p[SITE_URL]  # provoque un échec
    _, logs = run(tmp_path, FakeHttp(p))
    text = "\n".join(logs)
    assert DOC_ID not in text and "sites.google" not in text and "Premier article" not in text
    assert "gree-site" in text  # seule la clé apparaît


def test_second_run_without_change_rewrites_nothing(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    rep, _ = run(tmp_path, FakeHttp(pages()), day=2)
    after = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    assert not rep.wrote and rep.changed == []
    assert before == after


def test_changed_doc_only_rewrites_that_doc(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    rep, _ = run(tmp_path, FakeHttp(pages(md=MD_TEXT + "\nNouvel article ajouté.\n")), day=3)
    assert rep.changed == ["alpha-reglement"]
    after = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    changed_files = {n for n in after if before.get(n) != after[n]}
    assert len(changed_files) == 2  # le document + index.json
    docs = decrypt_all(tmp_path)
    assert "Nouvel article" in docs["alpha-reglement"]["markdown"]
    assert docs["alpha-reglement"]["changed_at"].startswith("2026-11-03")
    assert docs["gree-site"]["changed_at"].startswith("2026-11-01")


def test_failed_fetch_keeps_last_version(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    p = pages()
    del p[SITE_URL]
    rep, _ = run(tmp_path, FakeHttp(p), day=4)
    assert [k for k, _ in rep.failed] == ["gree-site"]
    assert set(decrypt_all(tmp_path)) == {"alpha-reglement", "gree-site"}


def test_removed_source_deletes_file(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    rep = sd.sync(make_sources()[:1], PASS, tmp_path, FakeHttp(pages()), now=clock(5), iterations=ITER, log=lambda _: None)
    assert rep.removed == 1
    assert set(decrypt_all(tmp_path)) == {"alpha-reglement"}
    assert len(list(tmp_path.glob("*.enc"))) == 1


def test_new_passphrase_rekeys_everything(tmp_path):
    run(tmp_path, FakeHttp(pages()))
    old_salt = json.loads((tmp_path / "index.json").read_text())["kdf"]["salt"]
    rep, _ = run(tmp_path, FakeHttp(pages()), passphrase="une toute nouvelle phrase", day=6)
    assert rep.rekeyed
    index = json.loads((tmp_path / "index.json").read_text())
    assert index["kdf"]["salt"] != old_salt
    assert set(decrypt_all(tmp_path, "une toute nouvelle phrase")) == {"alpha-reglement", "gree-site"}
    with pytest.raises(Exception):
        decrypt_all(tmp_path, PASS)


def test_main_rejects_short_passphrase(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("DOCS_PASSPHRASE", "court")
    monkeypatch.setenv("DOCS_SOURCES", "{}")
    assert sd.main(["--out", str(tmp_path)]) == 1


# --- garde-fou dépôt public ----------------------------------------------

LEAK_PATTERNS = [
    re.compile(r"docs\.google\.com/(document|spreadsheets)/d/[A-Za-z0-9_-]{20,}"),
    re.compile(r"sites\.google\.com/view/[A-Za-z0-9_-]+"),
]


def test_repository_contains_no_document_source():
    root = Path(__file__).resolve().parents[3]
    try:
        files = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("pas un dépôt git")
    offenders = []
    for rel in files:
        path = root / rel
        if path.suffix in {".png", ".ico", ".icns", ".enc"} or not path.is_file():
            continue
        text = path.read_text("utf-8", errors="ignore")
        for pat in LEAK_PATTERNS:
            for m in pat.finditer(text):
                if "exemple-test" not in m.group(0):
                    offenders.append(f"{rel}: {m.group(0)[:40]}…")
    assert not offenders, "Sources de documents trouvées dans le dépôt public :\n" + "\n".join(offenders)


# --- structures réelles de Google (contenu fictif) -----------------------
# Reproduit la structure observée sur Google Sites (novembre 2026) : titre dans
# [role=main], contenu dans des <section> voisines, intertitres soulignés,
# gras/italique en style inline, lignes « . » d'espacement, table des matières vide.

SITES_REAL_STRUCTURE = """<html><body><div><div role="banner"><input role="combobox"><div>Rechercher dans ce site</div></div>
<header id="atIdViewHeader"><nav role="navigation"><ul><li><a href="/view/x/accueil">Accueil</a></li><li><a href="/view/x/r">Réglement</a></li></ul></nav></header>
<div><section id="h.1"><div style="background-image: url(x)"></div><div><div id="h.2"><div><div role="main">
<h1 id="h.9" style="text-align: center;"><span style="color: #000000;">Règlement Exemple&nbsp;</span></h1></div></div></div></div></section>
<section id="h.3"><div><div id="h.4"><p class="zfr3Q">Ajoutez des titres qui apparaîtront dans votre table des matières.</p></div></div></section>
<section id="h.5"><div><div><div id="h.6"><div><div><br>
<p style="line-height: 1.656; text-align: center;"><span style="color: #ff0000; font-weight: 700;">Ceci est la version officielle, toute copie est à ignorer.</span></p><br>
<p style="text-align: center;"><span style="color: #efefef; font-weight: 400; text-decoration: underline; vertical-align: baseline;">Interdictions</span></p>
<p style="text-align: center;"><span style="font-size: 12.0pt; font-weight: 400;">[ </span><span style="font-size: 14pt; font-weight: 400;">1.1 ] Interdiction fictive numéro un</span></p>
<p style="text-align: center;"><span style="font-size: 6.0pt; font-style: italic; font-weight: 400;">.</span></p>
<p style="text-align: center;"><span style="font-weight: 400;">[ 1.2 ] Interdiction de test </span><span style="font-style: italic; font-weight: 400;">(précision en italique)</span></p>
<p style="text-align: center;"><span style="font-size: 6.0pt; font-style: italic;">.</span><span style="font-size: 6.0pt; font-style: italic;"><br></span><span style="font-weight: 400;">[ 1.3 ] Règle collée après un espaceur</span></p>
<p style="text-align: center;"><span style="font-weight: 400;"><br></span><span style="font-weight: 400; text-decoration: underline;">Obligations</span></p>
<p style="text-align: center;"><span style="font-weight: 400;">[ 2.1 ] Obligation fictive.</span></p>
</div></div></div></div></div></section></div>
<footer><section id="h.7"><div><img role="img"></div></section></footer>
<div><div>Ce site utilise des cookies Google pour assurer le bon fonctionnement de ses services.</div></div>
</div></body></html>"""


def test_google_sites_real_structure():
    md = sd.html_to_markdown(SITES_REAL_STRUCTURE, mode="site")
    assert md.startswith("# Règlement Exemple")
    assert "**Ceci est la version officielle, toute copie est à ignorer.**" in md
    assert "## Interdictions" in md and "## Obligations" in md
    assert "[ 1.1 ] Interdiction fictive numéro un" in md
    assert "*(précision en italique)*" in md
    assert "[ 1.3 ] Règle collée après un espaceur" in md
    assert "[ 2.1 ] Obligation fictive." in md
    for noise in ("Ajoutez des titres", "Rechercher dans ce site", "Accueil", "cookies", "*.*", "\n.\n"):
        assert noise not in md, noise


MOBILEBASIC = """<html><head><style>.c3{font-weight:700}.c5{font-style:italic}.c9{color:#000}</style></head>
<body><script>var x=1;</script><div class="app-container"><div class="doc-container"><div class="doc">
<div class="doc-content"><style>.lst-kix_a > li{counter-increment:x}</style>
<h1 class="c9"><span>Devise fictive</span></h1>
<p><span class="c3">Article gras</span><span> suivi de texte normal assez long.</span></p>
<ul><li><span class="c5">Élément en italique</span></li><li><span>Élément simple</span></li></ul>
</div></div></div></div></body></html>"""


def test_gdoc_with_download_disabled_uses_mobilebasic():
    base = f"https://docs.google.com/document/d/{DOC_ID}"
    p = {
        f"{base}/export?format=md": sd.Response(401, "text/html", f"{base}/export?format=md", "<html>401</html>"),
        f"{base}/export?format=html": sd.Response(401, "text/html", f"{base}/export?format=html", "<html>401</html>"),
        f"{base}/mobilebasic": sd.Response(200, "text/html; charset=utf-8", f"{base}/mobilebasic", MOBILEBASIC),
    }
    md = sd.fetch_markdown(make_sources()[0], FakeHttp(p))
    assert md.startswith("# Devise fictive")
    assert "**Article gras** suivi de texte normal" in md
    assert "- *Élément en italique*" in md
    assert "counter-increment" not in md and "var x" not in md


def test_gdoc_all_formats_refused_reports_first_error():
    base = f"https://docs.google.com/document/d/{DOC_ID}"
    p = {u: sd.Response(401, "text/html", u, "x") for u in
         (f"{base}/export?format=md", f"{base}/export?format=html", f"{base}/mobilebasic")}
    with pytest.raises(sd.FetchError, match="HTTP 401"):
        sd.fetch_markdown(make_sources()[0], FakeHttp(p))


def test_embedded_base64_images_are_removed():
    big = "A" * 100_000
    md = "# Titre\n\nTexte avant ![][image1] texte après, suffisamment long.\n\n[image1]: <data:image/png;base64," + big + ">\n"
    p = pages(md=md)
    out = sd.fetch_markdown(make_sources()[0], FakeHttp(p))
    assert len(out) < 200
    assert "*[image]*" in out and "base64" not in out


def test_google_sites_multiline_paragraphs_are_split():
    # Structure de la page « Hiérarchie » : intertitres soulignés et grades dans un même <p>, séparés par des <br>.
    html = """<html><body><section><div role="main"><h1>Grades</h1></div></section><section><div>
    <p><span style="font-weight:900;text-decoration:underline">Hiérarchie </span><span style="font-weight:900;text-decoration:underline">fictive</span><span style="font-size:12.0pt;font-weight:900"><br/></span><span style="font-size:12.0pt;font-weight:900"><br/></span><span style="font-weight:900;text-decoration:underline">Officiers :</span></p>
    <p><span style="font-weight:900">[CMD] </span><span style="font-weight:900">Comman</span><span style="font-weight:900">dant</span><span style="font-weight:900"><br/></span><span style="font-style:italic;font-weight:400">Description du grade.</span><span style="font-weight:900"><br/></span><span style="font-weight:900;text-decoration:underline">Sous-officiers :</span></p>
    </div></section></body></html>"""
    md = sd.html_to_markdown(html, mode="site")
    assert "## Hiérarchie fictive\n\n## Officiers :" in md
    assert "**[CMD] Commandant**\n\n*Description du grade.*" in md
    assert "## Sous-officiers :" in md


def test_line_break_inside_a_span_splits_lines():
    # Cas réel (Google Docs) : <span>ligne 1<br>ligne 2<br>ligne 3</span>
    html = '<div class="doc-content"><p><span>CT XX-YYYY<br>X → première explication.<br>Y → seconde explication.</span></p></div>'
    md = sd.html_to_markdown(html, mode="docs")
    assert md.strip().split("\n\n") == ["CT XX-YYYY", "X → première explication.", "Y → seconde explication."]
