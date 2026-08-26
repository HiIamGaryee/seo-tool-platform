from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import config_loader
from anchors import AnchorProfile
from topics import TextEvidence, count_hits

LEVEL_LOW = "Low"
LEVEL_MODERATE = "Moderate"
LEVEL_HIGH = "High"
LEVEL_VERY_HIGH = "Very High"


@dataclass
class SpamSignal:
    """One triggered rule. `detail` is what the UI shows the user verbatim."""

    code: str
    label: str
    detail: str
    points: int


@dataclass
class SpamAssessment:
    score: Optional[int] = None
    level: Optional[str] = None
    signals: list[SpamSignal] = field(default_factory=list)
    detected_categories: list[str] = field(default_factory=list)
    evaluated_rules: list[str] = field(default_factory=list)

    @property
    def has_data(self) -> bool:
        return self.score is not None


def level_for(score: int) -> str:
    levels = config_loader.scoring().get("spam_risk", {}).get("levels", {})
    if score <= int(levels.get("low_max", 20)):
        return LEVEL_LOW
    if score <= int(levels.get("moderate_max", 45)):
        return LEVEL_MODERATE
    if score <= int(levels.get("high_max", 70)):
        return LEVEL_HIGH
    return LEVEL_VERY_HIGH


def spam_keyword_set() -> set[str]:
    """Flat set of every configured spam keyword token, for anchor matching."""
    words: set[str] = set()
    for spec in config_loader.spam_categories().values():
        for keyword in spec.get("keywords", []):
            words.update(keyword.lower().split())
    return words


def detect_categories(evidence: TextEvidence) -> list[tuple[str, int, int]]:
    """Spam categories present in the domain's history.

    Returns (category, hit_count, configured_points) triples.
    """
    if evidence.is_empty:
        return []

    haystack = evidence.joined()
    found: list[tuple[str, int, int]] = []
    for name, spec in config_loader.spam_categories().items():
        hits = count_hits(haystack, spec.get("keywords", []))
        if hits > 0:
            found.append((name, hits, int(spec.get("points", 10))))
    return sorted(found, key=lambda row: -row[2])


def assess(
    domain: str,
    evidence: TextEvidence,
    anchor_profile: AnchorProfile,
    topic_switch_count: Optional[int],
    referring_domains: Optional[int],
    new_backlinks: Optional[int],
    lost_backlinks: Optional[int],
    total_backlinks: Optional[int],
) -> SpamAssessment:
    """Deterministic spam risk. Every point is traceable to one printed rule.

    Returns an assessment with score None when no input signal was available at
    all — an unknown history is not a clean history.
    """
    cfg = config_loader.scoring().get("spam_risk", {})
    signals: list[SpamSignal] = []
    evaluated: list[str] = []

    # --- historical spam content -------------------------------------------
    categories: list[str] = []
    if not evidence.is_empty:
        evaluated.append("historical_content")
        for name, hits, points in detect_categories(evidence):
            categories.append(name)
            signals.append(
                SpamSignal(
                    code=f"history_{name.lower().replace(' ', '_')}",
                    label=f"Historical {name} content",
                    detail=f"{hits} {name.lower()} keyword hit{'s' if hits != 1 else ''} in archived titles, meta or anchors",
                    points=points,
                )
            )

    # --- anchor profile -----------------------------------------------------
    if anchor_profile.has_data:
        evaluated.append("anchor_profile")

        threshold = float(cfg.get("suspicious_anchor_pct_threshold", 25))
        if anchor_profile.suspicious_pct is not None and anchor_profile.suspicious_pct >= threshold:
            signals.append(
                SpamSignal(
                    code="suspicious_anchors",
                    label="Suspicious anchor concentration",
                    detail=f"{anchor_profile.suspicious_pct}% of anchors contain spam keywords (threshold {threshold:g}%)",
                    points=int(cfg.get("suspicious_anchor_points", 20)),
                )
            )

        exact_threshold = float(cfg.get("exact_match_concentration_threshold", 35))
        if anchor_profile.exact_match_pct is not None and anchor_profile.exact_match_pct >= exact_threshold:
            signals.append(
                SpamSignal(
                    code="exact_match_anchors",
                    label="High exact-match anchor ratio",
                    detail=f"{anchor_profile.exact_match_pct}% exact-match anchors (threshold {exact_threshold:g}%)",
                    points=int(cfg.get("exact_match_points", 12)),
                )
            )

    # --- topic volatility ---------------------------------------------------
    if topic_switch_count is not None:
        evaluated.append("topic_switching")
        switch_threshold = int(cfg.get("topic_switch_threshold", 3))
        if topic_switch_count >= switch_threshold:
            points = min(
                topic_switch_count * int(cfg.get("topic_switch_points_each", 6)),
                int(cfg.get("topic_switch_points_cap", 24)),
            )
            signals.append(
                SpamSignal(
                    code="topic_switching",
                    label="Unrelated topic changes",
                    detail=f"{topic_switch_count} topic changes across the archive (threshold {switch_threshold})",
                    points=points,
                )
            )

    # --- backlink shape ----------------------------------------------------
    if total_backlinks is not None and referring_domains:
        evaluated.append("backlink_shape")
        ratio = total_backlinks / referring_domains
        spike_ratio = float(cfg.get("backlink_spike_ratio", 3.0))
        # Many links from very few domains is the classic footprint of a
        # sitewide or network link blast.
        if ratio >= spike_ratio * 25:
            signals.append(
                SpamSignal(
                    code="backlink_concentration",
                    label="Abnormal backlink concentration",
                    detail=f"{ratio:.0f} backlinks per referring domain — links come from very few sources",
                    points=int(cfg.get("backlink_spike_points", 14)),
                )
            )

    if lost_backlinks is not None and total_backlinks:
        evaluated.append("backlink_decay")
        lost_ratio = lost_backlinks / max(total_backlinks, 1)
        if lost_ratio >= float(cfg.get("lost_backlink_ratio", 0.6)):
            signals.append(
                SpamSignal(
                    code="backlink_decay",
                    label="Heavy backlink loss",
                    detail=f"{lost_backlinks:,} lost vs {total_backlinks:,} live backlinks ({lost_ratio * 100:.0f}%)",
                    points=int(cfg.get("lost_backlink_points", 8)),
                )
            )

    if not evaluated:
        # No history, no anchors, no backlinks: we genuinely cannot say.
        return SpamAssessment()

    score = min(100, sum(signal.points for signal in signals))
    return SpamAssessment(
        score=score,
        level=level_for(score),
        signals=signals,
        detected_categories=categories,
        evaluated_rules=evaluated,
    )
