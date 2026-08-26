from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import config_loader
from models import registrable_name
from topics import normalize_text

_WORD = re.compile(r"[a-z0-9]+")

BRANDED = "branded"
GENERIC = "generic"
EXACT_MATCH = "exact_match"
OTHER = "other"


@dataclass
class Anchor:
    text: str
    count: int
    share_pct: float
    kind: str


@dataclass
class AnchorProfile:
    """Derived entirely from provider-supplied anchor counts.

    Every field stays None when the provider gave us nothing, so the UI can
    print an em dash instead of a misleading zero.
    """

    total: Optional[int] = None
    top_anchors: list[Anchor] = field(default_factory=list)
    branded_pct: Optional[float] = None
    generic_pct: Optional[float] = None
    exact_match_pct: Optional[float] = None
    suspicious_pct: Optional[float] = None
    top_share_pct: Optional[float] = None

    @property
    def has_data(self) -> bool:
        return self.total is not None and self.total > 0


def _brand_tokens(domain: str) -> set[str]:
    """Tokens that count as the domain's own brand name."""
    name = registrable_name(domain)
    tokens = {t for t in _WORD.findall(name.lower()) if len(t) > 2}
    tokens.add(name.lower().replace("-", ""))
    return {t for t in tokens if t}


def classify_anchor(text: str, domain: str, niche_keywords: set[str]) -> str:
    """Bucket one anchor. Order matters: brand wins, then generic, then exact."""
    normalized = normalize_text(text)
    if not normalized:
        return OTHER

    brand = _brand_tokens(domain)
    words = set(_WORD.findall(normalized))
    squashed = normalized.replace(" ", "")
    brand_squashed = registrable_name(domain).lower().replace("-", "")

    # "travel hub" is the brand of travelhub.com, so compare de-spaced forms
    # too rather than relying on token equality alone.
    if words & brand or squashed == brand_squashed or brand_squashed in squashed:
        return BRANDED

    generics = {normalize_text(g) for g in config_loader.generic_anchors()}
    if normalized in generics:
        return GENERIC

    # "Exact match" here means a commercial keyword anchor with no brand token,
    # which is the pattern link schemes over-use.
    if niche_keywords and words & niche_keywords:
        return EXACT_MATCH

    return OTHER


def build_profile(
    anchor_counts: Optional[list[dict]],
    domain: str,
    spam_keywords: Optional[set[str]] = None,
    niche_keywords: Optional[set[str]] = None,
    top_n: int = 10,
) -> AnchorProfile:
    """Turn provider anchor rows into a profile.

    `anchor_counts` is a list of {"anchor": str, "count": int} straight from the
    backlink provider. None means the provider was not configured or returned
    nothing; that is different from an empty anchor list.
    """
    if anchor_counts is None:
        return AnchorProfile()

    rows = [
        (str(row.get("anchor") or "").strip(), int(row.get("count") or 0))
        for row in anchor_counts
        if row.get("anchor")
    ]
    rows = [(text, count) for text, count in rows if count > 0]
    if not rows:
        return AnchorProfile(total=0)

    total = sum(count for _, count in rows)
    niche = niche_keywords or set()
    spam = spam_keywords or set()

    buckets = {BRANDED: 0, GENERIC: 0, EXACT_MATCH: 0, OTHER: 0}
    suspicious = 0
    anchors: list[Anchor] = []

    for text, count in sorted(rows, key=lambda r: -r[1]):
        kind = classify_anchor(text, domain, niche)
        buckets[kind] += count
        words = set(_WORD.findall(normalize_text(text)))
        if words & spam:
            suspicious += count
        if len(anchors) < top_n:
            anchors.append(
                Anchor(
                    text=text,
                    count=count,
                    share_pct=round(count / total * 100, 1),
                    kind=kind,
                )
            )

    def pct(value: int) -> float:
        return round(value / total * 100, 1)

    return AnchorProfile(
        total=total,
        top_anchors=anchors,
        branded_pct=pct(buckets[BRANDED]),
        generic_pct=pct(buckets[GENERIC]),
        exact_match_pct=pct(buckets[EXACT_MATCH]),
        suspicious_pct=pct(suspicious),
        top_share_pct=anchors[0].share_pct if anchors else None,
    )
