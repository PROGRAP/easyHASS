"""A positionable cover using HA's 0=closed and 100=open convention."""

from homeassistant.components.cover import ATTR_POSITION, CoverDeviceClass, CoverEntity, CoverEntityFeature
from .device import FixtureDevice


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([FixtureCover()])


class FixtureCover(FixtureDevice, CoverEntity):
    _attr_device_class = CoverDeviceClass.SHUTTER
    _attr_supported_features = CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE | CoverEntityFeature.SET_POSITION | CoverEntityFeature.STOP

    def __init__(self):
        self.setup_device("living", "Wohnzimmer", "cover", "Rollladen")
        self._attr_current_cover_position = 100
        self._attr_is_closed = False

    async def async_set_cover_position(self, **kwargs):
        self._attr_current_cover_position = kwargs[ATTR_POSITION]
        self._attr_is_closed = self._attr_current_cover_position == 0
        self.async_write_ha_state()

    async def async_open_cover(self, **kwargs):
        await self.async_set_cover_position(position=100)

    async def async_close_cover(self, **kwargs):
        await self.async_set_cover_position(position=0)

    async def async_stop_cover(self, **kwargs):
        self.async_write_ha_state()
