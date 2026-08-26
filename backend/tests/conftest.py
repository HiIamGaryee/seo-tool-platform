"""Test configuration.

Every test runs against a temporary database and a temporary source directory,
and no test is allowed to touch the network.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

MODULE_DIR = Path(__file__).resolve().parents[1] / "domain_monitor"
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    """Point every module at throwaway paths and clear inherited config."""
    for key in list(os.environ):
        if key.startswith(("DOMAIN_", "ZONE_FILE_", "BACKLINK_", "RDAP_", "CRAWL4AI_", "GEMINI_")):
            monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("DOMAIN_MONITOR_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("DOMAIN_MONITOR_SOURCES", str(tmp_path / "manual"))
    (tmp_path / "manual").mkdir()

    import storage

    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "test.db")
    storage.migrate()
    yield tmp_path


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if a test tries to make a real HTTP request."""
    import requests

    def blocked(*args, **kwargs):
        raise AssertionError("Tests must not perform live network calls")

    monkeypatch.setattr(requests.Session, "request", blocked)
    monkeypatch.setattr(requests, "get", blocked)
