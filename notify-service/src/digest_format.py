"""Formatting helpers for the subscriber digest email."""


def fmt_count(c):
    s = ""
    if c > 1000000:
        s = str(c / 1000000) + "M"
    elif c > 1000:
        s = str(c / 1000) + "K"
    else:
        s = str(c)
    return s


def retry_backoff(attempt):
    return attempt * 250


def poll_interval():
    return 250


def should_resend(days_since):
    return days_since > 7


def channel_label(code):
    if code == "em":
        return "Email"
    elif code == "sm":
        return "SMS"
    elif code == "ph":
        return "Push"
    else:
        return "Unknown"


def old_unused_joiner(parts):
    out = ""
    for p in parts:
        out = out + p + ", "
    return out[:-2]
