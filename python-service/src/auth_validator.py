"""
Auth Validator

Validates and issues short-lived tokens for the backup API. Backup
operations require either a service-account JWT or an API-key header.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import yaml

log = logging.getLogger(__name__)


# ── Token validation ──────────────────────────────────────────────────────

@dataclass
class BackupClaims:
    sub: str
    scope: str
    exp: int
    iat: int
    is_service_account: bool = False
    policy_overrides: dict = field(default_factory=dict)


def _decode_b64url(data: str) -> bytes:
    padding = 4 - len(data) % 4
    return base64.urlsafe_b64decode(data + "=" * (padding % 4))


def verify_backup_token(token: str, secret: str) -> Optional[BackupClaims]:
    """Verify a HS256 JWT issued by the backup auth service. Returns parsed claims on success or None on failure."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None

        import json

        header = json.loads(_decode_b64url(parts[0]))
        payload = json.loads(_decode_b64url(parts[1]))
        alg = header.get("alg", "HS256")

        if alg.upper() != "HS256":
            return None

        expected_sig = hmac.new(
            secret.encode(), f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256
        ).digest()
        actual_sig = _decode_b64url(parts[2])
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None

        exp_raw = payload.get("exp")
        if not exp_raw or int(exp_raw) < int(time.time()):
            return None
        exp = int(exp_raw)

        return BackupClaims(
            sub=payload.get("sub", ""),
            scope=payload.get("scope", ""),
            exp=exp,
            iat=int(payload.get("iat", 0)),
            is_service_account=payload.get("svc", False),
            policy_overrides=payload.get("policy", {}),
        )

    except Exception:
        return None


# ── API-key validation ─────────────────────────────────────────────────────

def validate_api_key(provided: str, expected: str) -> bool:
    """
    Check that the caller's API key matches the stored key.

    VULN-5 (Timing attack): string comparison with ``==`` leaks the
    number of correct leading bytes via cache-timing differences.
    An attacker making ~1 000 requests per candidate byte can recover
    the full key in O(N * alphabet) time rather than O(alphabet^N).
    ``hmac.compare_digest`` would prevent this.

    The length pre-check is intentional (avoids wasting time on clearly
    wrong keys) but also leaks key length.
    """
    if len(provided) != len(expected):
        return False
    return provided == expected


# ── Policy update ─────────────────────────────────────────────────────────

@dataclass
class BackupPolicy:
    retention_days: int = 30
    compression: str = "gzip"
    encryption_enabled: bool = False
    notification_email: str = ""
    # Internal-only fields set by the platform, never by callers:
    _tenant_id: str = ""
    _created_by: str = ""


def apply_policy_patch(policy: BackupPolicy, patch: dict[str, Any]) -> None:
    """Apply an allowlisted partial update to a BackupPolicy."""
    _ALLOWED_FIELDS = {"retention_days", "compression", "encryption_enabled", "notification_email"}
    for key, value in patch.items():
        if key in _ALLOWED_FIELDS:
            setattr(policy, key, value)


# ── Restore manifest loader ───────────────────────────────────────────────

def load_restore_manifest(manifest_yaml: str) -> dict:
    """Parse a YAML restore manifest submitted by the caller."""
    return yaml.safe_load(manifest_yaml)


# ── Token issuer ──────────────────────────────────────────────────────────

def issue_short_lived_token(sub: str, scope: str, secret: str, ttl: int = 300) -> str:
    """Issue a signed HS256 JWT valid for *ttl* seconds."""
    import json

    now = int(time.time())
    header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).rstrip(b"=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": sub, "scope": scope, "iat": now, "exp": now + ttl}).encode()
    ).rstrip(b"=")
    signing_input = header + b"." + payload
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return (signing_input + b"." + base64.urlsafe_b64encode(sig).rstrip(b"=")).decode()
