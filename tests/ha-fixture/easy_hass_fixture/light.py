"""Lights that respond to real HA light services."""

from homeassistant.components.light import ATTR_BRIGHTNESS, ColorMode, LightEntity
from . import ROOMS
from .device import FixtureDevice


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([
        *[FixtureLight(room_id, name, i > 2) for i, (room_id, name, *_) in enumerate(ROOMS)],
        FixtureOnOffLight(),
    ])


class FixtureLight(FixtureDevice, LightEntity):
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}
    _attr_color_mode = ColorMode.BRIGHTNESS

    def __init__(self, room_id, name, enabled):
        self.setup_device(room_id, name, "light", "Licht")
        self._attr_is_on = enabled
        self._attr_brightness = 166

    async def async_turn_on(self, **kwargs):
        self._attr_is_on = True
        self._attr_brightness = kwargs.get(ATTR_BRIGHTNESS, self._attr_brightness or 255)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs):
        self._attr_is_on = False
        self.async_write_ha_state()


class FixtureOnOffLight(FixtureDevice, LightEntity):
    _attr_supported_color_modes = {ColorMode.ONOFF}
    _attr_color_mode = ColorMode.ONOFF
    _attr_is_on = False

    def __init__(self):
        self.setup_device("living", "Wohnzimmer", "onoff", "Leselicht")

    async def async_turn_on(self, **kwargs):
        self._attr_is_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs):
        self._attr_is_on = False
        self.async_write_ha_state()
