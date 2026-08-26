"""Query parsing, digit preservation and candidate priority.

These tests exist because of a real bug: `saibo898.net` was rejected outright,
and `saibo` scored high enough against the keyword `saibo898` to become the
only surviving result. Numbers are meaningful parts of a domain name and must
never be silently dropped.
"""
from __future__ import annotations

import pytest

import keyword_discovery as kd
import similar_domains as sd


# --- normalization ----------------------------------------------------------

@pytest.mark.parametrize(
    "raw,domain,second_level,tld",
    [
        ("saibo898.net", "saibo898.net", "saibo898", ".net"),
        ("https://www.saibo898.net/test", "saibo898.net", "saibo898", ".net"),
        ("SAIBO898.NET", "saibo898.net", "saibo898", ".net"),
        ("www.saibo898.net", "saibo898.net", "saibo898", ".net"),
        ("http://saibo898.net:8080/a?b=1", "saibo898.net", "saibo898", ".net"),
        ("abc123.com", "abc123.com", "abc123", ".com"),
        ("test-88.net", "test-88.net", "test-88", ".net"),
    ],
)
def test_full_domain_is_parsed_losslessly(raw, domain, second_level, tld):
    parsed = sd.parse_query(raw)
    assert parsed.is_full_domain is True
    assert parsed.normalized_domain == domain
    assert parsed.second_level == second_level
    assert parsed.keyword == second_level
    assert parsed.tld == tld
    assert parsed.exact_candidate == domain


@pytest.mark.parametrize(
    "raw,keyword",
    [
        ("saibo898", "saibo898"),
        ("SAIBO898", "saibo898"),
        ("  saibo898  ", "saibo898"),
        ("saibo", "saibo"),
        ("test-88", "test-88"),
        ("abc123", "abc123"),
    ],
)
def test_bare_keyword_keeps_every_character(raw, keyword):
    parsed = sd.parse_query(raw)
    assert parsed.is_full_domain is False
    assert parsed.keyword == keyword
    assert parsed.tld is None
    assert parsed.exact_candidate is None


@pytest.mark.parametrize(
    "raw",
    ["", "a", "sai bo", "saibo;rm -rf /", "not..a..domain", "-saibo", "saibo-", "sa--ibo"],
)
def test_invalid_input_is_rejected(raw):
    with pytest.raises(ValueError):
        sd.parse_query(raw)


def test_digits_are_never_stripped_from_the_search_token():
    """The regression guard: no code path may shorten saibo898 to saibo."""
    for raw in ("saibo898", "saibo898.net", "https://www.saibo898.net/x"):
        assert sd.parse_query(raw).keyword == "saibo898"
        assert kd.normalize_keyword(raw) == "saibo898"


# --- similarity -------------------------------------------------------------

def test_exact_second_level_scores_100_regardless_of_tld():
    assert sd.similarity_score("saibo898.net", "saibo898") == 100
    assert sd.similarity_score("saibo898.com", "saibo898") == 100


def test_dropping_the_number_is_a_much_worse_match_than_adding_a_suffix():
    keyword = "saibo898"
    exact = sd.similarity_score("saibo898.net", keyword)
    suffixed = sd.similarity_score("saibo898-us.com", keyword)
    prefixed = sd.similarity_score("mysaibo898.com", keyword)
    truncated = sd.similarity_score("saibo89.com", keyword)
    number_dropped = sd.similarity_score("saibo.com", keyword)

    assert exact == 100
    assert suffixed >= 85
    assert prefixed >= 85
    # Losing one digit is worse than a clean affix...
    assert truncated < suffixed
    # ...and losing the whole number is worse again, below the intake floor so
    # it cannot quietly become the answer to a saibo898 search.
    assert number_dropped < truncated
    assert number_dropped < kd.MIN_SIMILARITY


def test_saibo_and_saibo898_are_not_treated_as_identical():
    assert sd.similarity_score("saibo.com", "saibo898") != 100
    assert sd.similarity_score("saibo898.com", "saibo") != 100


def test_keyword_digits_are_not_penalised_as_padding():
    """saibo898-us must not be docked for the digits the keyword itself has."""
    with_digits = sd.similarity_score("saibo898-us.com", "saibo898")
    without = sd.similarity_score("saibo-us.com", "saibo")
    assert with_digits == without


def test_alphabetic_keyword_scoring_is_unchanged():
    assert sd.similarity_score("saibo.com", "saibo") == 100
    assert sd.similarity_score("saibo-us.com", "saibo") == 94
    assert sd.similarity_score("saibogroup.com", "saibo") == 91
    assert sd.similarity_score("mysaibo.com", "saibo") == 90


def test_tld_is_scored_separately_from_the_name():
    """Same name, different TLD: identical similarity, different TLD score."""
    com = sd.similarity_breakdown("saibo898.com", "saibo898")
    xyz = sd.similarity_breakdown("saibo898.xyz", "saibo898")
    assert com.score == xyz.score == 100
    assert com.tld_score > xyz.tld_score


# --- tokenization -----------------------------------------------------------

@pytest.mark.parametrize(
    "name,expected_subset",
    [
        ("saibo898", {"saibo898", "saibo", "898"}),
        ("saibo898-us", {"saibo898", "us"}),
        ("test-88", {"test", "88"}),
        ("abc123", {"abc123", "abc", "123"}),
    ],
)
def test_tokens_keep_the_whole_word_and_the_digit_split(name, expected_subset):
    assert expected_subset.issubset(set(sd._tokens(name)))


# --- candidate generation ---------------------------------------------------

def test_exact_domain_is_always_candidate_number_one():
    parsed = sd.parse_query("saibo898.net")
    pool = sd.generate_candidates(parsed, tlds=(".com", ".net", ".org"))
    assert pool[0].domain == "saibo898.net"
    assert pool[0].exact_match is True
    assert pool[0].similarity == 100


