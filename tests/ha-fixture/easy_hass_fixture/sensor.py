"""Room readings and energy consumption, exposed as normal HA sensors."""

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE, UnitOfEnergy, UnitOfTemperature
from . import ROOMS
from .device import FixtureDevice


async def async_setup_entry(hass, entry, async_add_entities):
    readings = []
    for room_id, name, temperature, humidity in ROOMS:
        readings.extend([
            FixtureSensor(room_id, name, "temperature", "Temperatur", temperature, SensorDeviceClass.TEMPERATURE, UnitOfTemperature.CELSIUS),
            FixtureSensor(room_id, name, "humidity", "Luftfeuchtigkeit", humidity, SensorDeviceClass.HUMIDITY, PERCENTAGE),
        ])
    readings.append(FixtureSensor("hall", "Flur", "energy", "Energie", 12.7, SensorDeviceClass.ENERGY, UnitOfEnergy.KILO_WATT_HOUR))
    async_add_entities(readings)


class FixtureSensor(FixtureDevice, SensorEntity):
    def __init__(self, room_id, room_name, kind, name, value, device_class, unit):
        self.setup_device(room_id, room_name, kind, name)
        self._attr_native_value = value
        self._attr_device_class = device_class
        self._attr_native_unit_of_measurement = unit
        self._attr_state_class = SensorStateClass.TOTAL_INCREASING if kind == "energy" else SensorStateClass.MEASUREMENT
