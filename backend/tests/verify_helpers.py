"""Small builders shared by tests. Not used by production code."""
from __future__ import annotations

from typing import Optional

import classifier
from models import DomainRecord, tld_of


def make_record(
    domain: str,
    days_left: Optional[int] = None,
    registry_status: Optional[list[str]] = None,
) -> DomainRecord:
    statuses = registry_status or ["clientTransferProhibited"]
    category, priority = classifier.classify(statuses, days_left)
    return DomainRecord(
        id=domain,
        domain=domain,
        tld=tld_of(domain),
        days_left=days_left,
        registry_status=statuses,
        category=category,
        priority=priority,
    )
