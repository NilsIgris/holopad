#!/usr/bin/env python3
"""Génère les données de test (fictives) utilisées par les tests Rust d'interopérabilité.

    python tools/sync_docs/make_test_vector.py crates/rp-core/tests/fixtures
"""

import datetime as dt
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_docs as sd  # noqa: E402

PASSPHRASE = "vecteur de test holopad"
SITE = "https://sites.google.com/view/exemple-test/page"


class Http:
    def __init__(self, extra: str):
        self.extra = extra

    def get(self, url: str) -> sd.Response:
        if url.endswith("format=md"):
            body = "# Règlement fictif\n\n**1.01** : Article de test.\n" + self.extra
            return sd.Response(200, "text/markdown", url, body)
        html = "<div role='main'><h1>Page fictive</h1><p>Texte de test suffisamment long.</p></div>"
        return sd.Response(200, "text/html", url, html)


def main(target: Path) -> None:
    sources = [
        sd.Source("alpha-test", "Document fictif", "alpha", "gdoc", "EXEMPLEexempleEXEMPLE0001"),
        sd.Source("gree-test", "Page fictive", "gree", "gsite", SITE),
    ]
    work = target / "_work"
    shutil.rmtree(work, ignore_errors=True)
    for version, extra, day in (("v1", "", 1), ("v2", "**1.02** : Article ajouté.\n", 2)):
        sd.sync(sources, PASSPHRASE, work, Http(extra), iterations=1000, log=lambda _: None,
                now=lambda d=day: dt.datetime(2026, 11, d, tzinfo=dt.timezone.utc))
        dest = target / version
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(work, dest)
    shutil.rmtree(work)
    (target / "PASSPHRASE.txt").write_text(PASSPHRASE + "\n", "utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
