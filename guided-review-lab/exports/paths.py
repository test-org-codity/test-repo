"""Export output paths must stay inside the designated export directory."""

from pathlib import Path

def export_path(root, filename):
    return Path(root) / filename
