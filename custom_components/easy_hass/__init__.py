"""Register the local Easy-Hass frontend inside Home Assistant."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
import re

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import config_validation as cv

from .const import (
    DOMAIN,
    BUILD_METADATA_FILE,
    MODULE_FILE,
    NAME,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_PATH,
    STATIC_URL,
)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
FRONTEND_DIRECTORY = Path(__file__).parent / "frontend"


def _frontend_module_url() -> str:
    """Read the current build on every setup, including config-entry reloads.

    Relative imports, styles and fonts inherit the entry's fingerprinted path.
    Changing any asset therefore avoids HA's stale-while-revalidate file cache
    for the complete graph, not just its first JavaScript module.
    """
    try:
        metadata = json.loads((FRONTEND_DIRECTORY / BUILD_METADATA_FILE).read_text())
        revision = metadata["revision"]
        entry = metadata["entry"]
        if (
            metadata.get("schema_version") != 1
            or not isinstance(revision, str)
            or re.fullmatch(r"[0-9a-f]{64}", revision) is None
            or entry != f"builds/{revision}/{MODULE_FILE}"
            or not (FRONTEND_DIRECTORY / entry).is_file()
        ):
            raise ValueError("Invalid or incomplete frontend build metadata")
        return f"{STATIC_URL}/{entry}"
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as err:
        raise ConfigEntryError(
            translation_domain=DOMAIN,
            translation_key="frontend_missing",
        ) from err


@dataclass
class _Registration:
    """Process-wide routes and the current panel registration.

    Home Assistant does not expose static-route removal. Keep the route flag
    across config-entry unloads so reloads do not register the same route again.
    """

    static_registered: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    entry_id: str | None = None
    panel: frontend.Panel | None = None


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Easy-Hass from its single config entry."""
    registration: _Registration = hass.data.setdefault(DOMAIN, _Registration())

    async with registration.lock:
        if frontend.async_panel_exists(hass, PANEL_PATH):
            raise ConfigEntryError(
                translation_domain=DOMAIN,
                translation_key="panel_path_in_use",
                translation_placeholders={"path": PANEL_PATH},
            )

        module_url = await hass.async_add_executor_job(_frontend_module_url)

        if not registration.static_registered:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(STATIC_URL, str(FRONTEND_DIRECTORY), False)]
            )
            registration.static_registered = True

        try:
            await panel_custom.async_register_panel(
                hass,
                frontend_url_path=PANEL_PATH,
                webcomponent_name=PANEL_ELEMENT,
                sidebar_title=NAME,
                sidebar_icon=PANEL_ICON,
                module_url=module_url,
                embed_iframe=False,
                require_admin=False,
            )
        except ValueError as err:
            # Another integration can claim the path during static-file setup.
            raise ConfigEntryError(
                translation_domain=DOMAIN,
                translation_key="panel_path_in_use",
                translation_placeholders={"path": PANEL_PATH},
            ) from err

        registration.entry_id = entry.entry_id
        registration.panel = hass.data[frontend.DATA_PANELS][PANEL_PATH]

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove our panel while retaining process-wide static routes."""
    registration: _Registration | None = hass.data.get(DOMAIN)
    if registration is None:
        return True

    async with registration.lock:
        if registration.entry_id != entry.entry_id:
            return True

        # Check identity: never remove a replacement owned by another component.
        current_panel = hass.data.get(frontend.DATA_PANELS, {}).get(PANEL_PATH)
        if current_panel is registration.panel and current_panel is not None:
            frontend.async_remove_panel(hass, PANEL_PATH)

        registration.entry_id = None
        registration.panel = None

    return True
