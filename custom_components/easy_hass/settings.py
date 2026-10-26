"""Persistent EasyHASS preferences, separate from Home Assistant's area registry."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

import probatio

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry, device_registry, entity_registry
from homeassistant.helpers.dispatcher import (
    async_dispatcher_connect,
    async_dispatcher_send,
)

from .const import DOMAIN

HIDDEN_AREA_IDS = "hidden_area_ids"
ROOM_DEVICE_ORDER = "room_device_order"
ROOM_DEVICE_LINKS = "room_device_links"
_ASSIGNMENT_KEY = re.compile(r"^(device:[^\s:]+|entity:[a-z0-9_]+\.[a-z0-9_]+)$")
_EXCLUDED_DOMAINS = frozenset({
    "sensor", "binary_sensor", "automation", "script", "scene", "update",
    "person", "weather", "zone", "sun", "device_tracker", "persistent_notification",
    "conversation", "stt", "tts", "ai_task", "notify", "wake_word",
})
_DATA_SETTINGS = f"{DOMAIN}_settings"
_SIGNAL_SETTINGS = f"{DOMAIN}_settings_updated"


@dataclass
class _Settings:
    """Retain commands and subscriptions across config-entry reloads."""

    entry: ConfigEntry | None = None


def _hidden_ids(entry: ConfigEntry) -> set[str]:
    """Treat absent or malformed old options as an empty preference."""
    value = entry.options.get(HIDDEN_AREA_IDS)
    if not isinstance(value, list):
        return set()
    return {item for item in value if isinstance(item, str) and item and item == item.strip()}


def _key_lists(entry: ConfigEntry, field: str) -> dict[str, list[str]]:
    """Copy valid saved preferences; malformed legacy values never escape to clients."""
    value = entry.options.get(field)
    if not isinstance(value, dict):
        return {}
    return {
        area_id: list(keys)
        for area_id, keys in value.items()
        if isinstance(area_id, str) and area_id and area_id == area_id.strip()
        and area_id != "__easy_hass_unassigned__" and isinstance(keys, list)
        and all(isinstance(key, str) and _ASSIGNMENT_KEY.fullmatch(key) for key in keys)
        and len(keys) == len(set(keys))
    }


def _snapshot(entry: ConfigEntry) -> dict[str, Any]:
    return {HIDDEN_AREA_IDS: sorted(_hidden_ids(entry)),
            ROOM_DEVICE_ORDER: _key_lists(entry, ROOM_DEVICE_ORDER),
            ROOM_DEVICE_LINKS: _key_lists(entry, ROOM_DEVICE_LINKS)}


@callback
def async_activate(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Register once, then activate this successfully loaded integration entry."""
    state: _Settings | None = hass.data.get(_DATA_SETTINGS)
    if state is None:
        state = hass.data[_DATA_SETTINGS] = _Settings()
        websocket_api.async_register_command(hass, websocket_get)
        websocket_api.async_register_command(hass, websocket_set_visibility)
        websocket_api.async_register_command(hass, websocket_set_device_order)
        websocket_api.async_register_command(hass, websocket_set_device_link)
        websocket_api.async_register_command(hass, websocket_set_device_assignment)
        websocket_api.async_register_command(hass, websocket_subscribe)
    state.entry = entry
    async_dispatcher_send(hass, _SIGNAL_SETTINGS, _snapshot(entry))


