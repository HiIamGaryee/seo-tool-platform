"""Domain Monitor: candidate discovery, RDAP verification and lifecycle classification."""

import sys
from pathlib import Path

# The sibling modules import each other flatly (classifier, storage, ...), matching
# the existing python/seo_scraper.py convention, so make this folder importable.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from classifier import classify, days_left_from, quality_score  # noqa: E402
from domain_monitor import (  # noqa: E402
    SCAN,
    export_csv,
    import_domains,
    run_scan,
    start_scan_async,
)
from models import CATEGORIES, PRIORITIES, DomainRecord, normalize_domain  # noqa: E402
from rdap_client import RdapClient, RdapError  # noqa: E402
from storage import list_domains, migrate, stats  # noqa: E402

__all__ = [
    "SCAN",
    "CATEGORIES",
    "PRIORITIES",
    "DomainRecord",
    "RdapClient",
    "RdapError",
    "classify",
    "days_left_from",
    "export_csv",
    "import_domains",
    "list_domains",
    "migrate",
    "normalize_domain",
    "quality_score",
    "run_scan",
    "start_scan_async",
    "stats",
]
