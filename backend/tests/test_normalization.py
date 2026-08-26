from __future__ import annotations

import pytest

from models import normalize_domain, registrable_name, tld_of


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("example.com", "example.com"),
        ("EXAMPLE.COM", "example.com"),
        ("  Example.Com  ", "example.com"),
        ("HTTPS://Example.COM/test", "example.com"),
        ("http://example.com", "example.com"),
        ("https://example.com/a/b?c=d#e", "example.com"),
        ("www.example.com", "example.com"),
        ("WWW.Example.COM", "example.com"),
        ("https://www.example.com/path", "example.com"),
        ("www.www.example.com", "example.com"),
        ("example.com:8080", "example.com"),
        ("example.com.", "example.com"),
        ("user@example.com", "example.com"),
        ("münchen.de", "xn--mnchen-3ya.de"),
        ("sub.example.co.uk", "sub.example.co.uk"),
        ("www.com", "www.com"),
    ],
)
def test_valid_domains_normalize(raw, expected):
    assert normalize_domain(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        None,
        "not a domain",
        "bad_domain",
        "-leading.com",
        "trailing-.com",
        "..com",
        "example",
        "1.2.3.4",
        "xn--",
        "rm -rf /",
        "/etc/passwd",
        "../../secret",
        "a.com;ls",
        "$(whoami).com",
        "a" * 300 + ".com",
        "example.c",
    ],
)
def test_invalid_input_rejected(raw):
    assert normalize_domain(raw) is None


def test_registrable_name_picks_the_brand_label():
    assert registrable_name("travelhub.com") == "travelhub"
    assert registrable_name("a.b.travel-deals.net") == "travel-deals"
    assert registrable_name("foo.co.uk") == "foo"


def test_tld_of():
    assert tld_of("example.com") == ".com"
    assert tld_of("foo.co.uk") == ".uk"
