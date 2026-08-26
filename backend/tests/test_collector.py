from __future__ import annotations

import gzip

import domain_sources
import source_config
from source_adapters import ZoneFileSource, _BaseSource


class _StubSource(_BaseSource):
    kind = "manual"
    name = "stub"
    label = "Stub"

    def __init__(self, settings, domains, fail=False):
        super().__init__(settings)
        self._domains = domains
        self._fail = fail

    def is_configured(self):
        return True

    def describe(self):
        return "stub source"

    def fetch_domains(self):
        if self._fail:
            raise RuntimeError("source exploded")
        return list(self._domains)


def _settings(**overrides):
    settings = source_config.load_settings()
    for key, value in overrides.items():
        setattr(settings, key, value)
    return settings


def test_deduplicates_variants_into_one_candidate():
    settings = _settings()
    source = _StubSource(
        settings,
        [
            "example.com",
            "EXAMPLE.COM",
            "https://example.com/path",
            "www.example.com",
            "  Example.Com  ",
            "other.net",
        ],
    )

    result = domain_sources.collect([source], settings)

    assert result.domains == ["example.com", "other.net"]
    assert result.discovered == 6
    assert result.valid == 6
    assert result.duplicates == 4
    assert result.unique == 2


def test_invalid_entries_are_counted_not_stored():
    settings = _settings()
    source = _StubSource(settings, ["good.com", "rm -rf /", "/etc/passwd", "bad_domain"])

    result = domain_sources.collect([source], settings)

    assert result.domains == ["good.com"]
    assert result.invalid == 3


def test_candidate_cap_truncates():
    settings = _settings(max_candidates=2)
    source = _StubSource(settings, ["a.com", "b.com", "c.com", "d.com"])

    result = domain_sources.collect([source], settings)

    assert result.unique == 2
    assert result.truncated is True


def test_failing_source_does_not_stop_the_others():
    settings = _settings()
    broken = _StubSource(settings, [], fail=True)
    broken.name = "broken"
    working = _StubSource(settings, ["survivor.com"])

    result = domain_sources.collect([broken, working], settings)

    statuses = {report.name: report.status for report in result.reports}
    assert statuses["broken"] == "Failed"
    assert result.domains == ["survivor.com"]


def test_origin_is_recorded_per_domain():
    settings = _settings()
    first = _StubSource(settings, ["shared.com", "only-first.com"])
    first.name = "first"
    second = _StubSource(settings, ["shared.com", "only-second.com"])
    second.name = "second"

    result = domain_sources.collect([first, second], settings)

    # First source to yield a domain owns it; the duplicate is collapsed.
    assert result.origins["shared.com"] == "first"
    assert result.origins["only-second.com"] == "second"
    assert result.unique == 3


def test_unconfigured_source_reports_and_yields_nothing():
    settings = _settings()
    sources, settings = domain_sources.build_sources(settings)

    result = domain_sources.collect(sources, settings)

    assert result.unique == 0
    assert result.any_source_configured is False


def test_zone_source_parses_zone_txt_csv_and_gz(tmp_path):
    zone_dir = tmp_path / "zones"
    zone_dir.mkdir()
    (zone_dir / "a.zone").write_text(
        "; comment\n"
        "$TTL 86400\n"
        "alpha.com.\t172800\tIN\tNS\tns1.host.net.\n"
        "alpha.com.\t172800\tIN\tNS\tns2.host.net.\n"
        "WWW.Beta.ORG.\t172800\tIN\tNS\tns1.host.net.\n"
    )
    (zone_dir / "b.txt").write_text("gamma.net\ngamma.net\n")
    (zone_dir / "c.csv").write_text("domain,registrar\ndelta.io,Foo\n")
    with gzip.open(zone_dir / "d.txt.gz", "wt") as handle:
        handle.write("epsilon.dev\n")

    settings = _settings(zone_directory=zone_dir)
    source = ZoneFileSource(settings)

    assert source.is_configured() is True
    result = domain_sources.collect([source], settings)

    assert sorted(result.domains) == [
        "alpha.com",
        "beta.org",
        "delta.io",
        "epsilon.dev",
        "gamma.net",
    ]


def test_zone_source_unconfigured_says_so():
    settings = _settings(zone_directory=None)
    source = ZoneFileSource(settings)

    assert source.is_configured() is False
    assert "not configured" in source.describe().lower()
