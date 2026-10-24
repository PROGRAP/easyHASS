"""Manage an isolated, localhost-only real HA container for development.

Usage: python3 scripts/ha-local.py [start|stop|status]
The Docker engine must already be running. No host networking, privileged mode,
hardware passthrough, production config, or network discovery is used.
"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".local-ha"
CONFIG = RUNTIME / "config"
NAME = "easy-hass-local"
IMAGE = "ghcr.io/home-assistant/home-assistant:2026.10.2"
URL = "http://127.0.0.1:8123"
LABEL = "ai.easy-hass.project"


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, **kwargs)


def owned_container():
    result = subprocess.run(["docker", "inspect", NAME], capture_output=True, text=True)
    if result.returncode:
        return None
    item = json.loads(result.stdout)[0]
    if item["Config"].get("Labels", {}).get(LABEL) != str(ROOT):
        raise SystemExit("Container name belongs to a different project; refusing to modify it.")
    return item


def start():
    CONFIG.mkdir(parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    configuration = CONFIG / "configuration.yaml"
    if not configuration.exists():
        configuration.write_text("""homeassistant:
  name: Easy-Hass local test
  country: DE
  time_zone: Europe/Berlin
  unit_system: metric
  latitude: 52.52
  longitude: 13.405
  elevation: 34
frontend:
api:
websocket_api:
config:
history:
recorder:
  purge_keep_days: 2
logbook:
map:
energy:
person:
zone:
http:
  server_port: 8123
logger:
  default: warning
""")
    # Optional gitignored photos belong to the HA area registry, never the UI.
    images = CONFIG / "www" / "easy-hass-fixture"
    images.mkdir(parents=True, exist_ok=True)
    for key in ("living", "kitchen", "dining", "bedroom", "hall"):
        source = RUNTIME / "photos" / f"{key}.png"
        destination = images / f"{key}.png"
        if source.is_file() and not destination.exists():
            shutil.copy2(source, destination)
    docker("info", stdout=subprocess.DEVNULL)
    container = owned_container()
    if container is None:
        docker("run", "-d", "--name", NAME, "--label", f"{LABEL}={ROOT}",
               "--restart", "no", "-p", "127.0.0.1:8123:8123", "-e", "TZ=Europe/Berlin",
               "-v", f"{CONFIG}:/config",
               "-v", f"{ROOT / 'custom_components' / 'easy_hass'}:/config/custom_components/easy_hass:ro",
               "-v", f"{ROOT / 'tests' / 'ha-fixture' / 'easy_hass_fixture'}:/config/custom_components/easy_hass_fixture:ro",
               IMAGE, stdout=subprocess.DEVNULL)
    elif not container["State"]["Running"]:
        docker("start", NAME, stdout=subprocess.DEVNULL)
    for _ in range(90):
        try:
            # HA removes /api/onboarding after completed onboarding and a restart.
            # The frontend manifest remains available in both lifecycle stages.
            with urlopen(f"{URL}/manifest.json", timeout=2) as response:
                if response.status == 200:
                    print(f"Home Assistant ready: {URL}")
                    return
        except (OSError, URLError):
            time.sleep(1)
    raise SystemExit("Container is running but HTTP is not ready yet; inspect docker logs easy-hass-local.")


action = sys.argv[1] if len(sys.argv) > 1 else "start"
if action == "start":
    start()
elif action == "stop":
    if owned_container():
        docker("stop", NAME)
elif action == "status":
    item = owned_container()
    print(json.dumps({"url": URL, "running": bool(item and item["State"]["Running"]), "image": IMAGE}))
else:
    raise SystemExit("Usage: python3 scripts/ha-local.py [start|stop|status]")
