from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CONFIG_DIR = Path(
    os.environ.get(
        "DOMAIN_MONITOR_CONFIG",
        str(Path(__file__).resolve().parent / "config"),
    )
)

_cache: dict[str, Any] = {}
_lock = threading.Lock()


def load(name: str) -> dict[str, Any]:
    """Read a JSON config file once and memoise it.

    Config is data, not code: editing these files changes classification and
    scoring without touching a single module.
    """
    with _lock:
        if name in _cache:
            return _cache[name]
        path = CONFIG_DIR / name
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.error("Could not read config %s: %s", path, exc)
            data = {}
        _cache[name] = data
        return data


def topics() -> dict[str, list[str]]:
    return load("seo_topics.json").get("topics", {})


def spam_categories() -> dict[str, dict[str, Any]]:
    return load("spam_keywords.json").get("categories", {})


def generic_anchors() -> list[str]:
    return load("spam_keywords.json").get("generic_anchors", [])


def scoring() -> dict[str, Any]:
    return load("scoring.json")


def reset_cache() -> None:
    """Drop memoised config. Used by tests and after an admin edits a file."""
    with _lock:
        _cache.clear()
