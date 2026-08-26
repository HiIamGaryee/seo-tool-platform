from __future__ import annotations

import crawl4ai_source
import source_adapters
import source_config
import storage


def test_extract_domains_from_html_filters_invalid_hosts():
    html = """
    <html>
      <body>
        <a href="https://WINNER.com/path">Winner</a>
        <a href="mailto:test@example.com">Email</a>
        <a href="javascript:void(0)">JS</a>
        <div>bestwin.net and winnerhub.org</div>
        <div>cdn.example.com/image.png localhost 127.0.0.1</div>
      </body>
    </html>
    """
    domains = crawl4ai_source.extract_domains_from_html(html, page_url="https://source.example")
    assert "winner.com" in domains
    assert "bestwin.net" in domains
    assert "winnerhub.org" in domains
    assert "localhost" not in domains


def test_source_status_rows_unconfigured():
    rows = crawl4ai_source.source_status_rows()
    assert rows == [
        {
            "kind": "crawl4ai",
            "name": "crawl4ai",
            "label": "Crawl4AI",
            "status": "Not Configured",
            "enabled": True,
            "configured": False,
            "detail": "Crawl4AI installed. No crawler sources configured.",
            "candidates": None,
            "last_sync": None,
        }
    ]


def test_crawl_source_disabled():
    source = crawl4ai_source.CrawlSourceConfig(
        id="alpha",
        name="Alpha",
        url="https://example.com",
        enabled=False,
        max_pages=1,
    )
    result = crawl4ai_source.crawl_source(source)
    assert result.status == "disabled"
    assert result.domains == []


def test_crawl_adapter_uses_mocked_crawl(monkeypatch):
    source = crawl4ai_source.save_source_config(
        {"name": "Feed A", "url": "https://example.com/feed", "enabled": True, "max_pages": 2}
    )

    def fake_crawl(config, force=False):
        assert config.id == source.id
        return crawl4ai_source.CrawlSourceResult(
            source_id=config.id,
            source_name=config.name,
            source_url=config.url,
            status="active",
            pages_crawled=1,
            domains=["winner.com", "bestwin.net"],
            sample=["winner.com"],
            crawled_at=storage.now_iso(),
            expires_at=storage.now_iso(),
        )

    monkeypatch.setattr(crawl4ai_source, "crawl_source", fake_crawl)
    settings = source_config.load_settings()
    adapters = source_adapters.build_adapters(source_config.KIND_CRAWL4AI, settings)
    assert len(adapters) == 1
    assert list(adapters[0].fetch_domains()) == ["winner.com", "bestwin.net"]
