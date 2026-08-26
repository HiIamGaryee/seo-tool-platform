from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import config_loader
from anchors import AnchorProfile
from backlinks import BacklinkMetrics
from history_client import HistoryResult
from models import registrable_name
from spam import SpamAssessment
from topics import RELEVANCE_HIGH, RELEVANCE_LOW, RELEVANCE_MEDIUM

LABEL_EXCELLENT = "Excellent"
LABEL_STRONG = "Strong"
LABEL_GOOD = "Good"
LABEL_REVIEW = "Review"
LABEL_WEAK = "Weak"

CONFIDENCE_FULL = "Full"
CONFIDENCE_PARTIAL = "Partial"
CONFIDENCE_LIMITED = "Limited"


@dataclass
class Component:
    """One weighted contributor to the SEO Opportunity Score.

    `awarded` is None when the underlying data was unavailable. Such a component
    is excluded from the total and its weight is redistributed, so absent data
    never masquerades as a zero score.
    """

    key: str
    label: str
    weight: int
    awarded: Optional[float] = None
    detail: str = ""
    available: bool = True

    @property
    def ratio(self) -> Optional[float]:
        if self.awarded is None or not self.weight:
            return None
        return self.awarded / self.weight


@dataclass
class ScoreResult:
    base_score: Optional[int] = None
    spam_penalty: int = 0
    final_score: Optional[int] = None
    label: Optional[str] = None
    components: list[Component] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    concerns: list[str] = field(default_factory=list)
    available_weight: int = 0
    total_weight: int = 0
    confidence: Optional[str] = None
    unscored_reason: Optional[str] = None

    @property
    def has_score(self) -> bool:
        return self.final_score is not None

    @property
    def completeness_pct(self) -> Optional[int]:
        if not self.total_weight:
            return None
        return round(self.available_weight / self.total_weight * 100)


def _band_ratio(value: Optional[float], bands: list) -> Optional[float]:
    """Piecewise-linear lookup: bands are [threshold, ratio] pairs, ascending."""
    if value is None or not bands:
        return None
    ordered = sorted((float(t), float(r)) for t, r in bands)
    if value <= ordered[0][0]:
        return ordered[0][1]
    for (low_t, low_r), (high_t, high_r) in zip(ordered, ordered[1:]):
        if value <= high_t:
            span = high_t - low_t
            if span <= 0:
                return high_r
            return low_r + (high_r - low_r) * ((value - low_t) / span)
    return ordered[-1][1]


def label_for(score: int) -> str:
    labels = config_loader.scoring().get("seo_score_labels", {})
    if score >= int(labels.get("excellent_min", 90)):
        return LABEL_EXCELLENT
    if score >= int(labels.get("strong_min", 80)):
        return LABEL_STRONG
    if score >= int(labels.get("good_min", 70)):
        return LABEL_GOOD
    if score >= int(labels.get("review_min", 60)):
        return LABEL_REVIEW
    return LABEL_WEAK


def domain_quality_ratio(domain: str) -> tuple[float, list[str]]:
    """Structural readability of the name. Says nothing about resale value."""
    cfg = config_loader.scoring().get("domain_quality", {})
    name = registrable_name(domain)
    tld = "." + domain.rsplit(".", 1)[-1]
    notes: list[str] = []
    ratio = 1.0

    ideal = int(cfg.get("length_ideal_max", 12))
    poor = int(cfg.get("length_poor_min", 22))
    if len(name) <= ideal:
        notes.append(f"short name ({len(name)} characters)")
    elif len(name) >= poor:
        ratio -= 0.35
        notes.append(f"long name ({len(name)} characters)")
    else:
        ratio -= 0.15

    hyphens = name.count("-")
    if hyphens:
        ratio -= float(cfg.get("hyphen_penalty", 0.3)) * min(hyphens, 2)
        notes.append(f"{hyphens} hyphen{'s' if hyphens > 1 else ''}")
    else:
        notes.append("no hyphen")

    digits = sum(ch.isdigit() for ch in name)
    if digits:
        ratio -= float(cfg.get("digit_penalty", 0.25))
        notes.append(f"{digits} digit{'s' if digits > 1 else ''}")
    else:
        notes.append("no numbers")

    preferred = cfg.get("preferred_tlds", [])
    if tld in preferred:
        ratio += float(cfg.get("preferred_tld_bonus", 0.2))
        notes.append(f"preferred TLD {tld}")

    if domain.count(".") > 1:
        ratio -= float(cfg.get("subdomain_penalty", 0.15))
        notes.append("multi-label host")

    return max(0.0, min(1.0, ratio)), notes


