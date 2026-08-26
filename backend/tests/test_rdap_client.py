from __future__ import annotations

import pytest

from rdap_client import RdapClient, RdapError, parse_rdap_payload

# Trimmed shape of a real RDAP domain object.
PAYLOAD = {
    "objectClassName": "domain",
    "ldhName": "example.com",
    "status": ["client transfer prohibited", "redemption period"],
    "events": [
        {"eventAction": "registration", "eventDate": "1995-08-14T04:00:00Z"},
        {"eventAction": "expiration", "eventDate": "2027-08-13T04:00:00Z"},
        {"eventAction": "last changed", "eventDate": "2026-01-01T00:00:00Z"},
    ],
    "entities": [
        {
            "roles": ["registrar"],
            "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Test Registrar, Inc."]]],
        }
    ],
    "nameservers": [{"ldhName": "NS1.EXAMPLE.COM"}, {"ldhName": "ns2.example.com"}],
}


def test_parse_extracts_the_fields_we_rely_on():
    result = parse_rdap_payload("example.com", PAYLOAD, "https://rdap.test/com")

    assert result.expiration_date == "2027-08-13"
    assert result.registration_date == "1995-08-14"
    assert result.registrar == "Test Registrar, Inc."
    assert result.nameservers == ["ns1.example.com", "ns2.example.com"]
    assert "redemption period" in result.registry_status
    assert result.rdap_source == "https://rdap.test/com"


def test_parse_leaves_absent_fields_as_none():
    result = parse_rdap_payload("bare.com", {"objectClassName": "domain"}, "https://rdap.test")

    assert result.expiration_date is None
    assert result.registration_date is None
    assert result.registrar is None
    assert result.nameservers == []


def test_bootstrap_maps_tld_to_rdap_server(monkeypatch):
    """Per-TLD resolution, not one hardcoded endpoint."""
    client = RdapClient()
    monkeypatch.setattr(
        client,
        "_load_bootstrap",
        lambda: {
            "com": "https://rdap.verisign.example/com/v1",
            "uk": "https://rdap.nominet.example/uk",
            "co.uk": "https://rdap.nominet.example/couk",
        },
    )

    assert client.base_url_for("example.com") == "https://rdap.verisign.example/com/v1"
    assert client.base_url_for("thing.uk") == "https://rdap.nominet.example/uk"
    # Longest suffix wins, so a second-level ccTLD is not mis-resolved.
    assert client.base_url_for("thing.co.uk") == "https://rdap.nominet.example/couk"
    assert client.base_url_for("thing.invalidtld") is None


def test_bootstrap_is_cached(monkeypatch):
    calls = {"n": 0}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            calls["n"] += 1
            return {"services": [[["com"], ["https://rdap.test/com"]]]}

        @staticmethod
        def raise_for_status():
            return None

    client = RdapClient()
    monkeypatch.setattr(client._session, "get", lambda *a, **k: _Resp())

    assert client.base_url_for("a.com") == "https://rdap.test/com"
    assert client.base_url_for("b.com") == "https://rdap.test/com"
    assert calls["n"] == 1, "bootstrap should be fetched once and cached"


def test_unsupported_tld_raises_rather_than_guessing(monkeypatch):
    client = RdapClient()
    monkeypatch.setattr(client, "_load_bootstrap", lambda: {"com": "https://rdap.test/com"})

    with pytest.raises(RdapError) as caught:
        client.lookup("thing.nosuchtld")
    assert caught.value.kind == "unsupported_tld"


def test_not_found_is_distinct_from_failure(monkeypatch):
    class _Resp:
        status_code = 404
        headers: dict = {}

    client = RdapClient()
    monkeypatch.setattr(client, "_load_bootstrap", lambda: {"com": "https://rdap.test/com"})
    monkeypatch.setattr(client._session, "get", lambda *a, **k: _Resp())

    with pytest.raises(RdapError) as caught:
        client.lookup("missing.com")
    assert caught.value.kind == "not_found"


def test_retries_then_gives_up_without_raising_transport_errors(monkeypatch):
    attempts = {"n": 0}

    class _Resp:
        status_code = 503
        headers: dict = {}

    client = RdapClient(max_retries=3)
    monkeypatch.setattr(client, "_load_bootstrap", lambda: {"com": "https://rdap.test/com"})
    monkeypatch.setattr("net.sleep_backoff", lambda *a, **k: None)
    monkeypatch.setattr("rdap_client.time.sleep", lambda *a, **k: None)

    def _get(*args, **kwargs):
        attempts["n"] += 1
        return _Resp()

    monkeypatch.setattr(client._session, "get", _get)

    with pytest.raises(RdapError) as caught:
        client.lookup("flaky.com")
    assert caught.value.kind == "lookup_failed"
    assert attempts["n"] == 3
