from __future__ import annotations

from datetime import date

import pytest

from classifier import classify, days_left_from
from models import (
    CAT_30,
    CAT_60,
    CAT_EXPIRED,
    CAT_PENDING_DELETE,
    CAT_REDEMPTION,
    CAT_SAFE,
    CAT_UNKNOWN,
    PRI_CRITICAL,
    PRI_HIGH,
    PRI_LOW,
    PRI_MEDIUM,
    PRI_UNKNOWN,
    PRI_VERY_HIGH,
    PRI_WATCH,
)

TODAY = date(2026, 8, 26)


@pytest.mark.parametrize(
    "days,expected_category,expected_priority",
    [
        (-1, CAT_EXPIRED, PRI_HIGH),
        (-400, CAT_EXPIRED, PRI_HIGH),
        (0, CAT_30, PRI_MEDIUM),
        (1, CAT_30, PRI_MEDIUM),
        (30, CAT_30, PRI_MEDIUM),
        (31, CAT_60, PRI_WATCH),
        (60, CAT_60, PRI_WATCH),
        (61, CAT_SAFE, PRI_LOW),
        (5000, CAT_SAFE, PRI_LOW),
    ],
)
def test_day_boundaries(days, expected_category, expected_priority):
    assert classify(["active"], days) == (expected_category, expected_priority)


def test_unknown_expiry_is_unknown_not_safe():
    assert classify(["active"], None) == (CAT_UNKNOWN, PRI_UNKNOWN)


def test_registry_status_overrides_dates():
    # A far-future expiry must not mask a pendingDelete lifecycle state.
    assert classify(["pendingDelete"], 900) == (CAT_PENDING_DELETE, PRI_CRITICAL)
    assert classify(["redemptionPeriod"], 900) == (CAT_REDEMPTION, PRI_VERY_HIGH)


def test_pending_delete_outranks_redemption():
    category, _ = classify(["redemptionPeriod", "pendingDelete"], 10)
    assert category == CAT_PENDING_DELETE


@pytest.mark.parametrize(
    "status",
    ["pendingDelete", "pending delete", "PENDINGDELETE", "pending_delete"],
)
def test_status_matching_is_format_insensitive(status):
    category, _ = classify([status], 100)
    assert category == CAT_PENDING_DELETE


def test_unknown_expiry_with_clean_status_stays_unknown():
    assert classify(["clientTransferProhibited"], None)[0] == CAT_UNKNOWN


@pytest.mark.parametrize(
    "expiry,expected",
    [
        ("2026-09-12", 17),
        ("2026-09-12T00:00:00Z", 17),
        ("2026-08-26", 0),
        ("2026-08-25", -1),
        (None, None),
        ("", None),
        ("garbage", None),
    ],
)
def test_days_left_parsing(expiry, expected):
    assert days_left_from(expiry, TODAY) == expected


def test_expired_is_never_reported_as_available():
    """Expired must not imply registrable.

    The lifecycle can still be grace, auto-renew, redemption or pendingDelete,
    so availability is a separate signal the classifier never sets.
    """
    import backlinks
    import history_client
    from anchors import build_profile
    from spam import SpamAssessment
    from verify_helpers import make_record

    record = make_record("expired-example.com", days_left=-30)
    assert record.category == CAT_EXPIRED
    assert record.available is None
