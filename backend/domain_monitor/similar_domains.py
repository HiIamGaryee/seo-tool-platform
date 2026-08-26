from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Optional

from models import normalize_domain, registrable_name, tld_of

logger = logging.getLogger(__name__)

# RapidFuzz is reused when the environment already provides it; the stdlib
# implementation below is the default so no dependency is added for this.
try:  # pragma: no cover - depends on the installed environment
    from rapidfuzz.distance import Levenshtein as _rapidfuzz_levenshtein
except Exception:  # pragma: no cover
    _rapidfuzz_levenshtein = None

FUZZY_BACKEND = "rapidfuzz" if _rapidfuzz_levenshtein is not None else "stdlib"

# --- centralized configuration ---------------------------------------------
# Every TLD the generator is allowed to try lives here. Nothing downstream
# hardcodes a TLD list.
DEFAULT_TLDS = (
    ".com",
    ".net",
    ".org",
    ".co",
    ".io",
    ".ai",
    ".tech",
    ".xyz",
    ".online",
    ".site",
    ".info",
)

# Deterministic affixes. Deliberately short lists: the point is a controlled
# pool of plausible names, not thousands of junk permutations.
PREFIXES = ("my", "get", "go", "try", "the")
SUFFIXES = ("group", "hub", "online", "global", "asia", "us", "my", "sg", "tech", "media")
HYPHEN_PREFIXES = ("my", "go", "try", "the")
HYPHEN_SUFFIXES = ("us", "my", "sg", "online", "group", "global")
NUMERIC_SUFFIXES = ("88", "365")

VARIATION_KINDS = ("exact", "prefix", "suffix", "hyphen", "numeric")

_TLD_CHARS = set(".abcdefghijklmnopqrstuvwxyz0123456789-")


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def debug_enabled() -> bool:
    """Whether verbose discovery diagnostics are on.

    Read from the environment on every call so the flag can be flipped in a
    dev .env without editing code paths.
    """
    return _env_bool("DOMAIN_RADAR_DEBUG", False)


def rdap_verbose() -> bool:
    """Backend-only switch for dumping full RDAP payloads. Never frontend."""
    return _env_bool("DOMAIN_RADAR_RDAP_VERBOSE", False)


def normalize_tld(raw: str) -> Optional[str]:
    """Accept `com`, `.com`, `COM ` alike; reject anything that is not a TLD."""
    value = str(raw or "").strip().lower()
    if not value:
        return None
    if not value.startswith("."):
        value = f".{value}"
    if len(value) < 3 or any(ch not in _TLD_CHARS for ch in value):
        return None
    if value.count(".") > 2 or ".." in value or value.endswith("."):
        return None
    return value


def configured_tlds() -> tuple[str, ...]:
    """The TLD expansion list, from DOMAIN_DISCOVERY_TLDS or the default set."""
    raw = _env("DOMAIN_DISCOVERY_TLDS")
    if not raw:
        return DEFAULT_TLDS
    out: list[str] = []
    for chunk in raw.split(","):
        tld = normalize_tld(chunk)
        if tld and tld not in out:
            out.append(tld)
    if not out:
        logger.warning("[similar] DOMAIN_DISCOVERY_TLDS held no valid TLDs; using defaults")
        return DEFAULT_TLDS
    return tuple(out)


@dataclass(frozen=True)
class DiscoveryLimits:
    max_generated: int
    max_verified: int
    result_limit: int


def limits() -> DiscoveryLimits:
    return DiscoveryLimits(
        max_generated=max(1, _env_int("SIMILAR_DOMAIN_MAX_GENERATED", 300)),
        max_verified=max(1, _env_int("SIMILAR_DOMAIN_MAX_VERIFIED", 200)),
        result_limit=max(1, _env_int("SIMILAR_DOMAIN_RESULT_LIMIT", 30)),
    )


@dataclass(frozen=True)
class RankWeights:
    similarity: float
    lifecycle: float
    seo: float


def rank_weights() -> RankWeights:
    """Ranking weights, configurable and normalised so they always sum to 1."""
    similarity = max(0.0, _env_float("SIMILAR_RANK_WEIGHT_SIMILARITY", 0.45))
    lifecycle = max(0.0, _env_float("SIMILAR_RANK_WEIGHT_LIFECYCLE", 0.30))
    seo = max(0.0, _env_float("SIMILAR_RANK_WEIGHT_SEO", 0.25))
    total = similarity + lifecycle + seo
    if total <= 0:
        return RankWeights(0.45, 0.30, 0.25)
    return RankWeights(similarity / total, lifecycle / total, seo / total)


