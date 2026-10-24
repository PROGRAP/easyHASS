"""A basic HA vacuum entity for verifying the robot menu."""

from homeassistant.components.vacuum import StateVacuumEntity, VacuumActivity, VacuumEntityFeature
from .device import FixtureDevice


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities([FixtureVacuum()])


class FixtureVacuum(FixtureDevice, StateVacuumEntity):
    _attr_supported_features = VacuumEntityFeature.START | VacuumEntityFeature.PAUSE | VacuumEntityFeature.STOP | VacuumEntityFeature.RETURN_HOME | VacuumEntityFeature.STATE
    _attr_activity = VacuumActivity.DOCKED

    def __init__(self):
        self.setup_device("hall", "Flur", "vacuum", "Saugroboter")

    async def async_start(self):
        self._attr_activity = VacuumActivity.CLEANING
        self.async_write_ha_state()

    async def async_pause(self):
        self._attr_activity = VacuumActivity.PAUSED
        self.async_write_ha_state()

    async def async_stop(self, **kwargs):
        self._attr_activity = VacuumActivity.IDLE
        self.async_write_ha_state()

    async def async_return_to_base(self, **kwargs):
        self._attr_activity = VacuumActivity.DOCKED
        self.async_write_ha_state()
