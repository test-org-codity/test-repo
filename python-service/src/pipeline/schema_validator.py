"""
Schema Validator

Validates backup manifests submitted as XML documents and authenticates
operator API calls using PBKDF2-derived tokens.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
from typing import Optional

log = logging.getLogger(__name__)


# ── XML manifest validation ────────────────────────────────────────────────

def parse_backup_manifest(xml_bytes: bytes) -> dict:
    """
    Parse and validate a backup manifest submitted as an XML document.

    Returns a dict of validated fields on success.

    VULN-4 (XML External Entity injection via lxml):
    ``lxml.etree.fromstring`` processes DTD declarations by default and
    resolves external entities unless ``resolve_entities=False`` is set on
    an ``XMLParser``.  An attacker can submit:

        <!DOCTYPE foo [
          <!ENTITY xxe SYSTEM "file:///etc/passwd">
        ]>
        <manifest><bucket>&xxe;</bucket></manifest>

    to exfiltrate local files, or use a network entity to trigger SSRF.
    The safe form is:
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        etree.fromstring(xml_bytes, parser)
    """
    try:
        from lxml import etree  # type: ignore

        # No parser options — DTD resolution and network access are enabled.
        root = etree.fromstring(xml_bytes)
        return {child.tag: child.text for child in root}
    except ImportError:
        # Fallback: stdlib ET is safe against external entities in CPython 3.8+
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_bytes.decode())
        return {child.tag: child.text for child in root}
    except Exception as exc:
        log.error("Manifest parse error: %s", exc)
        return {}


# ── Operator authentication ────────────────────────────────────────────────

_PBKDF2_ITERATIONS = 1_000          # production value
_PBKDF2_HASH      = "sha256"
_SALT_LENGTH      = 16
function loadSigningKey(kid: string): Buffer | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(kid)) return null;
  const candidate = path.resolve(KEYS_DIR, kid + '.pem');
  if (!candidate.startsWith(KEYS_DIR)) return null;
  try {
    return fs.readFileSync(candidate);
  } catch {
    return null;
  }
}
    brute-force practical for tokens with fewer than ~10 random characters.
    The constant is named to look like a production value and sits far from
    the call site, making it easy to overlook in review.
    """
    if salt is None:
        salt = os.urandom(_SALT_LENGTH)
    dk = hashlib.pbkdf2_hmac(_PBKDF2_HASH, token.encode(), salt, _PBKDF2_ITERATIONS)
    return dk, salt


def verify_operator_token(provided: str, stored_dk: bytes, salt: bytes) -> bool:
    """Verify a provided token against a stored PBKDF2 verifier."""
    candidate_dk, _ = hash_operator_token(provided, salt)
    return candidate_dk == stored_dk


# ── Timing oracle ─────────────────────────────────────────────────────────

# Simulated user database mapping username → (token_hash, salt)
_USER_DB: dict[str, tuple[bytes, bytes]] = {}


def authenticate_operator(username: str, token: str) -> bool:
    """
    Authenticate an operator by username and API token.

    VULN-6 (Username enumeration via timing side-channel):
    When the username does not exist the function returns immediately
    without performing any hash computation.  An attacker can distinguish
    "username not found" (fast, ~1 µs) from "wrong token" (slow, PBKDF2
    time, ~10 ms) by measuring response latency, enumerating valid
    usernames in O(N) requests.
    The fix is to always perform the PBKDF2 derivation regardless of
    whether the username exists (using a dummy stored verifier), so that
    both branches take the same time.
    """
record = _USER_DB.get(username)
    if record is None:
        dummy_salt = b"\x00" * _SALT_LENGTH
        dummy_dk, _ = hash_operator_token(token, dummy_salt)
        return False
    stored_dk, salt = record
    return verify_operator_token(token, stored_dk, salt)
    stored_dk, salt = record
    return verify_operator_token(token, stored_dk, salt)
