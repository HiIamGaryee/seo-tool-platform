from __future__ import annotations

import logging
import time
import traceback
from dataclasses import asdict, dataclass
from typing import List

import json
from pathlib import Path

import pandas as pd
import requests
from bs4 import BeautifulSoup
from lxml import etree

# Configure logging
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

MAX_URLS = 100
REQUEST_TIMEOUT = 30  # Increased timeout to 30 seconds

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
    og_url: str
    canonical: str
    robots: str
    language: str
    jsonld: str
    domElements: int
    styleTags: int
    error: str = ""


def parse_sitemap_bytes(data: bytes, limit: int = MAX_URLS) -> List[str]:
    """Parse sitemap XML and extract URLs with detailed logging"""
    logger.info(f"Parsing sitemap, data size: {len(data)} bytes, limit: {limit}")
    
    try:
        # Try to decode to check encoding
        decoded = data.decode('utf-8', errors='ignore')[:500]
        logger.debug(f"Sitemap preview: {decoded}")
        
        root = etree.fromstring(data)
        logger.info(f"Successfully parsed XML root element: {root.tag}")
        
        # Try different namespace patterns
        locs = root.findall(".//{*}loc")
        logger.info(f"Found {len(locs)} <loc> elements in sitemap")
        
        urls = []
        for i, loc in enumerate(locs):
            if loc.text:
                url = loc.text.strip()
                urls.append(url)
                if i < 5:  # Log first 5 URLs
                    logger.debug(f"URL {i+1}: {url}")
        
        result = urls[:limit]
        logger.info(f"Returning {len(result)} URLs (limited from {len(urls)} total)")
        return result
        
    except etree.XMLSyntaxError as e:
        logger.error(f"XML syntax error parsing sitemap: {str(e)}")
        logger.error(f"First 1000 chars of data: {data[:1000]}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error parsing sitemap: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise


def _extract_jsonld_types(soup: BeautifulSoup) -> str:
    """Extract JSON-LD types with error handling"""
    types: set[str] = set()
    scripts_found = 0
    scripts_parsed = 0

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
        scripts_found += 1
        try:
            text = script.string or ""
            if not text.strip():
                continue
            data = json.loads(text)
            collect(data)
            scripts_parsed += 1
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse JSON-LD: {str(e)}")
        except Exception as e:
            logger.warning(f"Unexpected error parsing JSON-LD: {str(e)}")

    if scripts_found > 0:
        logger.debug(f"Found {scripts_found} JSON-LD scripts, successfully parsed {scripts_parsed}")
    
    result = ", ".join(sorted(types))
    if result:
        logger.debug(f"JSON-LD types found: {result}")
    
    return result


def analyze_url(url: str) -> SeoRow:
    """Analyze a single URL with comprehensive logging"""
    logger.info(f"Starting analysis of URL: {url}")
    start_time = time.time()
    
    try:
        # Fetch the page
        logger.debug(f"Sending GET request to {url} with timeout={REQUEST_TIMEOUT}s")
        resp = requests.get(
            url,
            timeout=REQUEST_TIMEOUT,
            headers={
                "User-Agent": "SEO-Sitemap-Analyzer/1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Accept-Encoding": "gzip, deflate",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1"
            },
            allow_redirects=True,
            verify=False  # Skip SSL verification for problematic certificates
        )
        
        fetch_time = time.time() - start_time
        logger.info(f"Fetched {url} in {fetch_time:.2f}s, status: {resp.status_code}, size: {len(resp.content)} bytes")
        
        resp.raise_for_status()
        
    except requests.Timeout:
        error_msg = f"Timeout after {REQUEST_TIMEOUT}s"
        logger.error(f"Timeout fetching {url}: {error_msg}")
        return SeoRow(
            url=url, title="", description="", keywords="", og_title="",
            og_description="", og_image="", og_type="", og_url="",
            canonical="", robots="", language="", jsonld="",
            domElements=0, styleTags=0, error=error_msg
        )
    except requests.RequestException as exc:
        error_msg = f"Request error: {str(exc)}"
        logger.error(f"Error fetching {url}: {error_msg}")
        return SeoRow(
            url=url, title="", description="", keywords="", og_title="",
            og_description="", og_image="", og_type="", og_url="",
            canonical="", robots="", language="", jsonld="",
            domElements=0, styleTags=0, error=error_msg
        )
    except Exception as exc:
        error_msg = f"Unexpected error: {str(exc)}"
        logger.error(f"Unexpected error fetching {url}: {error_msg}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return SeoRow(
            url=url, title="", description="", keywords="", og_title="",
            og_description="", og_image="", og_type="", og_url="",
            canonical="", robots="", language="", jsonld="",
            domElements=0, styleTags=0, error=error_msg
        )

    # Parse HTML
    try:
        # Fix encoding
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding or "utf-8"
        
        logger.debug(f"Parsing HTML for {url}, encoding: {resp.encoding}")
        parse_start = time.time()
        soup = BeautifulSoup(resp.text, "lxml")
        parse_time = time.time() - parse_start
        logger.debug(f"HTML parsed in {parse_time:.2f}s")

        # Extract title
        title_tag = soup.find("title")
        title = (title_tag.string or "").strip() if title_tag and title_tag.string else ""
        logger.debug(f"Title: {title[:100]}")

        # Extract meta tags
        def last_meta(name: str) -> str:
            tags = soup.find_all("meta", attrs={"name": name})
            if not tags:
                return ""
            content = tags[-1].get("content") or ""
            return content.strip()

        description = last_meta("description")
        keywords = last_meta("keywords")
        logger.debug(f"Description: {description[:100]}")

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
        og_url = og("url")
        
        if og_title or og_description:
            logger.debug(f"Found Open Graph data for {url}")

        # Canonical URL
        canonical_tag = soup.find("link", rel=lambda v: v and "canonical" in v.lower())
        canonical = (canonical_tag.get("href") or "").strip() if canonical_tag else ""

        # Robots meta
        robots_tag = soup.find("meta", attrs={"name": "robots"})
        robots = (robots_tag.get("content") or "").strip() if robots_tag else ""

        # Language
        html_tag = soup.find("html")
        language = (html_tag.get("lang") or "").strip() if html_tag else ""

        # JSON-LD
        jsonld = _extract_jsonld_types(soup)
        
        # DOM stats
        dom_elements = len(soup.find_all(True))
        style_tags = len(soup.find_all("style"))
        
        logger.debug(f"DOM elements: {dom_elements}, Style tags: {style_tags}")

        total_time = time.time() - start_time
        logger.info(f"Successfully analyzed {url} in {total_time:.2f}s")

        return SeoRow(
            url=url,
            title=title,
            description=description,
            keywords=keywords,
            og_title=og_title,
            og_description=og_description,
            og_image=og_image,
            og_type=og_type,
            og_url=og_url,
            canonical=canonical,
            robots=robots,
            language=language,
            jsonld=jsonld,
            domElements=dom_elements,
            styleTags=style_tags,
            error="",
        )
        
    except Exception as e:
        error_msg = f"Error parsing HTML: {str(e)}"
        logger.error(f"Error parsing HTML for {url}: {error_msg}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return SeoRow(
            url=url, title="", description="", keywords="", og_title="",
            og_description="", og_image="", og_type="", og_url="",
            canonical="", robots="", language="", jsonld="",
            domElements=0, styleTags=0, error=error_msg
        )


def analyze_sitemap_bytes(data: bytes) -> list[dict]:
    """Main entry point for sitemap analysis with comprehensive logging"""
    logger.info("=" * 60)
    logger.info("Starting sitemap analysis")
    logger.info(f"Data size: {len(data)} bytes")
    
    start_time = time.time()
    
    try:
        # Parse URLs from sitemap
        urls = parse_sitemap_bytes(data)
        logger.info(f"Found {len(urls)} URLs to analyze")
        
        # Analyze each URL
        rows: list[SeoRow] = []
        success_count = 0
        error_count = 0
        
        for i, url in enumerate(urls, 1):
            logger.info(f"Analyzing URL {i}/{len(urls)}: {url}")
            row = analyze_url(url)
            rows.append(row)
            
            if row.error:
                error_count += 1
                logger.warning(f"URL {i} had error: {row.error}")
            else:
                success_count += 1
            
            # Log progress every 10 URLs
            if i % 10 == 0:
                elapsed = time.time() - start_time
                avg_time = elapsed / i
                remaining = (len(urls) - i) * avg_time
                logger.info(f"Progress: {i}/{len(urls)} URLs analyzed in {elapsed:.1f}s, ~{remaining:.1f}s remaining")
        
        total_time = time.time() - start_time
        logger.info("=" * 60)
        logger.info(f"Sitemap analysis completed in {total_time:.2f}s")
        logger.info(f"Total URLs: {len(urls)}, Success: {success_count}, Errors: {error_count}")
        logger.info("=" * 60)
        
        return [asdict(r) for r in rows]
        
    except Exception as e:
        logger.error(f"Fatal error during sitemap analysis: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise


def rows_to_excel_bytes(rows: list[dict]) -> bytes:
    """Convert rows to Excel with logging"""
    logger.info(f"Converting {len(rows)} rows to Excel format")
    
    try:
        df = pd.DataFrame(
            rows,
            columns=[
                "url", "title", "description", "keywords",
                "og_title", "og_description", "og_image", "og_type", "og_url",
                "canonical", "robots", "language", "jsonld",
                "domElements", "styleTags", "error",
            ],
        )
        
        from io import BytesIO
        buf = BytesIO()
        df.to_excel(buf, index=False)
        buf.seek(0)
        result = buf.read()
        
        logger.info(f"Excel file created, size: {len(result)} bytes")
        return result
        
    except Exception as e:
        logger.error(f"Error creating Excel file: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise


def main_cli():
    import argparse

    # Setup console logging for CLI
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    parser = argparse.ArgumentParser(description="SEO sitemap analyzer CLI")
    parser.add_argument("sitemap", help="Path to sitemap.xml")
    parser.add_argument(
        "-o", "--output",
        default="seo-analysis-report.xlsx",
        help="Output Excel file",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging"
    )
    args = parser.parse_args()
    
    if args.verbose:
        logger.setLevel(logging.DEBUG)

    sitemap_path = Path(args.sitemap)
    data = sitemap_path.read_bytes()
    rows = analyze_sitemap_bytes(data)
    excel_bytes = rows_to_excel_bytes(rows)
    Path(args.output).write_bytes(excel_bytes)
    print(f"Wrote {len(rows)} rows to {args.output}")


if __name__ == "__main__":
    main_cli()