def _referring_domain_component(weight: int, metrics: BacklinkMetrics) -> Component:
    cfg = config_loader.scoring().get("referring_domain_bands", [])
    if not metrics.has_data:
        return Component(
            key="referring_domains",
            label="Referring Domains",
            weight=weight,
            available=False,
            detail=metrics.error or "No backlink provider data",
        )
    # has_data guarantees a real number here, so 0 means the provider truly
    # reported zero referring domains rather than "unmeasured".
    count = metrics.referring_domains
    ratio = _band_ratio(count, cfg)
    if ratio is None:
        return Component(
            key="referring_domains",
            label="Referring Domains",
            weight=weight,
            available=False,
            detail="Scoring bands are misconfigured",
        )
    return Component(
        key="referring_domains",
        label="Referring Domains",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=f"{count:,} referring domains",
    )


def _backlink_quality_component(weight: int, metrics: BacklinkMetrics) -> Component:
    cfg = config_loader.scoring().get("backlink_quality", {})
    if not metrics.has_data:
        return Component(
            key="backlink_quality",
            label="Backlink Quality",
            weight=weight,
            available=False,
            detail=metrics.error or "No backlink provider data",
        )

    parts: list[tuple[float, float]] = []  # (sub_ratio, sub_weight)
    notes: list[str] = []

    follow_pct = metrics.follow_percentage
    follow_weight = float(cfg.get("follow_pct_weight", 0.35))
    if follow_pct is not None:
        low = float(cfg.get("follow_pct_ideal_min", 40))
        high = float(cfg.get("follow_pct_ideal_max", 90))
        if low <= follow_pct <= high:
            sub = 1.0
        elif follow_pct < low:
            sub = max(0.0, follow_pct / low)
        else:
            sub = max(0.0, 1 - (follow_pct - high) / (100 - high))
        parts.append((sub, follow_weight))
        notes.append(f"{follow_pct:g}% follow")

    diversity_weight = float(cfg.get("diversity_weight", 0.35))
    if metrics.referring_domains and metrics.total_backlinks:
        per_domain = metrics.total_backlinks / metrics.referring_domains
        ideal = float(cfg.get("diversity_ideal_links_per_domain", 25))
        # Fewer links per domain means broader, more natural distribution.
        sub = 1.0 if per_domain <= ideal else max(0.0, ideal / per_domain)
        parts.append((sub, diversity_weight))
        notes.append(f"{per_domain:.1f} links per domain")

    tld_weight = float(cfg.get("tld_spread_weight", 0.3))
    if metrics.top_referring_tlds:
        target = float(cfg.get("tld_spread_target", 6))
        spread = len(metrics.top_referring_tlds)
        parts.append((min(1.0, spread / target), tld_weight))
        notes.append(f"{spread} referring TLDs")

    if not parts:
        return Component(
            key="backlink_quality",
            label="Backlink Quality",
            weight=weight,
            available=False,
            detail="Provider returned no quality signals",
        )

    total_sub_weight = sum(w for _, w in parts)
    ratio = sum(sub * w for sub, w in parts) / total_sub_weight
    return Component(
        key="backlink_quality",
        label="Backlink Quality",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=", ".join(notes),
    )


