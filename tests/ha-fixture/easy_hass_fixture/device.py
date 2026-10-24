"""Device identity used by the normal HA device and entity registries."""

from homeassistant.helpers.entity import DeviceInfo
from . import DOMAIN


class FixtureDevice:
    _attr_should_poll = False
    _attr_has_entity_name = True

    def setup_device(self, room_id, room_name, kind, name):
        self._attr_unique_id = f"easy_hass_test_{room_id}_{kind}"
        # Each fixture device has one primary entity; HA uses the device name.
        self._attr_name = None
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{room_id}_{kind}")},
            name=f"{room_name} {name}",
            manufacturer="Easy-Hass test fixture",
            model="Local simulated device",
            suggested_area=room_name,
        )
