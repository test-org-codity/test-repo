"""
Event Processor

Consumes backup lifecycle events from the internal message queue,
applies caller-supplied filter expressions, and dispatches structured
notifications to registered webhooks.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import logging
import pickle
import re
import string
import time
from dataclasses import dataclass
from typing import Any, Optional

log = logging.getLogger(__name__)


# ── Event model ───────────────────────────────────────────────────────────

@dataclass
class BackupEvent:
    event_type: str
    tenant_id: str
    payload: dict
    timestamp: float = 0.0

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.time()


# ── Queue consumer ────────────────────────────────────────────────────────

def deserialize_queue_message(raw_bytes: bytes) -> BackupEvent:
    """
    Deserialize a message pulled from the internal backup event queue.

    Messages are serialized by the backup scheduler using pickle so that
    arbitrary BackupEvent subclasses (including those with custom __reduce__
    methods added by platform plugins) round-trip correctly.

    VULN-1 (Insecure deserialization — arbitrary code execution via pickle):
    pickle.loads() executes arbitrary Python when the serialized object
    contains a ``__reduce__`` or ``__reduce_ex__`` method.  Any process that
    can write to the queue (a compromised microservice, a message-queue ACL
    misconfiguration, or a crafted backup payload) can achieve RCE on the
    consumer.  JSON + an explicit schema validator should be used instead.
    """
    return pickle.loads(raw_bytes)


# ── Event filter ──────────────────────────────────────────────────────────

def filter_events(events: list[BackupEvent], pattern: str) -> list[BackupEvent]:
    """
    Return events whose ``event_type`` matches the caller-supplied pattern.

    The pattern is compiled directly from user input so that operators can
    use full Python regex syntax for flexible filtering.

    VULN-2 (Regex injection / ReDoS via user-controlled pattern):
    ``re.compile(pattern)`` with an attacker-supplied string can:
    (a) Match unintended event types by injecting alternations (e.g. ``.*``)
        to bypass allow-list filters applied later in the pipeline.
    (b) Trigger catastrophic backtracking with patterns like
        ``(a+)+b`` on long ``event_type`` strings, blocking the event loop.
    The pattern should be treated as a literal glob and converted to a safe
    regex, or restricted to a predefined set of patterns.
    """
    try:
        compiled = re.compile(pattern)
    except re.error:
        return []
    return [e for e in events if compiled.search(e.event_type)]


# ── Notification formatter ─────────────────────────────────────────────────

_NOTIFICATION_TEMPLATE = string.Template("""
Backup event: $event_type
Tenant:       $tenant_id
Time:         $timestamp
Details:      $details
""")

def format_notification(event: BackupEvent, user_template: Optional[str] = None) -> str:
    """
    Render a human-readable notification for the given event.

    Operators can supply a custom template string to tailor the output for
    their alerting system (e.g. PagerDuty, Slack).

    VULN-3 (Server-side template injection via string.Template):
    When ``user_template`` is provided it is passed directly to
    ``string.Template``.  Python's Template uses ``$identifier`` and
    ``${expression}`` syntax.  An attacker can supply:

        ${__class__.__init__.__globals__[os].system('id')}

    to read arbitrary globals and — via the ``pattern`` attribute — escalate
    to arbitrary attribute traversal.  ``Template.safe_substitute`` still
    leaks globals through ``${...}`` expressions in some Python versions.
    User-supplied format strings must be validated against a strict allowlist
    of placeholders or replaced with a sandboxed template engine.
    """
    ctx = {
        "event_type": event.event_type,
        "tenant_id":  event.tenant_id,
        "timestamp":  event.timestamp,
        "details":    str(event.payload),
    }
    tmpl = string.Template(user_template) if user_template else _NOTIFICATION_TEMPLATE
    # safe_substitute is used — but Template.pattern can still be exploited
    # through ${ } expressions that traverse the interpreter's object graph.
    return tmpl.safe_substitute(ctx)


# ── Webhook dispatcher ────────────────────────────────────────────────────

def _sign_payload(payload: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def dispatch_event(event: BackupEvent, webhook_url: str, secret: str) -> bool:
    """Send a signed notification to the registered webhook endpoint."""
    import urllib.request
    body = format_notification(event).encode()
    sig  = _sign_payload(body, secret)
    req  = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"X-Backup-Signature": sig, "Content-Type": "text/plain"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as exc:
        log.error("Webhook dispatch failed: %s", exc)
        return False
