from __future__ import annotations

import logging
import random
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

import requests

from net import HostRateLimiter

logger = logging.getLogger(__name__)

# IANA's published RDAP bootstrap registry (RFC 7484). A documented public
# data file, not a scrape target.
BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"
BOOTSTRAP_TTL_SECONDS = 24 * 60 * 60

USER_AGENT = "SEO-Tool-Platform-DomainMonitor/1.0"
RDAP_ACCEPT = "application/rdap+json, application/json"

DEFAULT_TIMEOUT = 12.0
DEFAULT_MAX_RETRIES = 3
DEFAULT_MIN_HOST_INTERVAL = 0.6  # seconds between calls to one RDAP host

_WHOIS_EXPIRY_RE = re.compile(
    r"(?:registry expiry date|expiry date|expiration date|paid-till|renewal date)\s*:\s*(\S+)",
    re.IGNORECASE,
)
_WHOIS_STATUS_RE = re.compile(r"^\s*(?:domain )?status\s*:\s*([^\s]+)", re.IGNORECASE | re.MULTILINE)
_WHOIS_REFERRAL_RE = re.compile(r"^\s*whois\s*:\s*(\S+)", re.IGNORECASE | re.MULTILINE)

# IANA publishes the authoritative WHOIS server for every TLD over port 43,
# so a referral lookup replaces guessing at a third-party redirect host.
IANA_WHOIS_HOST = "whois.iana.org"
_WHOIS_REFERRAL_CACHE: dict[str, Optional[str]] = {}
_WHOIS_REFERRAL_LOCK = threading.Lock()


def verification_source_of(rdap_source: Optional[str]) -> str:
    """Which protocol actually produced a record: rdap, whois or unknown."""
    if not rdap_source:
        return "unknown"
    return "whois" if str(rdap_source).startswith("whois://") else "rdap"


class RdapError(Exception):
    """Recoverable RDAP problem. Carries a machine-readable kind."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass
class RdapResult:
    domain: str
    expiration_date: Optional[str] = None
    registration_date: Optional[str] = None
    registry_status: list[str] = field(default_factory=list)
    registrar: Optional[str] = None
    nameservers: list[str] = field(default_factory=list)
    rdap_source: Optional[str] = None


def _iso(value: Any) -> Optional[str]:
    """Normalize an RDAP/WHOIS date to an ISO date string, or None."""
    if not value or not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).date().isoformat()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%Y.%m.%d", "%d.%m.%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value.strip()[:19], fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _registrar_from_entities(entities: Any) -> Optional[str]:
    """Pull the registrar's display name out of the jCard vcardArray."""
    if not isinstance(entities, list):
        return None
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        roles = [str(r).lower() for r in entity.get("roles") or []]
        if "registrar" not in roles:
            continue
        vcard = entity.get("vcardArray")
        if isinstance(vcard, list) and len(vcard) > 1 and isinstance(vcard[1], list):
            for prop in vcard[1]:
                if isinstance(prop, list) and len(prop) >= 4 and prop[0] == "fn":
                    name = prop[3]
                    if isinstance(name, str) and name.strip():
                        return name.strip()
        handle = entity.get("handle")
        if isinstance(handle, str) and handle.strip():
            return handle.strip()
    return None


def parse_rdap_payload(domain: str, payload: dict[str, Any], source: str) -> RdapResult:
    """Map an RDAP domain object onto RdapResult. Absent fields stay None."""
    result = RdapResult(domain=domain, rdap_source=source)

    for event in payload.get("events") or []:
        if not isinstance(event, dict):
            continue
        action = str(event.get("eventAction") or "").lower()
        when = _iso(event.get("eventDate"))
        if action == "expiration":
            result.expiration_date = when
        elif action == "registration":
            result.registration_date = when

    statuses = payload.get("status")
    if isinstance(statuses, list):
        result.registry_status = [str(s) for s in statuses if s]

    result.registrar = _registrar_from_entities(payload.get("entities"))

    nameservers: list[str] = []
    for ns in payload.get("nameservers") or []:
        if isinstance(ns, dict):
            name = ns.get("ldhName") or ns.get("unicodeName")
            if isinstance(name, str) and name.strip():
                nameservers.append(name.strip().lower())
    result.nameservers = sorted(set(nameservers))

    return result


