"""Create a local installation archive without development files or credentials."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
component = root / "custom_components" / "easy_hass"
version = json.loads((component / "manifest.json").read_text())["version"]
destination = root / "dist" / f"easy-hass-{version}.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for source in sorted(component.rglob("*")):
        if source.is_file() and "__pycache__" not in source.parts and source.suffix != ".pyc":
            archive.write(source, source.relative_to(root))
print(destination)
