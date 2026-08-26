from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Optional

import config_loader

# Rule match strength bands. Deliberately not called "confidence" — there is no
# model here, only counted keyword hits.
STRENGTH_HIGH = "High"
STRENGTH_MEDIUM = "Medium"
STRENGTH_LOW = "Low"
STRENGTH_NONE = "None"

RELEVANCE_HIGH = "High"
RELEVANCE_MEDIUM = "Medium"
RELEVANCE_LOW = "Low"
RELEVANCE_NONE = "None"

_WORD_SPLIT = re.compile(r"[^a-z0-9]+")
_pattern_cache: dict[str, re.Pattern[str]] = {}


def _pattern(keyword: str) -> re.Pattern[str]:
    """Word-boundary matcher for one keyword or phrase."""
    cached = _pattern_cache.get(keyword)
    if cached is None:
        cached = re.compile(rf"(?<![a-z0-9]){re.escape(keyword.lower())}(?![a-z0-9])")
        _pattern_cache[keyword] = cached
    return cached


def normalize_text(value: Optional[str]) -> str:
    """Lowercase and flatten separators so URLs and titles match the same way."""
    if not value:
        return ""
    return " ".join(_WORD_SPLIT.split(value.lower())).strip()


def count_hits(text: Optional[str], keywords: Iterable[str]) -> int:
    """Total keyword occurrences in one text field."""
    haystack = normalize_text(text)
    if not haystack:
        return 0
    return sum(len(_pattern(kw).findall(haystack)) for kw in keywords)


@dataclass
class TopicSignal:
    """Which text fields produced hits for one topic, and how many."""

    topic: str
    title_hits: int = 0
    meta_hits: int = 0
    anchor_hits: int = 0
    url_hits: int = 0

    @property
    def total(self) -> int:
        return self.title_hits + self.meta_hits + self.anchor_hits + self.url_hits


@dataclass
class TopicResult:
    primary_topic: Optional[str] = None
    secondary_topics: list[str] = field(default_factory=list)
    topic_match_count: int = 0
    match_strength: str = STRENGTH_NONE
    per_topic: dict[str, int] = field(default_factory=dict)
    signals: dict[str, TopicSignal] = field(default_factory=dict)

    @property
    def has_data(self) -> bool:
        return bool(self.per_topic)


@dataclass
class TextEvidence:
    """Everything the topic and spam rules are allowed to read."""

    titles: list[str] = field(default_factory=list)
    metas: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    anchors: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not (self.titles or self.metas or self.urls or self.anchors)

    def joined(self) -> str:
        return " ".join([*self.titles, *self.metas, *self.urls, *self.anchors])


def _topic_vocabulary(include_spam: bool) -> dict[str, list[str]]:
    """Editorial topics, optionally widened with the spam categories.

    Spam categories count as topics for timeline and switch detection: a site
    that turned into a casino really did change topic, and treating that as
    "no topic" would hide the volatility the spam rules need to see.
    """
    vocabulary = dict(config_loader.topics())
    if include_spam:
        for name, spec in config_loader.spam_categories().items():
            vocabulary.setdefault(name, spec.get("keywords", []))
    return vocabulary


def classify(evidence: TextEvidence, include_spam: bool = True) -> TopicResult:
    """Score every configured topic against the collected text evidence.

    Returns None-valued topics when there is nothing to read, so the caller can
    distinguish "no topic matched" from "no data collected".
    """
    result = TopicResult()
    if evidence.is_empty:
        return result

    configured = _topic_vocabulary(include_spam)
    signals: dict[str, TopicSignal] = {}

    for topic, keywords in configured.items():
        signal = TopicSignal(topic=topic)
        for title in evidence.titles:
            signal.title_hits += count_hits(title, keywords)
        for meta in evidence.metas:
            signal.meta_hits += count_hits(meta, keywords)
        for anchor in evidence.anchors:
            signal.anchor_hits += count_hits(anchor, keywords)
        for url in evidence.urls:
            signal.url_hits += count_hits(url, keywords)
        if signal.total > 0:
            signals[topic] = signal

    if not signals:
        return result

    ranked = sorted(signals.values(), key=lambda s: (-s.total, s.topic))
    result.signals = signals
    result.per_topic = {s.topic: s.total for s in ranked}
    result.primary_topic = ranked[0].topic
    result.secondary_topics = [s.topic for s in ranked[1:4]]
    result.topic_match_count = ranked[0].total

    top = ranked[0].total
    fields_hit = sum(
        1 for value in (ranked[0].title_hits, ranked[0].meta_hits, ranked[0].anchor_hits, ranked[0].url_hits) if value
    )
    # Strength rises with both volume and how many independent fields agree.
    if top >= 8 and fields_hit >= 2:
        result.match_strength = STRENGTH_HIGH
    elif top >= 4:
        result.match_strength = STRENGTH_MEDIUM
    else:
        result.match_strength = STRENGTH_LOW

    return result