class RdapClient:
    """Bootstrap-aware RDAP lookup client.

    Handles per-host rate limiting, bounded retries with exponential backoff
    and jitter, and an optional port-43 WHOIS fallback for TLDs that publish
    no RDAP endpoint.
    """

    def __init__(
        self,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        min_host_interval: float = DEFAULT_MIN_HOST_INTERVAL,
        allow_whois_fallback: bool = False,
        pool_size: int = 16,
    ) -> None:
        self.timeout = timeout
        self.max_retries = max_retries
        self.allow_whois_fallback = allow_whois_fallback
        self._limiter = HostRateLimiter(min_host_interval)
        self._bootstrap: dict[str, str] = {}
        self._bootstrap_at = 0.0
        self._bootstrap_lock = threading.Lock()
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": USER_AGENT, "Accept": RDAP_ACCEPT})
        # Size the pool to the worker count so parallel lookups reuse
        # connections instead of discarding them.
        adapter = requests.adapters.HTTPAdapter(pool_connections=pool_size, pool_maxsize=pool_size)
        self._session.mount("https://", adapter)
        self._session.mount("http://", adapter)

    # -- bootstrap ---------------------------------------------------------

    def _load_bootstrap(self) -> dict[str, str]:
        with self._bootstrap_lock:
            fresh = time.monotonic() - self._bootstrap_at < BOOTSTRAP_TTL_SECONDS
            if self._bootstrap and fresh:
                return self._bootstrap
            try:
                resp = self._session.get(BOOTSTRAP_URL, timeout=self.timeout)
                resp.raise_for_status()
                services = resp.json().get("services") or []
            except (requests.RequestException, ValueError) as exc:
                logger.warning("RDAP bootstrap fetch failed: %s", exc)
                return self._bootstrap  # keep any previously cached map

            mapping: dict[str, str] = {}
            for entry in services:
                if not isinstance(entry, list) or len(entry) < 2:
                    continue
                tlds, urls = entry[0], entry[1]
                base = next((u for u in urls if str(u).startswith("https://")), None)
                base = base or (urls[0] if urls else None)
                if not base:
                    continue
                for tld in tlds:
                    mapping[str(tld).lower().lstrip(".")] = str(base).rstrip("/")

            if mapping:
                self._bootstrap = mapping
                self._bootstrap_at = time.monotonic()
                logger.info("RDAP bootstrap loaded: %d TLDs", len(mapping))
            return self._bootstrap

    def base_url_for(self, domain: str) -> Optional[str]:
        """Longest-suffix match against the bootstrap map (handles .co.uk)."""
        mapping = self._load_bootstrap()
        if not mapping:
            return None
        labels = domain.split(".")
        for i in range(1, len(labels)):
            candidate = ".".join(labels[i:])
            if candidate in mapping:
                return mapping[candidate]
        return None

    # -- lookup ------------------------------------------------------------

    def lookup(self, domain: str) -> RdapResult:
        """Look up one domain. Raises RdapError on any unrecoverable outcome."""
        base = self.base_url_for(domain)
        if not base:
            if self.allow_whois_fallback:
                return self._whois_fallback(domain)
            raise RdapError("unsupported_tld", f"No RDAP endpoint published for {domain}")

        url = f"{base}/domain/{domain}"
        host = urlsplit(base).netloc
        last_error: Optional[str] = None

        for attempt in range(self.max_retries):
            self._limiter.wait(host)
            try:
                resp = self._session.get(url, timeout=self.timeout, allow_redirects=True)
            except requests.Timeout:
                last_error = "RDAP request timed out"
            except requests.RequestException as exc:
                last_error = f"RDAP transport error: {exc}"
            else:
                if resp.status_code == 200:
                    try:
                        payload = resp.json()
                    except ValueError as exc:
                        raise RdapError("malformed_response", f"RDAP returned non-JSON: {exc}")
                    if not isinstance(payload, dict):
                        raise RdapError("malformed_response", "RDAP payload was not an object")
                    return parse_rdap_payload(domain, payload, base)
                if resp.status_code == 404:
                    raise RdapError("not_found", "Domain not present in the registry (404)")
                if resp.status_code == 429:
                    last_error = "RDAP rate limited (429)"
                    self._sleep_backoff(attempt, resp.headers.get("Retry-After"))
                    continue
                if 500 <= resp.status_code < 600:
                    last_error = f"RDAP server error ({resp.status_code})"
                else:
                    raise RdapError("http_error", f"RDAP responded {resp.status_code}")

            if attempt < self.max_retries - 1:
                self._sleep_backoff(attempt, None)

        if self.allow_whois_fallback:
            try:
                return self._whois_fallback(domain)
            except RdapError as exc:
                last_error = f"{last_error}; WHOIS fallback failed: {exc}"
        raise RdapError("lookup_failed", last_error or "RDAP lookup failed")

    def _sleep_backoff(self, attempt: int, retry_after: Optional[str]) -> None:
        if retry_after:
            try:
                time.sleep(min(float(retry_after), 30.0))
                return
            except (TypeError, ValueError):
                pass
        delay = min(2.0 ** attempt, 8.0) + random.uniform(0, 0.4)
        time.sleep(delay)

    # -- WHOIS fallback ----------------------------------------------------

    def _whois_query(self, host: str, query: str) -> str:
        """One raw port-43 exchange. Bounded read, no shell, no HTTP."""
        self._limiter.wait(host)
        try:
            with socket.create_connection((host, 43), timeout=self.timeout) as sock:
                sock.sendall(f"{query}\r\n".encode("idna", errors="strict"))
                chunks: list[bytes] = []
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    if sum(len(c) for c in chunks) > 256_000:
                        break
        except (socket.timeout, socket.gaierror, OSError, UnicodeError) as exc:
            raise RdapError("lookup_failed", f"WHOIS unavailable via {host}: {exc}")
        return b"".join(chunks).decode("utf-8", errors="ignore")

    def whois_server_for(self, domain: str) -> Optional[str]:
        """The registry's own WHOIS host, as published by IANA over port 43.

        Cached per TLD for the life of the client. Falls back to the
        whois-servers.net alias only when IANA publishes no referral.
        """
        tld = domain.rsplit(".", 1)[-1].lower()
        with _WHOIS_REFERRAL_LOCK:
            if tld in _WHOIS_REFERRAL_CACHE:
                return _WHOIS_REFERRAL_CACHE[tld]

        server: Optional[str] = None
        try:
            referral = self._whois_query(IANA_WHOIS_HOST, tld)
            match = _WHOIS_REFERRAL_RE.search(referral)
            if match:
                server = match.group(1).strip().lower() or None
        except RdapError as exc:
            logger.debug("[whois] IANA referral for .%s failed: %s", tld, exc)

        if not server:
            server = f"{tld}.whois-servers.net"

        with _WHOIS_REFERRAL_LOCK:
            _WHOIS_REFERRAL_CACHE[tld] = server
        logger.debug("[whois] .%s -> %s", tld, server)
        return server

    def _whois_fallback(self, domain: str) -> RdapResult:
        """Minimal port-43 WHOIS read for TLDs with no RDAP service.

        Only the expiry date and status lines are parsed; WHOIS text is far
        too inconsistent to trust for anything richer.
        """
        server = self.whois_server_for(domain)
        if not server:
            raise RdapError("lookup_failed", "No WHOIS server published for this TLD")
        text = self._whois_query(server, domain)

        result = RdapResult(domain=domain, rdap_source=f"whois://{server}")
        expiry = _WHOIS_EXPIRY_RE.search(text)
        if expiry:
            result.expiration_date = _iso(expiry.group(1))
        result.registry_status = sorted({m.group(1) for m in _WHOIS_STATUS_RE.finditer(text)})
        if not result.expiration_date and not result.registry_status:
            raise RdapError("lookup_failed", "WHOIS response carried no usable fields")
        return result

    def close(self) -> None:
        self._session.close()
