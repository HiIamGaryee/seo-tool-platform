from __future__ import annotations

import domain_monitor
import domain_sources
import source_config
import storage
from rdap_client import RdapError, RdapResult
from source_adapters import _BaseSource


class _FakeRdap:
    """Deterministic stand-in for the RDAP client, keyed by domain."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def lookup(self, domain):
        self.calls.append(domain)
        answer = self.answers.get(domain)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            raise RdapError("not_found", "no such domain")
        return answer

    def close(self):
        return None


class _ListSource(_BaseSource):
    kind = "manual"
    name = "fixture"
    label = "Fixture"

    def __init__(self, settings, domains):
        super().__init__(settings)
        self._domains = domains

    def is_configured(self):
        return True

    def describe(self):
        return "test fixture"

    def fetch_domains(self):
        return list(self._domains)


def _result(domain, expiry, statuses=("active",)):
    return RdapResult(
        domain=domain,
        expiration_date=expiry,
        registration_date="2015-01-01",
        registry_status=list(statuses),
        registrar="Test Registrar",
        nameservers=["ns1.test"],
        rdap_source="https://rdap.test",
    )


def test_scan_runs_end_to_end_without_network(monkeypatch):
    settings = source_config.load_settings()
    fake = _FakeRdap(
        {
            "keep.com": _result("keep.com", "2099-01-01"),
            "soon.com": _result("soon.com", "2026-09-01"),
            "dead.com": _result("dead.com", "2020-01-01"),
            "hold.com": _result("hold.com", "2027-01-01", ["redemptionPeriod"]),
        }
    )
    monkeypatch.setattr(domain_monitor, "RdapClient", lambda **kwargs: fake)
    monkeypatch.setattr(
        domain_sources,
        "build_sources",
        lambda s=None, kinds=None: (
            [
                _ListSource(
                    settings,
                    ["keep.com", "www.keep.com", "soon.com", "dead.com", "hold.com", "junk!!"],
                )
            ],
            settings,
        ),
    )

    state = domain_monitor.ScanState()
    result = domain_monitor.run_scan(state=state, force=True)

    assert result["status"] == "completed"
    assert result["discovered"] == 6
    assert result["unique"] == 4, "www variant and invalid entry must not become candidates"
    assert result["duplicates"] == 1
    assert result["invalid"] == 1
    # One lookup per unique candidate, never per raw line.
    assert sorted(fake.calls) == ["dead.com", "hold.com", "keep.com", "soon.com"]

    rows = {r["domain"]: r for r in storage.list_domains(limit=50)["items"]}
    assert rows["dead.com"]["category"] == "Expired"
    assert rows["hold.com"]["category"] == "Redemption"
    assert rows["keep.com"]["category"] == "Safe"
    # Expired never implies registrable.
    assert rows["dead.com"]["available"] is None


def test_one_rdap_failure_does_not_stop_the_batch(monkeypatch):
    settings = source_config.load_settings()
    fake = _FakeRdap(
        {
            "ok-one.com": _result("ok-one.com", "2099-01-01"),
            "broken.com": RdapError("lookup_failed", "registry timeout"),
            "ok-two.com": _result("ok-two.com", "2099-01-01"),
        }
    )
    monkeypatch.setattr(domain_monitor, "RdapClient", lambda **kwargs: fake)
    monkeypatch.setattr(
        domain_sources,
        "build_sources",
        lambda s=None, kinds=None: (
            [_ListSource(settings, ["ok-one.com", "broken.com", "ok-two.com"])],
            settings,
        ),
    )

    state = domain_monitor.ScanState()
    result = domain_monitor.run_scan(state=state, force=True)

    assert result["status"] == "completed"
    assert result["checked"] == 3
    assert result["failed"] == 1

    row = storage.get_domain("broken.com")
    assert row["lookup_status"] == "lookup_failed"
    assert row["category"] == "Unknown"
    assert row["seo_score"] is None


def test_cache_ttl_skips_recently_checked_domains(monkeypatch):
    settings = source_config.load_settings()
    fake = _FakeRdap({"cached.com": _result("cached.com", "2099-01-01")})
    monkeypatch.setattr(domain_monitor, "RdapClient", lambda **kwargs: fake)
    monkeypatch.setattr(
        domain_sources,
        "build_sources",
        lambda s=None, kinds=None: ([_ListSource(settings, ["cached.com"])], settings),
    )

    domain_monitor.run_scan(state=domain_monitor.ScanState(), force=True)
    assert len(fake.calls) == 1

    second = domain_monitor.run_scan(state=domain_monitor.ScanState())
    assert len(fake.calls) == 1, "a domain inside the TTL must not be looked up again"
    assert second["total"] == 0
    assert second["skipped_cached"] == 1


def test_source_attribution_survives_multiple_sources(monkeypatch):
    settings = source_config.load_settings()
    first = _ListSource(settings, ["shared.com"])
    first.name = "alpha"
    second = _ListSource(settings, ["shared.com"])
    second.name = "beta"

    result = domain_sources.collect([first, second], settings)
    storage.add_candidates(result.domains, "discovery")
    storage.link_sources(result.origins, {"alpha": "manual"})
    storage.link_sources({"shared.com": "beta"}, {"beta": "zone"})

    links = storage.sources_for_domain("shared.com")
    assert {link["source_name"] for link in links} == {"alpha", "beta"}
    # One candidate row, two provenance rows.
    assert storage.list_domains(search="shared.com")["total"] == 1


def test_scan_reports_when_nothing_is_configured(monkeypatch):
    settings = source_config.load_settings()
    monkeypatch.setattr(domain_monitor, "RdapClient", lambda **kwargs: _FakeRdap({}))
    monkeypatch.setattr(
        domain_sources, "build_sources", lambda s=None, kinds=None: ([], settings)
    )

    state = domain_monitor.ScanState()
    result = domain_monitor.run_scan(state=state)

    assert result["no_sources_configured"] is True
    assert result["unique"] == 0


def test_enrichment_skips_safe_domains(monkeypatch):
    storage.add_candidates(["safe.com", "expiring.com"], "test")
    storage.save_enrichment("safe.com", {"last_rdap_checked": storage.now_iso()})
    with storage.connect() as conn:
        conn.execute("UPDATE domains SET category='Safe' WHERE domain='safe.com'")
        conn.execute(
            "UPDATE domains SET category='Expiring <=30 Days' WHERE domain='expiring.com'"
        )

    gated = storage.domains_needing_enrichment_scoped(0, 0)
    names = {row["domain"] for row in gated}

    assert "expiring.com" in names
    assert "safe.com" not in names, "Safe domains must not consume SEO API budget"

    everything = storage.domains_needing_enrichment_scoped(0, 0, categories=())
    assert {"safe.com", "expiring.com"} <= {row["domain"] for row in everything}


def test_manual_import_parses_and_dedupes(monkeypatch, tmp_path):
    """Manual import stays a first-class source and shares the collector's parser."""
    import domain_monitor

    result = domain_monitor.import_domains(
        "iana.org\n"
        "www.iana.org\n"
        "https://IANA.org/about\n"
        "nic.uk,Nominet\n"
        "rm -rf /\n"
        "# a comment\n",
        source="test-upload",
    )

    assert result["imported"] == 2, "three iana variants collapse to one candidate"
    assert result["duplicates"] == 2
    assert result["invalid"] == 1

    stored = {row["domain"] for row in storage.list_domains(limit=20)["items"]}
    assert stored == {"iana.org", "nic.uk"}


def test_manual_import_mirrors_into_the_manual_source_file(monkeypatch, tmp_path):
    """Imports must be re-readable by ManualFileSource for scheduled scans."""
    import domain_monitor
    from source_adapters import ManualFileSource

    domain_monitor.import_domains("mirrored.com\n", source="test-upload")

    settings = source_config.load_settings()
    source = ManualFileSource(settings)

    assert source.is_configured() is True
    assert "mirrored.com" in list(source.fetch_domains())