def _history_component(
    weight: int,
    history: HistoryResult,
    switch_count: Optional[int],
) -> Component:
    cfg = config_loader.scoring().get("historical_stability", {})
    if not history.has_data:
        return Component(
            key="historical_stability",
            label="History",
            weight=weight,
            available=False,
            detail=history.error or "No archive history found",
        )

    ratio = _band_ratio(history.snapshot_count, cfg.get("snapshot_bands", []))
    if ratio is None:
        return Component(
            key="historical_stability",
            label="History",
            weight=weight,
            available=False,
            detail="Scoring bands are misconfigured",
        )
    notes = [f"{history.snapshot_count:,} archive captures"]

    if switch_count:
        penalty = float(cfg.get("switch_penalty_per_change", 0.25)) * switch_count
        ratio = max(0.0, ratio - penalty)
        notes.append(f"{switch_count} topic change{'s' if switch_count > 1 else ''}")
    else:
        notes.append("no topic change detected")

    return Component(
        key="historical_stability",
        label="History",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=", ".join(notes),
    )


def _relevance_component(
    weight: int,
    relevance_score: Optional[int],
    relevance_band: str,
    niches_configured: bool,
) -> Component:
    if not niches_configured:
        return Component(
            key="topical_relevance",
            label="Topical Relevance",
            weight=weight,
            available=False,
            detail="No target niches configured",
        )
    if relevance_score is None:
        return Component(
            key="topical_relevance",
            label="Topical Relevance",
            weight=weight,
            available=False,
            detail="No historical text to match against",
        )

    cap = int(config_loader.scoring().get("topical_relevance", {}).get("score_cap", 40))
    ratio = min(1.0, relevance_score / cap) if cap else 0.0
    return Component(
        key="topical_relevance",
        label="Topical Relevance",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=f"{relevance_band} relevance ({relevance_score}/{cap} keyword points)",
    )


def _age_component(weight: int, age_years: Optional[float]) -> Component:
    if age_years is None:
        return Component(
            key="domain_age",
            label="Domain Age",
            weight=weight,
            available=False,
            detail="No registry creation date published",
        )
    ratio = _band_ratio(age_years, config_loader.scoring().get("domain_age", {}).get("bands", []))
    if ratio is None:
        return Component(
            key="domain_age",
            label="Domain Age",
            weight=weight,
            available=False,
            detail="Scoring bands are misconfigured",
        )
    return Component(
        key="domain_age",
        label="Domain Age",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=f"{age_years:.0f} year{'s' if age_years >= 2 else ''} old",
    )


def _anchor_component(weight: int, profile: AnchorProfile) -> Component:
    cfg = config_loader.scoring().get("anchor_profile", {})
    if not profile.has_data:
        return Component(
            key="anchor_profile",
            label="Anchor Profile",
            weight=weight,
            available=False,
            detail="No anchor data from provider",
        )

    ratio = 1.0
    notes: list[str] = []

    suspicious_zero_at = float(cfg.get("suspicious_pct_zero_at", 45))
    if profile.suspicious_pct is not None:
        ratio -= min(1.0, profile.suspicious_pct / suspicious_zero_at)
        notes.append(f"{profile.suspicious_pct:g}% suspicious")

    generic_start = float(cfg.get("generic_pct_penalty_start", 35))
    if profile.generic_pct is not None and profile.generic_pct > generic_start:
        ratio -= min(0.3, (profile.generic_pct - generic_start) / 100)
        notes.append(f"{profile.generic_pct:g}% generic")

    exact_start = float(cfg.get("exact_match_concentration_penalty_start", 30))
    if profile.exact_match_pct is not None and profile.exact_match_pct > exact_start:
        ratio -= min(0.3, (profile.exact_match_pct - exact_start) / 100)
        notes.append(f"{profile.exact_match_pct:g}% exact-match")

    return Component(
        key="anchor_profile",
        label="Anchor Profile",
        weight=weight,
        awarded=round(max(0.0, ratio) * weight, 1),
        detail=", ".join(notes) if notes else "clean anchor distribution",
    )