@callback
def async_deactivate(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Keep process-wide WS commands, but reject requests while unloaded."""
    state: _Settings | None = hass.data.get(_DATA_SETTINGS)
    if state is not None and state.entry is entry:
        state.entry = None


def _active_entry(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg_id: int,
) -> ConfigEntry | None:
    state: _Settings | None = hass.data.get(_DATA_SETTINGS)
    if state is None or state.entry is None:
        connection.send_error(msg_id, "not_loaded", "EasyHASS is not loaded.")
        return None
    return state.entry


@websocket_api.websocket_command({probatio.Required("type"): "easy_hass/settings/get"})
@callback
def websocket_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Read preferences for any authenticated Home Assistant user."""
    if (entry := _active_entry(hass, connection, msg["id"])) is not None:
        connection.send_result(msg["id"], _snapshot(entry))


@websocket_api.websocket_command(
    {
        probatio.Required("type"): "easy_hass/room_visibility/set",
        probatio.Required("area_id"): str,
        probatio.Required("hidden"): bool,
    }
)
@websocket_api.require_admin
@callback
def websocket_set_visibility(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Merge one area atomically on HA's event loop; never edit the HA area."""
    if (entry := _active_entry(hass, connection, msg["id"])) is None:
        return
    registry = area_registry.async_get(hass)
    area_id = msg["area_id"]
    if registry.async_get_area(area_id) is None:
        connection.send_error(msg["id"], "not_found", "Area ID does not exist.")
        return
    # Prune deleted references while retaining every other current preference.
    hidden = {item for item in _hidden_ids(entry) if registry.async_get_area(item)}
    if msg["hidden"]:
        hidden.add(area_id)
    else:
        hidden.discard(area_id)
    options = {**entry.options, HIDDEN_AREA_IDS: sorted(hidden)}
    changed = hass.config_entries.async_update_entry(entry, options=options)
    snapshot = _snapshot(entry)
    connection.send_result(msg["id"], snapshot)
    if changed:
        async_dispatcher_send(hass, _SIGNAL_SETTINGS, snapshot)


def _relevant_entity(entry: Any) -> bool:
    return bool(entry and not entry.hidden_by and not entry.disabled_by
                and not entry.entity_category and entry.domain not in _EXCLUDED_DOMAINS)


def _entity_in_area(
    entity_id: str, area_id: str,
    entities: entity_registry.EntityRegistry, devices: device_registry.DeviceRegistry,
) -> bool:
    """Use the entity's native effective area, never its group members' areas."""
    entry = entities.async_get(entity_id)
    device = devices.async_get(entry.device_id) if entry and entry.device_id else None
    return bool(entry and (entry.area_id or (device.area_id if device else None)) == area_id)


def _assignment_entry(hass: HomeAssistant, key: str) -> Any:
    """Only writable physical devices or visible independent controls/groups."""
    kind, item_id = key.split(":", 1)
    if kind == "device":
        item = device_registry.async_get(hass).async_get(item_id, include_composite_devices=False)
        return item if item and not item.disabled_by else None
    item = entity_registry.async_get(hass).async_get(item_id)
    return item if _relevant_entity(item) and not item.device_id else None


def _assignment_in_area(hass: HomeAssistant, key: str, area_id: str, linked_keys: set[str]) -> bool:
    devices = device_registry.async_get(hass)
    entities = entity_registry.async_get(hass)
    if (item := _assignment_entry(hass, key)) is None:
        return False
    if key in linked_keys:
        return True
    kind, item_id = key.split(":", 1)
    if kind == "device":
        device = devices.async_get(item_id, include_composite_devices=False)
        if device is None or device.disabled_by:
            return False
        if device.area_id == area_id:
            return True
        # A visible function can explicitly belong to another room. Its device
        # stays sortable there without changing that function's native override.
        return any(_relevant_entity(entry) and _entity_in_area(
            entry.entity_id, area_id, entities, devices
        ) for entry in entity_registry.async_entries_for_device(entities, item_id))
    entry = entities.async_get(item_id)
    return bool(_relevant_entity(entry) and not entry.device_id
                and _entity_in_area(item_id, area_id, entities, devices))


@websocket_api.websocket_command({
    probatio.Required("type"): "easy_hass/room_device_order/set",
    probatio.Required("area_id"): str,
    probatio.Required("keys"): [str],
})
@websocket_api.require_admin
@callback
def websocket_set_device_order(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any],
) -> None:
    """Atomically merge one room's order, independently of native assignments."""
    if (entry := _active_entry(hass, connection, msg["id"])) is None:
        return
    area_id, keys = msg["area_id"], msg["keys"]
    if area_registry.async_get(hass).async_get_area(area_id) is None:
        connection.send_error(msg["id"], "not_found", "Der ausgewählte Raum existiert nicht mehr.")
        return
    if len(keys) != len(set(keys)) or any(not _ASSIGNMENT_KEY.fullmatch(key) for key in keys):
        connection.send_error(msg["id"], "invalid_format", "Die Gerätereihenfolge enthält ungültige oder doppelte Einträge.")
        return
    linked_keys = {key for key in _key_lists(entry, ROOM_DEVICE_LINKS).get(area_id, []) if _assignment_entry(hass, key)}
    if any(not _assignment_in_area(hass, key, area_id, linked_keys) for key in keys):
        connection.send_error(msg["id"], "not_found", "Ein Gerät existiert nicht mehr oder gehört nicht mehr zu diesem Raum.")
        return
    orders = _key_lists(entry, ROOM_DEVICE_ORDER)
    if keys:
        orders[area_id] = list(keys)
    else:
        orders.pop(area_id, None)
    changed = hass.config_entries.async_update_entry(entry, options={**entry.options, ROOM_DEVICE_ORDER: orders})
    snapshot = _snapshot(entry)
    connection.send_result(msg["id"], snapshot)
    if changed:
        async_dispatcher_send(hass, _SIGNAL_SETTINGS, snapshot)


def _remove_link(links: dict[str, list[str]], area_id: str | None, key: str) -> None:
    if area_id not in links:
        return
    remaining = [item for item in links[area_id] if item != key]
    if remaining:
        links[area_id] = remaining
    else:
        links.pop(area_id)


@websocket_api.websocket_command({
    probatio.Required("type"): "easy_hass/room_device_link/set",
    probatio.Required("area_id"): str,
    probatio.Required("key"): str,
    probatio.Required("linked"): bool,
})
@websocket_api.require_admin
@callback
def websocket_set_device_link(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any],
) -> None:
    """Merge one display reference without changing any native area assignment."""
    if (entry := _active_entry(hass, connection, msg["id"])) is None:
        return
    area_id, key = msg["area_id"], msg["key"]
    if not _ASSIGNMENT_KEY.fullmatch(key):
        connection.send_error(msg["id"], "invalid_format", "Bitte ein registriertes Gerät auswählen.")
        return
    if area_registry.async_get(hass).async_get_area(area_id) is None:
        connection.send_error(msg["id"], "not_found", "Der ausgewählte Raum existiert nicht mehr.")
        return
    links = _key_lists(entry, ROOM_DEVICE_LINKS)
    if msg["linked"]:
        if (item := _assignment_entry(hass, key)) is None:
            connection.send_error(msg["id"], "not_found", "Das ausgewählte Gerät existiert nicht mehr oder kann hier nicht angezeigt werden.")
            return
        if item.area_id == area_id:
            connection.send_error(msg["id"], "conflict", "Das Gerät ist diesem Raum inzwischen bereits zugeordnet.")
            return
        current = links.setdefault(area_id, [])
        if key not in current:
            current.append(key)
    else:
        # A disappeared/disabled item must still be removable from saved links.
        _remove_link(links, area_id, key)
    changed = hass.config_entries.async_update_entry(entry, options={**entry.options, ROOM_DEVICE_LINKS: links})
    snapshot = _snapshot(entry)
    connection.send_result(msg["id"], snapshot)
    if changed:
        async_dispatcher_send(hass, _SIGNAL_SETTINGS, snapshot)


