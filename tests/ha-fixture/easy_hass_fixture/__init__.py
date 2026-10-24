"""Synthetic devices for a real, isolated Home Assistant test installation.

This integration is development-only and is never shipped in the Easy-Hass ZIP.
All entities and associations go through HA's normal registries and services.
"""

from homeassistant.const import Platform
from homeassistant.helpers import area_registry as ar

DOMAIN = "easy_hass_fixture"
PLATFORMS = [Platform.LIGHT, Platform.COVER, Platform.SENSOR, Platform.VACUUM]
ROOMS = [
    ("living", "Wohnzimmer", 25.3, 12.2),
    ("kitchen", "Küche", 21.9, 42.0),
    ("dining", "Esstisch", 22.1, 44.0),
    ("bedroom", "Schlafzimmer", 20.2, 48.0),
    ("hall", "Flur", 19.8, 40.0),
]


async def async_setup_entry(hass, entry):
    registry = ar.async_get(hass)
    for _, name, *_ in ROOMS:
        if registry.async_get_area_by_name(name) is None:
            registry.async_create(name)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass, entry):
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