def relevance(
    evidence: TextEvidence,
    target_niches: Iterable[str],
) -> tuple[Optional[int], str]:
    """Weighted keyword score for the admin's target niches.

    Returns (score, band). Score is None when no niches are configured, which
    the UI renders as "not set" rather than as a zero.
    """
    niches = [n for n in target_niches if n]
    if not niches:
        return None, RELEVANCE_NONE
    if evidence.is_empty:
        return None, RELEVANCE_NONE

    cfg = config_loader.scoring().get("topical_relevance", {})
    points = cfg.get("points", {})
    cap = int(cfg.get("score_cap", 40))
    bands = cfg.get("bands", {})
    configured = config_loader.topics()

    score = 0
    for niche in niches:
        keywords = configured.get(niche)
        if not keywords:
            continue
        for title in evidence.titles:
            score += count_hits(title, keywords) * int(points.get("title_match", 5))
        for meta in evidence.metas:
            score += count_hits(meta, keywords) * int(points.get("meta_match", 3))
        for anchor in evidence.anchors:
            score += count_hits(anchor, keywords) * int(points.get("anchor_match", 3))
        for url in evidence.urls:
            score += count_hits(url, keywords) * int(points.get("url_match", 2))

    score = min(score, cap)

    if score >= int(bands.get("high_min", 20)):
        return score, RELEVANCE_HIGH
    if score >= int(bands.get("medium_min", 10)):
        return score, RELEVANCE_MEDIUM
    if score >= int(bands.get("low_min", 1)):
        return score, RELEVANCE_LOW
    return score, RELEVANCE_NONE


def topic_timeline(snapshots: list[dict]) -> list[dict]:
    """Per-snapshot primary topic, oldest first. Drives the history timeline."""
    timeline: list[dict] = []
    for snap in sorted(snapshots, key=lambda s: s.get("year") or 0):
        evidence = TextEvidence(
            titles=[snap.get("title") or ""],
            metas=[snap.get("meta_description") or ""],
            urls=[snap.get("url") or ""],
        )
        result = classify(evidence, include_spam=True)
        timeline.append(
            {
                "year": snap.get("year"),
                "timestamp": snap.get("timestamp"),
                "title": snap.get("title"),
                "topic": result.primary_topic,
            }
        )
    return timeline


def count_topic_switches(timeline: list[dict]) -> int:
    """Distinct consecutive topic changes across the timeline.

    Snapshots with no detectable topic are skipped rather than counted as a
    change, so a blank archive page does not manufacture volatility.
    """
    seen = [entry["topic"] for entry in timeline if entry.get("topic")]
    if len(seen) < 2:
        return 0
    return sum(1 for a, b in zip(seen, seen[1:]) if a != b)


def stability_label(switch_count: int) -> str:
    labels = config_loader.scoring().get("historical_stability", {}).get("stability_labels", {})
    if switch_count <= int(labels.get("stable_max_switches", 1)):
        return "Stable"
    if switch_count <= int(labels.get("some_changes_max_switches", 3)):
        return "Some Changes"
    return "High Topic Volatility"


def dominant_topic(timeline: list[dict]) -> Optional[str]:
    """Most frequent topic across the archive, used as the historical topic."""
    counts = Counter(entry["topic"] for entry in timeline if entry.get("topic"))
    if not counts:
        return None
    return counts.most_common(1)[0][0]