@websocket_api.websocket_command({
    probatio.Required("type"): "easy_hass/room_device_assignment/set",
    probatio.Required("area_id"): probatio.Any(str, None),
    probatio.Required("key"): str,
    probatio.Required("expected_area_id"): probatio.Any(str, None),
})
@websocket_api.require_admin
@callback
def websocket_set_device_assignment(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any],
) -> None:
    """Compare and move in one event-loop callback, retaining HA entity overrides."""
    if (entry := _active_entry(hass, connection, msg["id"])) is None:
        return
    area_id, key = msg["area_id"], msg["key"]
    if not _ASSIGNMENT_KEY.fullmatch(key):
        connection.send_error(msg["id"], "invalid_format", "Bitte ein registriertes Gerät auswählen.")
        return
    if area_id is not None and area_registry.async_get(hass).async_get_area(area_id) is None:
        connection.send_error(msg["id"], "not_found", "Der ausgewählte Raum existiert nicht mehr.")
        return
    if (item := _assignment_entry(hass, key)) is None:
        connection.send_error(msg["id"], "not_found", "Das ausgewählte Gerät existiert nicht mehr oder kann hier nicht zugeordnet werden.")
        return
    previous_area = item.area_id
    if previous_area != msg["expected_area_id"]:
        connection.send_error(msg["id"], "conflict", "Die Raumzuordnung hat sich inzwischen geändert. Bitte erneut auswählen.")
        return
    kind, item_id = key.split(":", 1)
    try:
        if kind == "entity":
            entity_registry.async_get(hass).async_update_entity(item_id, area_id=area_id)
        elif isinstance(item, device_registry.ChildDeviceEntry):
            device_registry.async_get(hass).async_update_child_device(item_id, area_id=area_id)
        else:
            device_registry.async_get(hass).async_update_device(item_id, area_id=area_id)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_info", str(err))
        return
    # External native moves can leave a redundant old-room link. Prune it too,
    # so removing a native assignment cannot resurrect it as an additional one.
    links = _key_lists(entry, ROOM_DEVICE_LINKS)
    _remove_link(links, previous_area, key)
    _remove_link(links, area_id, key)
    changed = hass.config_entries.async_update_entry(entry, options={**entry.options, ROOM_DEVICE_LINKS: links})
    snapshot = _snapshot(entry)
    connection.send_result(msg["id"], snapshot)
    if changed:
        async_dispatcher_send(hass, _SIGNAL_SETTINGS, snapshot)


@websocket_api.websocket_command(
    {probatio.Required("type"): "easy_hass/settings/subscribe"}
)
@callback
def websocket_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Send the initial snapshot and future updates until normal WS unsubscribe."""
    if (entry := _active_entry(hass, connection, msg["id"])) is None:
        return

    @callback
    def updated(snapshot: dict[str, Any]) -> None:
        connection.send_event(msg["id"], snapshot)

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(
        hass, _SIGNAL_SETTINGS, updated
    )
    connection.send_result(msg["id"])
    connection.send_event(msg["id"], _snapshot(entry))
