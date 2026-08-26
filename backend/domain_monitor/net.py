from __future__ import annotations

import logging
import random
import threading
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)


class HostRateLimiter:
    """Minimum spacing between requests to the same host.

    Shared by every external client so one provider's limit cannot be bypassed
    by another code path.
    """

    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                ready_at = self._last.get(host, 0.0) + self._min_interval
                if now >= ready_at:
                    self._last[host] = now
                    return
                sleep_for = ready_at - now
            time.sleep(sleep_for)


def sleep_backoff(attempt: int, retry_after: Optional[str] = None, cap: float = 8.0) -> None:
    """Exponential backoff with jitter, honouring Retry-After when present."""
    if retry_after:
        try:
            time.sleep(min(float(retry_after), 30.0))
            return
        except (TypeError, ValueError):
            pass
    time.sleep(min(2.0 ** attempt, cap) + random.uniform(0, 0.4))


def build_session(user_agent: str, pool_size: int = 16, accept: str = "*/*") -> requests.Session:
    """A session whose connection pool matches the worker count."""
    session = requests.Session()
    session.headers.update({"User-Agent": user_agent, "Accept": accept})
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=pool_size, pool_maxsize=pool_size
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_with_retries(
    session: requests.Session,
    url: str,
    limiter: HostRateLimiter,
    host: str,
    timeout: float,
    max_retries: int,
    params: Optional[dict] = None,
    label: str = "request",
) -> Optional[requests.Response]:
    """Rate-limited GET with bounded retries.

    Returns None when every attempt failed. Never raises for transport errors:
    callers treat a missing response as missing data, not as a crash.
    """
    for attempt in range(max_retries):
        limiter.wait(host)
        try:
            response = session.get(url, params=params, timeout=timeout)
        except requests.Timeout:
            logger.debug("%s timed out (attempt %d): %s", label, attempt + 1, url)
        except requests.RequestException as exc:
            logger.debug("%s transport error (attempt %d): %s", label, attempt + 1, exc)
        else:
            if response.status_code == 200:
                return response
            if response.status_code == 404:
                return response
            if response.status_code == 429 or 500 <= response.status_code < 600:
                logger.debug("%s got %d, backing off", label, response.status_code)
                if attempt < max_retries - 1:
                    sleep_backoff(attempt, response.headers.get("Retry-After"))
                continue
            return response

        if attempt < max_retries - 1:
            sleep_backoff(attempt)

    return None
