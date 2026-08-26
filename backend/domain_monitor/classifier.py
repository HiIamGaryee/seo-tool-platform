from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Iterable, Optional, Tuple

from models import (
    CAT_30,
    CAT_60,
    CAT_EXPIRED,
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_SAFE,
    CAT_UNKNOWN,
    PRI_CRITICAL,
    PRI_HIGH,
    PRI_LOW,
    PRI_MEDIUM,
    PRI_UNKNOWN,
    PRI_VERY_HIGH,
    PRI_WATCH,
)

# Registry statuses that override any date-based verdict, most severe first.
_STATUS_OVERRIDES = [
    ("pendingdelete", CAT_PENDING_DELETE),
    ("redemptionperiod", CAT_REDEMPTION),
]

_CATEGORY_PRIORITY = {
    CAT_PENDING_DELETE: PRI_CRITICAL,
    CAT_REDEMPTION: PRI_VERY_HIGH,
    CAT_EXPIRED: PRI_HIGH,
    CAT_30: PRI_MEDIUM,
    CAT_60: PRI_WATCH,
    CAT_SAFE: PRI_LOW,
    CAT_UNKNOWN: PRI_UNKNOWN,
}

# Used by the quality score only. Not a resale-value signal.
_PREFERRED_TLDS = {".com", ".net", ".org", ".io", ".co", ".ai", ".dev", ".tech"}


def _normalize_status(status: str) -> str:
    return "".join(ch for ch in status.lower() if ch.isalnum())


def days_left_from(expiration_date: Optional[str], today: Optional[date] = None) -> Optional[int]:
    """Whole days between today and the expiration date. None if unparseable."""
    if not expiration_date:
        return None
    reference = today or datetime.now(timezone.utc).date()
    try:
        expiry = date.fromisoformat(expiration_date[:10])
    except (ValueError, TypeError):
        return None
    return (expiry - reference).days


def classify(
    registry_status: Iterable[str],
    days_left: Optional[int],
) -> Tuple[str, str]:
    """Return (category, priority).

    Registry status wins over the date maths: a domain in pendingDelete or
    redemptionPeriod is reported as such even when its expiry date still
    reads as far away, because the lifecycle state is the real signal.
    """
    normalized = {_normalize_status(s) for s in (registry_status or []) if s}

    for token, category in _STATUS_OVERRIDES:
        if token in normalized:
            return category, _CATEGORY_PRIORITY[category]

    if days_left is None:
        return CAT_UNKNOWN, _CATEGORY_PRIORITY[CAT_UNKNOWN]
    if days_left < 0:
        return CAT_EXPIRED, _CATEGORY_PRIORITY[CAT_EXPIRED]
    if days_left <= 30:
        return CAT_30, _CATEGORY_PRIORITY[CAT_30]
    if days_left <= 60:
        return CAT_60, _CATEGORY_PRIORITY[CAT_60]
    return CAT_SAFE, _CATEGORY_PRIORITY[CAT_SAFE]


def quality_score(domain: str) -> int:
    """Structural readability score, 0-100.

    Purely mechanical: length, hyphens, digits, TLD, word count. It says
    nothing about availability, traffic or resale value.
    """
    if not domain or "." not in domain:
        return 0

    name, _, _ = domain.partition(".")
    tld = "." + domain.rsplit(".", 1)[-1]
    score = 100

    if len(name) > 20:
        score -= 30
    elif len(name) > 15:
        score -= 20
    elif len(name) > 10:
        score -= 10

    hyphens = name.count("-")
    score -= min(hyphens * 15, 30)

    digits = sum(ch.isdigit() for ch in name)
    score -= min(digits * 8, 24)

    if tld not in _PREFERRED_TLDS:
        score -= 12

    if len(domain.split(".")) > 2:
        score -= 10

    return max(0, min(100, score))
