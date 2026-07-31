from __future__ import annotations

import io
import logging
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

# How many URLs to fetch at once. Keeps memory/socket use bounded while being
# far faster than fetching one at a time.
MAX_WORKERS = 6


def normalize_items(
    items: Optional[List[dict]],
    urls: Optional[List[str]],
    fallback_ext: str,
) -> List[Tuple[str, str]]:
    """Accept either items=[{url, name}] or urls=[...] and return [(url, name)].

    Missing/blank names get a stable ``file-<n><ext>`` fallback.
    """
    result: List[Tuple[str, str]] = []

    if items:
        for i, it in enumerate(items):
            url = (it or {}).get("url")
            if not url:
                continue
            name = (it or {}).get("name") or f"file-{i + 1}{fallback_ext}"
            result.append((url, name))
    elif urls:
        for i, url in enumerate(urls):
            if url:
                result.append((url, f"file-{i + 1}{fallback_ext}"))

    return result


def _fetch_bytes(url: str, timeout: float, headers: dict) -> bytes:
    resp = requests.get(
        url,
        timeout=timeout,
        headers=headers,
        allow_redirects=True,
        verify=False,  # mirror the rest of the backend (skip bad certs)
    )
    resp.raise_for_status()
    return resp.content


def build_zip(
    items: List[Tuple[str, str]],
    timeout: float,
    headers: dict,
    compression: int = zipfile.ZIP_STORED,
) -> Tuple[bytes, int, int]:
    """Fetch every (url, name) concurrently and pack them into one in-memory zip.

    Returns (zip_bytes, packed_count, failed_count). Items that fail to download
    are skipped (logged) rather than aborting the whole archive.
    """
    packed = 0
    failed = 0
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", compression) as zf:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            future_to_name = {
                executor.submit(_fetch_bytes, url, timeout, headers): name
                for url, name in items
            }
            for future in as_completed(future_to_name):
                name = future_to_name[future]
                try:
                    content = future.result()
                    zf.writestr(name, content)
                    packed += 1
                except Exception as exc:  # noqa: BLE001 - one bad URL must not kill the batch
                    failed += 1
                    logger.warning(f"Batch zip: failed to fetch {name}: {exc}")

    buf.seek(0)
    return buf.read(), packed, failed
