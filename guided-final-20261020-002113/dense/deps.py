"""Export files must remain inside the configured export directory."""
from pathlib import Path

def export_path(root, filename):
    return Path(root) / filename
