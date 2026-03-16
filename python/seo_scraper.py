from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import List

import json
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup
from lxml import etree


MAX_URLS = 100
REQUEST_TIMEOUT = 10


@dataclass
class SeoRow:
    url: str
    title: str
    description: str
    keywords: str
    og_title: str
    og_description: str
    og_image: str
    og_type: str
    canonical: str
    robots: str
    language: str
    jsonld: str
    domElements: int
    styleTags: int
    error: str = ""


def parse_sitemap_bytes(data: bytes, limit: int = MAX_URLS) -> List[str]:
    root = etree.fromstring(data)
    locs = root.findall(".//{*}loc")
    urls = [loc.text.strip() for loc in locs if loc.text]
    return urls[:limit]


def _extract_jsonld_types(soup: BeautifulSoup) -> str:
    types: set[str] = set()

    def collect(obj):
        if isinstance(obj, dict):
            t = obj.get("@type")
            if isinstance(t, str):
                types.add(t)
            elif isinstance(t, list):
                for v in t:
                    if isinstance(v, str):
                        types.add(v)
            for v in obj.values():
                collect(v)
        elif isinstance(obj, list):
            for item in obj:
                collect(item)

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            text = script.string or ""
            if not text.strip():
                continue
            data = json.loads(text)
            collect(data)
        except Exception:
            continue

    return ", ".join(sorted(types))


def analyze_url(url: str) -> SeoRow:
    try:
        resp = requests.get(
            url,
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "SEO-Sitemap-Analyzer/1.0"},
        )
        resp.raise_for_status()
    except Exception as exc:
        return SeoRow(
            url=url,
            title="",
            description="",
            keywords="",
            og_title="",
            og_description="",
            og_image="",
            og_type="",
            canonical="",
            robots="",
            language="",
            jsonld="",
            domElements=0,
            styleTags=0,
            error=str(exc),
        )

    # Try to use the correct encoding so non‑ASCII (e.g. Chinese) is not garbled
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding or "utf-8"

    soup = BeautifulSoup(resp.text, "lxml")

    title_tag = soup.find("title")
    title = (title_tag.string or "").strip() if title_tag and title_tag.string else ""

    # Some pages define description/keywords multiple times – usually the last one is the most specific.
    def last_meta(name: str) -> str:
        tags = soup.find_all("meta", attrs={"name": name})
        if not tags:
            return ""
        content = tags[-1].get("content") or ""
        return content.strip()

    description = last_meta("description")
    # Meta keywords (optional, many sites omit it)
    keywords = last_meta("keywords")

    # Open Graph tags
    def og(name: str) -> str:
        tags = soup.find_all("meta", attrs={"property": f"og:{name}"})
        if not tags:
          return ""
        content = tags[-1].get("content") or ""
        return content.strip()

    og_title = og("title")
    og_description = og("description")
    og_image = og("image")
    og_type = og("type")

    canonical_tag = soup.find("link", rel=lambda v: v and "canonical" in v.lower())
    canonical = (canonical_tag.get("href") or "").strip() if canonical_tag else ""

    robots_tag = soup.find("meta", attrs={"name": "robots"})
    robots = (robots_tag.get("content") or "").strip() if robots_tag else ""

    html_tag = soup.find("html")
    language = (html_tag.get("lang") or "").strip() if html_tag else ""

    jsonld = _extract_jsonld_types(soup)
    dom_elements = len(soup.find_all(True))
    style_tags = len(soup.find_all("style"))

    return SeoRow(
        url=url,
        title=title,
        description=description,
        keywords=keywords,
        og_title=og_title,
        og_description=og_description,
        og_image=og_image,
        og_type=og_type,
        canonical=canonical,
        robots=robots,
        language=language,
        jsonld=jsonld,
        domElements=dom_elements,
        styleTags=style_tags,
        error="",
    )


def analyze_sitemap_bytes(data: bytes) -> list[dict]:
    urls = parse_sitemap_bytes(data)
    rows: list[SeoRow] = []
    for url in urls:
        rows.append(analyze_url(url))
    return [asdict(r) for r in rows]


def rows_to_excel_bytes(rows: list[dict]) -> bytes:
    df = pd.DataFrame(
        rows,
        columns=[
            "url",
            "title",
            "description",
            "keywords",
            "og_title",
            "og_description",
            "og_image",
            "og_type",
            "canonical",
            "robots",
            "language",
            "jsonld",
            "domElements",
            "styleTags",
            "error",
        ],
    )
    from io import BytesIO

    buf = BytesIO()
    df.to_excel(buf, index=False)
    buf.seek(0)
    return buf.read()


def main_cli():
    import argparse

    parser = argparse.ArgumentParser(description="SEO sitemap analyzer CLI")
    parser.add_argument("sitemap", help="Path to sitemap.xml")
    parser.add_argument(
        "-o",
        "--output",
        default="seo-analysis-report.xlsx",
        help="Output Excel file",
    )
    args = parser.parse_args()

    sitemap_path = Path(args.sitemap)
    data = sitemap_path.read_bytes()
    rows = analyze_sitemap_bytes(data)
    excel_bytes = rows_to_excel_bytes(rows)
    Path(args.output).write_bytes(excel_bytes)
    print(f"Wrote {len(rows)} rows to {args.output}")


if __name__ == "__main__":
    main_cli()

