from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any, List, Optional

# Categories
CAT_PENDING_DELETE = "Pending Delete"
CAT_REDEMPTION = "Redemption"
CAT_EXPIRED = "Expired"
CAT_30 = "Expiring <=30 Days"
CAT_60 = "Expiring 31-60 Days"
CAT_SAFE = "Safe"
CAT_UNKNOWN = "Unknown"

CATEGORIES = [
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_EXPIRED,
    CAT_30,
    CAT_60,
    CAT_SAFE,
    CAT_UNKNOWN,
]

# Priorities
PRI_CRITICAL = "Critical"
PRI_VERY_HIGH = "Very High"
PRI_HIGH = "High"
PRI_MEDIUM = "Medium"
PRI_WATCH = "Watch"
PRI_LOW = "Low"
PRI_UNKNOWN = "Unknown"

PRIORITIES = [
    PRI_CRITICAL,
    PRI_VERY_HIGH,
    PRI_HIGH,
    PRI_MEDIUM,
    PRI_WATCH,
    PRI_LOW,
    PRI_UNKNOWN,
]

# Lookup outcome for a record
LOOKUP_OK = "ok"
LOOKUP_FAILED = "lookup_failed"
LOOKUP_NOT_FOUND = "not_found"
LOOKUP_UNSUPPORTED_TLD = "unsupported_tld"

# RFC 1035 / 1123 label rules. Deliberately strict: anything that is not a
# plain hostname is rejected before it ever reaches the network or the DB.
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
DOMAIN_RE = re.compile(rf"^(?:{_LABEL}\.)+[a-z]{{2,63}}$")
MAX_DOMAIN_LENGTH = 253


def normalize_domain(raw: str) -> Optional[str]:
    """Return a safe, lowercase registrable hostname, or None if invalid.

    Strips a scheme/path/port/leading dot wrapper if the admin pasted a URL,
    then validates against DOMAIN_RE. Never returns anything that could be
    read as a path, flag or command.
    """
    if not raw or not isinstance(raw, str):
        return None

    value = raw.strip().strip('"').strip("'").lower()
    if not value:
        return None

    if "://" in value:
        value = value.split("://", 1)[1]
    for sep in ("/", "?", "#", "\\"):
        if sep in value:
            value = value.split(sep, 1)[0]
    # userinfo@host: the host is on the right, so keep the last segment rather
    # than the credentials on the left.
    if "@" in value:
        value = value.rsplit("@", 1)[1]
    if ":" in value:
        value = value.split(":", 1)[0]
    value = value.strip(".")

    # Collapse the www host onto the registrable domain: www.example.com and
    # example.com are the same candidate and must not become two RDAP lookups.
    while value.startswith("www."):
        remainder = value[4:]
        if remainder.count(".") < 1:
            break
        value = remainder

    if not value or len(value) > MAX_DOMAIN_LENGTH:
        return None
    try:
        value = value.encode("idna").decode("ascii")
    except (UnicodeError, UnicodeDecodeError):
        return None
    if not DOMAIN_RE.match(value):
        return None
    return value


def tld_of(domain: str) -> str:
    return "." + domain.rsplit(".", 1)[-1] if "." in domain else ""


def registrable_name(domain: str) -> str:
    """The label that carries the brand, ignoring the TLD.

    Picks the longest non-TLD label, which lands on the right one for plain
    hosts, multi-label hosts and second-level ccTLDs alike without needing a
    public suffix list.
    """
    labels = [label for label in domain.split(".") if label]
    if len(labels) < 2:
        return labels[0] if labels else ""
    return max(labels[:-1], key=len)


@dataclass
class DomainRecord:
    """One monitored domain. Fields RDAP does not return stay None."""

    id: str
    domain: str
    tld: str
    expiration_date: Optional[str] = None
    days_left: Optional[int] = None
    registry_status: List[str] = field(default_factory=list)
    registrar: Optional[str] = None
    registration_date: Optional[str] = None
    nameservers: List[str] = field(default_factory=list)
    category: str = CAT_UNKNOWN
    priority: str = PRI_UNKNOWN
    quality_score: Optional[int] = None
    available: Optional[bool] = None
    lookup_status: str = LOOKUP_OK
    lookup_error: Optional[str] = None
    rdap_source: Optional[str] = None
    source: Optional[str] = None
    first_seen: Optional[str] = None
    last_checked: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