def test_entered_tld_leads_the_expansion_order():
    parsed = sd.parse_query("saibo898.net")
    pool = sd.generate_candidates(parsed, tlds=(".com", ".net", ".org"))
    top = [c.domain for c in pool if c.similarity == 100]
    assert top[0] == "saibo898.net"


def test_generated_candidates_are_built_on_the_full_keyword():
    parsed = sd.parse_query("saibo898.net")
    domains = {c.domain for c in sd.generate_candidates(parsed)}
    for expected in (
        "saibo898.net",
        "saibo898.com",
        "saibo898.org",
        "saibo898-us.com",
        "mysaibo898.com",
        "getsaibo898.com",
        "saibo898group.com",
    ):
        assert expected in domains, expected


def test_generation_never_substitutes_the_shortened_keyword():
    """No saibo.* may appear in a saibo898 expansion."""
    for raw in ("saibo898.net", "saibo898"):
        pool = sd.generate_candidates(sd.parse_query(raw))
        assert not any(c.name == "saibo" for c in pool)
        assert "saibo.com" not in {c.domain for c in pool}
        assert "saibo.net" not in {c.domain for c in pool}
        assert all("saibo898" in c.name for c in pool)


def test_bare_keyword_generation_keeps_the_number():
    domains = {c.domain for c in sd.generate_candidates(sd.parse_query("saibo898"))}
    for expected in ("saibo898.com", "saibo898.net", "saibo898.org", "saibo898.co"):
        assert expected in domains


def test_cap_never_discards_the_exact_candidate():
    parsed = sd.parse_query("saibo898.net")
    pool = sd.generate_candidates(parsed, tlds=(".com", ".net"), max_generated=3)
    assert len(pool) == 3
    assert pool[0].domain == "saibo898.net"


def test_exact_only_generation_yields_just_the_name_across_tlds():
    parsed = sd.parse_query("saibo898.net")
    pool = sd.generate_candidates(parsed, tlds=(".com", ".net"), exact_only=True)
    assert {c.domain for c in pool} == {"saibo898.net", "saibo898.com"}


# --- request wiring ---------------------------------------------------------

def test_request_carries_the_parsed_query():
    request = kd.SimilarDomainRequest.from_payload({"keyword": "saibo898.net"})
    assert request.keyword == "saibo898"
    assert request.exact_candidate == "saibo898.net"
    assert request.entered_tld == ".net"
    assert request.tld_list()[0] == ".net"
    assert request.raw_query == "saibo898.net"


def test_request_accepts_a_url():
    request = kd.SimilarDomainRequest.from_payload(
        {"keyword": "https://www.saibo898.net/test"}
    )
    assert request.keyword == "saibo898"
    assert request.exact_candidate == "saibo898.net"


def test_explicit_tld_filter_still_wins_over_the_entered_tld():
    request = kd.SimilarDomainRequest.from_payload(
        {"keyword": "saibo898.net", "tld": ".com"}
    )
    assert request.tld_list() == (".com",)


def test_full_domain_and_bare_keyword_do_not_share_a_cache_entry():
    a = kd.SimilarDomainRequest.from_payload({"keyword": "saibo898.net"})
    b = kd.SimilarDomainRequest.from_payload({"keyword": "saibo898"})
    assert kd._cache_key(a.to_payload()) != kd._cache_key(b.to_payload())


# --- match levels -----------------------------------------------------------

def test_match_levels_separate_exact_strict_and_broader():
    keyword = "saibo898"
    exact = "saibo898.net"
    assert kd.match_level_of(exact, keyword, 100, exact) == "exact"
    assert kd.match_level_of("saibo898.com", keyword, 100, exact) == "strict"
    assert kd.match_level_of("saibo898-us.com", keyword, 94, exact) == "strict"
    # Fuzzy means characters went missing, so it is Broader whatever it scores.
    assert kd.match_level_of("saibo89.com", keyword, 79, exact) == "broader"


def test_a_fuzzy_match_is_broader_even_with_a_high_score():
    assert kd.match_level_of("saibo89.com", "saibo898", 99, None) == "broader"


def test_entered_tld_makes_only_that_domain_exact():
    """saibo898.net entered: .net is exact, .com is strict, not exact."""
    assert kd.match_level_of("saibo898.net", "saibo898", 100, "saibo898.net") == "exact"
    assert kd.match_level_of("saibo898.com", "saibo898", 100, "saibo898.net") == "strict"


def test_bare_keyword_treats_any_exact_name_as_exact():
    """No TLD entered, so every TLD carrying the exact name is an exact hit."""
    assert kd.match_level_of("saibo898.net", "saibo898", 100, None) == "exact"
    assert kd.match_level_of("saibo898.com", "saibo898", 100, None) == "exact"
    assert kd.match_level_of("saibo898-us.com", "saibo898", 94, None) == "strict"


def test_broader_can_never_outrank_a_strict_match():
    assert kd.MATCH_LEVEL_RANK["exact"] < kd.MATCH_LEVEL_RANK["strict"]
    assert kd.MATCH_LEVEL_RANK["strict"] < kd.MATCH_LEVEL_RANK["broader"]


# --- debug contract ---------------------------------------------------------

def test_debug_payload_reports_the_unshortened_second_level():
    debug = sd.parse_query("saibo898.net").to_debug()
    assert debug["raw_query"] == "saibo898.net"
    assert debug["normalized_domain"] == "saibo898.net"
    assert debug["second_level_domain"] == "saibo898"
    assert debug["tld"] == "net"
    assert debug["exact_candidate"] == "saibo898.net"
    assert debug["second_level_domain"] != "saibo"