def _quality_component(weight: int, domain: str) -> Component:
    ratio, notes = domain_quality_ratio(domain)
    return Component(
        key="domain_quality",
        label="Domain Quality",
        weight=weight,
        awarded=round(ratio * weight, 1),
        detail=", ".join(notes),
    )


def compute(
    domain: str,
    metrics: BacklinkMetrics,
    history: HistoryResult,
    anchor_profile: AnchorProfile,
    spam_assessment: SpamAssessment,
    switch_count: Optional[int],
    relevance_score: Optional[int],
    relevance_band: str,
    age_years: Optional[float],
    niches_configured: bool,
) -> ScoreResult:
    """The SEO Opportunity Score. Entirely rule-based and reproducible.

    Weight from unavailable components is redistributed across the rest, and the
    result reports how much of the model it was able to use.
    """
    weights = config_loader.scoring().get("weights", {})

    components = [
        _referring_domain_component(int(weights.get("referring_domains", 25)), metrics),
        _backlink_quality_component(int(weights.get("backlink_quality", 20)), metrics),
        _history_component(int(weights.get("historical_stability", 15)), history, switch_count),
        _relevance_component(
            int(weights.get("topical_relevance", 15)), relevance_score, relevance_band, niches_configured
        ),
        _age_component(int(weights.get("domain_age", 10)), age_years),
        _anchor_component(int(weights.get("anchor_profile", 10)), anchor_profile),
        _quality_component(int(weights.get("domain_quality", 5)), domain),
    ]

    total_weight = sum(c.weight for c in components)
    available = [c for c in components if c.available and c.awarded is not None]
    available_weight = sum(c.weight for c in available)

    result = ScoreResult(
        components=components,
        total_weight=total_weight,
        available_weight=available_weight,
    )

    cfg = config_loader.scoring()
    floor_pct = float(cfg.get("minimum_available_weight_pct", 35))
    coverage_pct = (available_weight / total_weight * 100) if total_weight else 0.0

    result.reasons, result.concerns = _explain(components, spam_assessment)

    if coverage_pct < floor_pct:
        # Renormalising over a sliver of the model would publish a confident
        # number built on almost nothing, so we publish no number at all.
        missing = [c.label for c in components if not c.available]
        result.unscored_reason = (
            f"Only {coverage_pct:.0f}% of the scoring model had data "
            f"(minimum {floor_pct:.0f}%). Missing: {', '.join(missing)}."
        )
        return result

    earned = sum(c.awarded or 0 for c in available)
    result.base_score = round(earned / available_weight * 100)

    penalty_factor = float(cfg.get("spam_penalty_factor", 0.5))
    result.spam_penalty = round((spam_assessment.score or 0) * penalty_factor)
    result.final_score = max(0, result.base_score - result.spam_penalty)
    result.label = label_for(result.final_score)

    labels = cfg.get("completeness_labels", {})
    if coverage_pct >= float(labels.get("full_min", 95)):
        result.confidence = CONFIDENCE_FULL
    elif coverage_pct >= float(labels.get("partial_min", 60)):
        result.confidence = CONFIDENCE_PARTIAL
    else:
        result.confidence = CONFIDENCE_LIMITED

    return result


def _explain(
    components: list[Component],
    spam_assessment: SpamAssessment,
) -> tuple[list[str], list[str]]:
    """Deterministic bullet points. Templated from the component details.

    This is string formatting over computed numbers, not generated prose.
    """
    reasons: list[str] = []
    concerns: list[str] = []

    for component in components:
        if not component.available or component.ratio is None:
            concerns.append(f"{component.label}: {component.detail}")
            continue
        if component.ratio >= 0.75:
            reasons.append(f"{component.label}: {component.detail}")
        elif component.ratio <= 0.4:
            concerns.append(f"{component.label}: {component.detail}")

    for signal in spam_assessment.signals:
        concerns.append(f"{signal.label}: {signal.detail}")

    return reasons, concerns