# --- similarity -------------------------------------------------------------

def levenshtein(left: str, right: str) -> int:
    """Edit distance. Uses RapidFuzz when installed, stdlib DP otherwise."""
    if _rapidfuzz_levenshtein is not None:  # pragma: no cover
        return int(_rapidfuzz_levenshtein.distance(left, right))
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for i, lchar in enumerate(left, start=1):
        current = [i]
        for j, rchar in enumerate(right, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (lchar != rchar),
                )
            )
        previous = current
    return previous[-1]


def _digit_split(word: str) -> list[str]:
    """Split one word at letter/digit boundaries: saibo898 -> [saibo, 898]."""
    out: list[str] = []
    buffer = ""
    previous_digit: Optional[bool] = None
    for char in word:
        is_digit = char.isdigit()
        if previous_digit is not None and is_digit != previous_digit and buffer:
            out.append(buffer)
            buffer = ""
        buffer += char
        previous_digit = is_digit
    if buffer:
        out.append(buffer)
    return out


def _tokens(name: str) -> list[str]:
    """Tokens of a second-level domain, at both granularities.

    Hyphen-separated words come first and are kept whole, so a keyword that
    contains digits (saibo898) still matches as one token. The letter/digit
    splits are added as well, so a purely alphabetic keyword (saibo) can still
    match inside saibo898.
    """
    words = [word for word in name.split("-") if word]
    out = list(words)
    for word in words:
        parts = _digit_split(word)
        if len(parts) > 1:
            out.extend(parts)
    return out


@dataclass
class SimilarityBreakdown:
    """Every component that produced a similarity score, for the debug panel."""

    score: int
    match_kind: str
    second_level: str
    tld: str
    tld_score: int
    length_delta: int
    edit_distance: int
    ratio: float
    token_match: bool


# Positional base scores. Exact match on the second-level domain is the only
# route to 100.
_BASE_BY_KIND = {
    "exact": 100,
    "starts_with": 97,
    "ends_with": 92,
    "contains": 90,
    "fuzzy": 0,
}

# Used only to break ties between equally similar names, never folded into the
# similarity score itself (the TLD is scored separately by design).
_TLD_SCORE = {
    ".com": 100,
    ".net": 88,
    ".org": 84,
    ".co": 80,
    ".io": 76,
    ".ai": 72,
    ".me": 66,
    ".tech": 62,
    ".online": 58,
    ".site": 54,
    ".info": 52,
    ".xyz": 50,
}


def tld_score(domain: str) -> int:
    return _TLD_SCORE.get(tld_of(domain), 45)


def similarity_breakdown(domain: str, keyword: str) -> SimilarityBreakdown:
    """Deterministic 0-100 similarity of a domain to a keyword.

    Scored on the second-level domain only; the TLD is reported separately.
    Combines exact / prefix / suffix / contains position, edit distance,
    sequence ratio, token match and length difference. No AI involved.
    """
    keyword = str(keyword or "").strip().lower()
    name = registrable_name(domain).lower()
    squashed = name.replace("-", "")
    tld = tld_of(domain)
    tokens = _tokens(name)
    token_match = keyword in tokens
    ratio = SequenceMatcher(None, squashed, keyword).ratio()
    distance = levenshtein(squashed, keyword)
    length_delta = len(name) - len(keyword)

    if squashed == keyword:
        kind = "exact"
    elif squashed.startswith(keyword):
        kind = "starts_with"
    elif squashed.endswith(keyword):
        kind = "ends_with"
    elif keyword in squashed:
        kind = "contains"
    else:
        kind = "fuzzy"

    # Digits that the keyword itself carries are meaningful, not noise: only
    # digits ADDED beyond the keyword's own are treated as padding. Without
    # this, searching saibo898 would penalise every saibo898* candidate.
    keyword_digits = sum(ch.isdigit() for ch in keyword)
    extra_digits = max(0, sum(ch.isdigit() for ch in name) - keyword_digits)

    if kind == "exact":
        score = 100
    elif kind == "fuzzy":
        # No positional anchor. Characters MISSING from the candidate mean the
        # query's own content was dropped (saibo898 -> saibo), which is a far
        # worse match than characters added, so it is penalised much harder.
        missing = max(0, len(keyword) - len(squashed))
        extra = max(0, len(squashed) - len(keyword))
        score = (
            40
            + 50 * ratio
            - min(35, missing * 7)
            - min(20, extra)
            - min(20, distance)
        )
    else:
        # The whole keyword is present, so nothing is missing by definition.
        extra = max(0, length_delta)
        # Padding hurts, and it hurts faster past four characters.
        score = _BASE_BY_KIND[kind] - extra - max(0, extra - 4)
        score -= extra_digits * 3
        if token_match:
            # A clean word boundary means the keyword survived intact, so
            # floor the score — but the floor still decays with padding.
            score = max(score, 88 - max(0, extra - 4) * 2)

    return SimilarityBreakdown(
        score=int(max(0, min(100, round(score)))),
        match_kind=kind,
        second_level=name,
        tld=tld,
        tld_score=tld_score(domain),
        length_delta=length_delta,
        edit_distance=distance,
        ratio=round(ratio, 4),
        token_match=token_match,
    )


def similarity_score(domain: str, keyword: str) -> int:
    return similarity_breakdown(domain, keyword).score


# --- query parsing ----------------------------------------------------------

_KEYWORD_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")
_UNSAFE = ("<", ">", "{", "}", "(", ")", ";", "|", "$", "`", "&", "*", "'", '"', " ")


@dataclass(frozen=True)
class ParsedQuery:
    """What the user actually asked for, parsed once and reused everywhere.

    `keyword` is always the second-level label with every character intact —
    digits included. Nothing downstream is allowed to shorten it.
    """

    raw_query: str
    keyword: str
    second_level: str
    tld: Optional[str]
    normalized_domain: Optional[str]
    is_full_domain: bool
    exact_candidate: Optional[str]

    def to_debug(self) -> dict[str, Any]:
        return {
            "raw_query": self.raw_query,
            "normalized_domain": self.normalized_domain,
            "second_level_domain": self.second_level,
            "tld": self.tld.lstrip(".") if self.tld else None,
            "is_full_domain": self.is_full_domain,
            "exact_candidate": self.exact_candidate,
        }


def parse_query(raw: Any) -> ParsedQuery:
    """Accept a keyword, a full domain, or a URL and parse it losslessly.

    saibo898              -> keyword saibo898, no TLD
    saibo898.net          -> keyword saibo898, TLD .net, exact saibo898.net
    https://www.saibo898.net/x -> the same as above

    Raises ValueError with a human-readable reason for anything that is not
    one of those three shapes.
    """
    text = str(raw or "").strip().strip('"').strip("'")
    if not text:
        raise ValueError("Enter a keyword or domain")
    if len(text) > 253:
        raise ValueError("Search term is too long")
    if any(token in text for token in _UNSAFE):
        raise ValueError("Search term must be a plain keyword, domain, or URL")

    looks_like_domain = "." in text or "://" in text or "/" in text

    if looks_like_domain:
        # normalize_domain already strips scheme, credentials, port, path and a
        # www prefix, lowercases, and validates the result as a hostname.
        domain = normalize_domain(text)
        if not domain:
            raise ValueError("That does not look like a valid domain or URL")
        second_level = registrable_name(domain)
        if not second_level:
            raise ValueError("Could not read a domain name from that input")
        return ParsedQuery(
            raw_query=text,
            keyword=second_level,
            second_level=second_level,
            tld=tld_of(domain),
            normalized_domain=domain,
            is_full_domain=True,
            exact_candidate=domain,
        )

    keyword = text.lower()
    if len(keyword) < 2:
        raise ValueError("Keyword must be at least 2 characters")
    if len(keyword) > 63:
        raise ValueError("Keyword must be 63 characters or fewer")
    if any(char not in _KEYWORD_CHARS for char in keyword):
        raise ValueError("Keyword may contain only letters, numbers, and hyphens")
    if keyword.startswith("-") or keyword.endswith("-") or "--" in keyword:
        raise ValueError("Keyword hyphens must be used sensibly")

    return ParsedQuery(
        raw_query=text,
        keyword=keyword,
        second_level=keyword,
        tld=None,
        normalized_domain=None,
        is_full_domain=False,
        exact_candidate=None,
    )


def ordered_tlds(
    configured: Iterable[str],
    preferred: Optional[str] = None,
) -> tuple[str, ...]:
    """TLD expansion order, with an explicitly entered TLD promoted first.

    A TLD the user typed is always included even when it is not in
    DOMAIN_DISCOVERY_TLDS: they asked for it by name.
    """
    out: list[str] = []
    if preferred:
        normalized = normalize_tld(preferred)
        if normalized:
            out.append(normalized)
    for raw in configured:
        tld = normalize_tld(raw)
        if tld and tld not in out:
            out.append(tld)
    return tuple(out)


# --- generation -------------------------------------------------------------

@dataclass
class GeneratedCandidate:
    domain: str
    name: str
    kind: str
    similarity: int
    tld: str
    exact_match: bool = False


def variation_names(keyword: str) -> list[tuple[str, str]]:
    """(second-level name, variation kind) pairs for one keyword.

    Deterministic and bounded: the same keyword always produces the same list.
    """
    pairs: list[tuple[str, str]] = [(keyword, "exact")]
    for prefix in PREFIXES:
        pairs.append((f"{prefix}{keyword}", "prefix"))
    for suffix in SUFFIXES:
        pairs.append((f"{keyword}{suffix}", "suffix"))
    for suffix in HYPHEN_SUFFIXES:
        pairs.append((f"{keyword}-{suffix}", "hyphen"))
    for prefix in HYPHEN_PREFIXES:
        pairs.append((f"{prefix}-{keyword}", "hyphen"))
    for number in NUMERIC_SUFFIXES:
        pairs.append((f"{keyword}{number}", "numeric"))

    seen: set[str] = set()
    unique: list[tuple[str, str]] = []
    for name, kind in pairs:
        if name in seen:
            continue
        seen.add(name)
        unique.append((name, kind))
    return unique


def generate_candidates(
    query: "ParsedQuery | str",
    *,
    tlds: Optional[Iterable[str]] = None,
    max_generated: Optional[int] = None,
    exact_only: bool = False,
) -> list[GeneratedCandidate]:
    """Expand a query into a ranked, capped pool of candidate domains.

    The exact domain the user typed, if any, is always first and is never
    dropped by the cap. Everything else is built from the FULL second-level
    label, so saibo898 never decays into saibo.

    These are candidates only. Nothing here is a result until RDAP or WHOIS
    has confirmed the domain actually exists.
    """
    parsed = parse_query(query) if isinstance(query, str) else query
    keyword = parsed.keyword
    if not keyword:
        return []

    # An explicitly entered TLD leads the expansion order.
    source_tlds = tuple(tlds) if tlds is not None else configured_tlds()
    tld_list = ordered_tlds(source_tlds, parsed.tld)
    if not tld_list:
        tld_list = DEFAULT_TLDS
    tld_rank = {tld: index for index, tld in enumerate(tld_list)}

    cap = max_generated if max_generated is not None else limits().max_generated

    out: list[GeneratedCandidate] = []
    seen: set[str] = set()

    def add(domain: Optional[str], name: str, kind: str, exact: bool) -> None:
        if not domain or domain in seen:
            return
        seen.add(domain)
        out.append(
            GeneratedCandidate(
                domain=domain,
                name=name,
                kind=kind,
                similarity=similarity_score(domain, keyword),
                tld=tld_of(domain),
                exact_match=exact,
            )
        )

    # Candidate #1 is always the exact domain the user typed.
    exact_domain: Optional[str] = None
    if parsed.exact_candidate:
        exact_domain = parsed.exact_candidate
        add(exact_domain, parsed.second_level, "exact", True)

    names = [(keyword, "exact")] if exact_only else variation_names(keyword)
    for name, kind in names:
        for tld in tld_list:
            add(normalize_domain(f"{name}{tld}"), name, kind, False)

    # Rank before truncating so the cap always keeps the closest names, then
    # re-pin the exact candidate to the front.
    out.sort(
        key=lambda c: (
            -c.similarity,
            tld_rank.get(c.tld, len(tld_rank)),
            -tld_score(c.domain),
            len(c.domain),
            c.domain,
        )
    )
    if len(out) > cap:
        logger.info("[similar] generated pool capped at %d of %d", cap, len(out))
        kept = out[:cap]
        if exact_domain and all(c.domain != exact_domain for c in kept):
            kept = [c for c in out if c.domain == exact_domain] + kept[:-1]
        out = kept
    out.sort(key=lambda c: 0 if c.exact_match else 1)
    return out
