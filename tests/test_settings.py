"""Visibility WS tests with real HA schemas, connections, registry and storage.

Each test has an isolated HomeAssistant instance and temporary config directory.
No running HA websocket, token, production entry or device is touched.
"""

import json
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from homeassistant.auth.models import User
from homeassistant.auth.permissions import PermissionLookup
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api.commands import handle_unsubscribe_events
from homeassistant.components.websocket_api.connection import ActiveConnection
from homeassistant.config_entries import ConfigEntries
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry, device_registry, entity_registry

from custom_components.easy_hass.settings import async_activate, async_deactivate
from test_integration import make_entry


class SettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.hass = HomeAssistant(self.directory.name)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        self.entry = make_entry(options={"unrelated": {"preserved": True}})
        self.hass.config_entries._entries[self.entry.entry_id] = self.entry
        await area_registry.async_load(self.hass)
        device_registry.async_setup(self.hass)
        await device_registry.async_load(self.hass)
        await entity_registry.async_load(self.hass)
        self.registry = area_registry.async_get(self.hass)
        self.devices = device_registry.async_get(self.hass)
        self.entities = entity_registry.async_get(self.hass)
        self.first = self.registry.async_create("First room", picture="/local/first.jpg")
        self.second = self.registry.async_create("Empty room")
        self.connections = []
        async_activate(self.hass, self.entry)
        websocket_api.async_register_command(self.hass, handle_unsubscribe_events)
        self.admin, self.admin_messages = self.connect(admin=True)
        self.reader, self.reader_messages = self.connect(admin=False)

    async def asyncTearDown(self):
        for connection in self.connections:
            for unsubscribe in list(connection.subscriptions.values()):
                unsubscribe()
            connection.subscriptions.clear()
        await self.hass.async_stop(force=True)
        self.directory.cleanup()

    def connect(self, *, admin):
        messages = []

        def received(message):
            messages.append(message if isinstance(message, dict) else json.loads(message))

        user = User(
            name="Isolated settings test", perm_lookup=PermissionLookup(None, None),
            is_owner=admin, is_active=True,
        )
        connection = ActiveConnection(
            logging.getLogger(__name__), self.hass, received, user, None, None
        )
        self.connections.append(connection)
        return connection, messages

    async def request(self, connection, type_, **payload):
        msg_id = connection.last_id + 1
        connection.async_handle({"id": msg_id, "type": type_, **payload})
        await self.hass.async_block_till_done()
        return msg_id

    async def set_hidden(self, area_id, hidden, connection=None):
        return await self.request(
            connection or self.admin, "easy_hass/room_visibility/set",
            area_id=area_id, hidden=hidden,
        )

    async def set_order(self, area_id, keys, connection=None):
        return await self.request(connection or self.admin, "easy_hass/room_device_order/set", area_id=area_id, keys=keys)

    def device(self, name, area_id=None):
        device = self.devices.async_get_or_create(
            config_entry_id=self.entry.entry_id, identifiers={("test", name)}, name=name,
        )
        return self.devices.async_update_device(device.id, area_id=area_id)

    def entity(self, domain, name, *, device=None, area_id=None, hidden=False):
        entry = self.entities.async_get_or_create(domain, "test", name,
            suggested_object_id=name, device_id=device.id if device else None,
            original_name=name, has_entity_name=True,
            hidden_by=entity_registry.RegistryEntryHider.USER if hidden else None,
        )
        return self.entities.async_update_entity(entry.entity_id, area_id=area_id)

    async def test_authenticated_reader_gets_defaults_but_cannot_write(self):
        await self.request(self.reader, "easy_hass/settings/get")
        self.assertEqual(self.reader_messages[-1]["result"], {"hidden_area_ids": [], "room_device_order": {}})
        before = dict(self.entry.options)
        await self.set_hidden(self.first.id, True, self.reader)
        self.assertFalse(self.reader_messages[-1]["success"])
        self.assertEqual(self.reader_messages[-1]["error"]["code"], "unauthorized")
        self.assertEqual(dict(self.entry.options), before)

    async def test_single_area_changes_merge_and_preserve_registry_and_other_options(self):
        original_areas = tuple(self.registry.async_list_areas())
        other_admin, messages = self.connect(admin=True)
        # Same-loop writes have no await between reading options and updating.
        self.admin.async_handle({"id": 1, "type": "easy_hass/room_visibility/set", "area_id": self.first.id, "hidden": True})
        other_admin.async_handle({"id": 1, "type": "easy_hass/room_visibility/set", "area_id": self.second.id, "hidden": True})
        await self.hass.async_block_till_done()
        self.assertEqual(self.entry.options["hidden_area_ids"], sorted([self.first.id, self.second.id]))
        self.assertEqual(messages[-1]["result"], {"hidden_area_ids": sorted([self.first.id, self.second.id]), "room_device_order": {}})
        await self.set_hidden(self.first.id, False)
        self.assertEqual(self.entry.options["hidden_area_ids"], [self.second.id])
        self.assertEqual(self.entry.options["unrelated"], {"preserved": True})
        self.assertEqual(tuple(self.registry.async_list_areas()), original_areas)
        self.assertIs(self.registry.async_get_area(self.first.id), self.first)

    async def test_options_are_saved_to_ha_storage_and_restored_on_reactivation(self):
        await self.set_hidden(self.first.id, True)
        # Flush the genuine HA store to the isolated directory, without waiting
        # for its debounce timer or touching the running HA's config directory.
        await self.hass.config_entries._store.async_save(self.hass.config_entries._data_to_save())
        saved = json.loads((Path(self.directory.name) / ".storage/core.config_entries").read_text())
        options = saved["data"]["entries"][0]["options"]
        self.assertEqual(options, {"unrelated": {"preserved": True}, "hidden_area_ids": [self.first.id]})
        async_deactivate(self.hass, self.entry)
        restored = make_entry(options=options)
        async_activate(self.hass, restored)
        await self.request(self.reader, "easy_hass/settings/get")
        self.assertEqual(self.reader_messages[-1]["result"], {"hidden_area_ids": [self.first.id], "room_device_order": {}})

    async def test_subscription_has_initial_snapshot_crossclient_updates_and_real_unsubscribe(self):
        subscription = await self.request(self.reader, "easy_hass/settings/subscribe")
        self.assertEqual(self.reader_messages[-2], {"id": subscription, "type": "result", "success": True, "result": None})
        self.assertEqual(self.reader_messages[-1], {"id": subscription, "type": "event", "event": {"hidden_area_ids": [], "room_device_order": {}}})
        await self.set_hidden(self.first.id, True)
        self.assertEqual(self.reader_messages[-1]["event"], {"hidden_area_ids": [self.first.id], "room_device_order": {}})
        events = len(self.reader_messages)
        await self.set_hidden(self.first.id, True)
        self.assertEqual(len(self.reader_messages), events, "an unchanged setting emits no duplicate event")
        await self.request(self.reader, "unsubscribe_events", subscription=subscription)
        events = len(self.reader_messages)
        await self.set_hidden(self.first.id, False)
        self.assertEqual(len(self.reader_messages), events)

    async def test_unknown_synthetic_or_malformed_requests_never_write(self):
        before = dict(self.entry.options)
        for area_id in ("missing", "__easy_hass_unassigned__", "", f" {self.first.id}"):
            await self.set_hidden(area_id, True)
            self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")
        for hidden in ("false", "true", 0, 1, None):
            await self.set_hidden(self.first.id, hidden)
            self.assertEqual(self.admin_messages[-1]["error"]["code"], "invalid_format")
        await self.request(self.admin, "easy_hass/room_visibility/set", area_id=self.first.id)
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "invalid_format")
        await self.request(self.admin, "easy_hass/room_visibility/set", area_id=self.first.id, hidden=True, other="unexpected")
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "invalid_format")
        self.assertEqual(dict(self.entry.options), before)

    async def test_unloaded_commands_reject_and_reload_retains_commands_and_subscription(self):
        await self.request(self.reader, "easy_hass/settings/subscribe")
        async_deactivate(self.hass, make_entry("unrelated"))
        await self.request(self.reader, "easy_hass/settings/get")
        self.assertTrue(self.reader_messages[-1]["success"])
        async_deactivate(self.hass, self.entry)
        for type_, payload in (
            ("easy_hass/settings/get", {}),
            ("easy_hass/settings/subscribe", {}),
            ("easy_hass/room_visibility/set", {"area_id": self.first.id, "hidden": True}),
            ("easy_hass/room_device_order/set", {"area_id": self.first.id, "keys": []}),
        ):
            await self.request(self.admin, type_, **payload)
            self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_loaded")
        with patch.object(websocket_api, "async_register_command", wraps=websocket_api.async_register_command) as register:
            async_activate(self.hass, self.entry)
            register.assert_not_called()
        await self.hass.async_block_till_done()
        self.assertEqual(self.reader_messages[-1]["type"], "event")
        await self.set_hidden(self.first.id, True)
        self.assertEqual(self.reader_messages[-1]["event"], {"hidden_area_ids": [self.first.id], "room_device_order": {}})

    async def test_removed_references_are_pruned_without_overwriting_other_options(self):
        self.hass.config_entries.async_update_entry(self.entry, options={
            **self.entry.options, "hidden_area_ids": ["deleted_room", self.second.id, self.second.id, None],
        })
        await self.set_hidden(self.first.id, True)
        self.assertEqual(self.entry.options["hidden_area_ids"], sorted([self.first.id, self.second.id]))
        self.assertEqual(self.entry.options["unrelated"], {"preserved": True})

    async def test_device_order_merges_rooms_and_visibility_and_reset_removes_only_one(self):
        first = self.device("Light", self.first.id)
        second = self.device("Sensor", self.second.id)
        self.entity("sensor", "temperature", device=second)
        first_keys, second_keys = [f"device:{first.id}"], [f"device:{second.id}"]
        other_admin, _ = self.connect(admin=True)
        self.admin.async_handle({"id": 1, "type": "easy_hass/room_device_order/set", "area_id": self.first.id, "keys": first_keys})
        other_admin.async_handle({"id": 1, "type": "easy_hass/room_device_order/set", "area_id": self.second.id, "keys": second_keys})
        await self.hass.async_block_till_done()
        self.assertTrue(self.admin_messages[-1]["success"])
        await self.set_hidden(self.first.id, True)
        self.assertEqual(self.entry.options["room_device_order"], {self.first.id: first_keys, self.second.id: second_keys})
        await self.set_order(self.first.id, [])
        self.assertEqual(self.entry.options["room_device_order"], {self.second.id: second_keys})
        self.assertEqual(self.entry.options["hidden_area_ids"], [self.first.id])
        self.assertEqual(self.entry.options["unrelated"], {"preserved": True})
        self.assertIs(self.devices.async_get(first.id), first)
        self.assertIs(self.devices.async_get(second.id), second)

    async def test_device_order_permissions_subscription_idempotence_and_persistence(self):
        device = self.device("Stored", self.first.id)
        keys = [f"device:{device.id}"]
        await self.request(self.reader, "easy_hass/settings/subscribe")
        await self.set_order(self.first.id, keys, self.reader)
        self.assertEqual(self.reader_messages[-1]["error"]["code"], "unauthorized")
        await self.set_order(self.first.id, keys)
        self.assertEqual(self.reader_messages[-1]["event"]["room_device_order"], {self.first.id: keys})
        count = len(self.reader_messages)
        await self.set_order(self.first.id, keys)
        self.assertEqual(len(self.reader_messages), count)
        await self.hass.config_entries._store.async_save(self.hass.config_entries._data_to_save())
        stored = json.loads((Path(self.directory.name) / ".storage/core.config_entries").read_text())
        options = stored["data"]["entries"][0]["options"]
        self.assertEqual(options["room_device_order"], {self.first.id: keys})
        async_deactivate(self.hass, self.entry)
        async_activate(self.hass, make_entry(options=options))
        await self.request(self.reader, "easy_hass/settings/get")
        self.assertEqual(self.reader_messages[-1]["result"]["room_device_order"], {self.first.id: keys})

    async def test_device_order_rejects_stale_foreign_hidden_disabled_and_malformed_keys_without_writes(self):
        device = self.device("Foreign", self.second.id)
        sensor = self.entity("sensor", "raw_sensor", area_id=self.first.id)
        hidden = self.entity("light", "hidden", area_id=self.first.id, hidden=True)
        disabled = self.entity("light", "disabled", area_id=self.first.id)
        self.entities.async_update_entity(disabled.entity_id, disabled_by=entity_registry.RegistryEntryDisabler.USER)
        bound = self.entity("light", "bound", device=device, area_id=self.first.id)
        before = dict(self.entry.options)
        for keys in (["device:deleted"], [f"entity:{sensor.entity_id}"], [f"entity:{hidden.entity_id}"],
                     [f"entity:{disabled.entity_id}"], [f"entity:{bound.entity_id}"]):
            await self.set_order(self.first.id, keys)
            self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found", keys)
        # A control override legitimately gives this device scope in First room.
        # A different native-only device still cannot be ordered there.
        foreign = self.device("Other foreign", self.second.id)
        await self.set_order(self.first.id, [f"device:{foreign.id}"])
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")
        for keys in (["device:x", "device:x"], ["bad"], ["entity:bad"], ["device: x"], [None], "not-a-list"):
            await self.set_order(self.first.id, keys)
            self.assertEqual(self.admin_messages[-1]["error"]["code"], "invalid_format", keys)
        await self.set_order("deleted", [])
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")
        self.assertEqual(dict(self.entry.options), before)

    async def test_order_supports_entity_overrides_and_recursive_hidden_group_members_without_mutating_them(self):
        device = self.device("Overridden", self.first.id)
        member = self.entity("light", "member", device=device, area_id=self.second.id)
        hidden = self.entity("group", "nested", hidden=True)
        outer = self.entity("group", "outer")
        self.hass.states.async_set(hidden.entity_id, "on", {"entity_id": [member.entity_id, outer.entity_id]})
        self.hass.states.async_set(outer.entity_id, "unavailable", {"entity_id": [hidden.entity_id]})
        keys = [f"entity:{outer.entity_id}", f"device:{device.id}"]
        await self.set_order(self.second.id, keys)
        self.assertTrue(self.admin_messages[-1]["success"])
        self.assertEqual(self.entry.options["room_device_order"], {self.second.id: keys})
        self.assertIs(self.devices.async_get(device.id), device)
        self.assertIs(self.entities.async_get(member.entity_id), member)
        self.assertIsNone(self.entities.async_get(outer.entity_id).area_id)
        self.entities.async_update_entity(member.entity_id, hidden_by=entity_registry.RegistryEntryHider.USER)
        await self.set_order(self.second.id, [f"entity:{outer.entity_id}"])
        self.assertTrue(self.admin_messages[-1]["success"], "hidden member still supplies group scope")
        self.entities.async_update_entity(outer.entity_id, hidden_by=entity_registry.RegistryEntryHider.USER)
        before = dict(self.entry.options)
        await self.set_order(self.second.id, [f"entity:{outer.entity_id}"])
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")
        self.assertEqual(dict(self.entry.options), before)

    async def test_order_is_revalidated_when_a_device_moves_or_disappears(self):
        device = self.device("Moving", self.first.id)
        keys = [f"device:{device.id}"]
        await self.set_order(self.first.id, keys)
        self.assertTrue(self.admin_messages[-1]["success"])
        self.devices.async_update_device(device.id, area_id=self.second.id)
        before = dict(self.entry.options)
        await self.set_order(self.first.id, keys)
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")
        self.assertEqual(dict(self.entry.options), before)
        self.devices.async_remove_device(device.id)
        await self.set_order(self.second.id, keys)
        self.assertEqual(self.admin_messages[-1]["error"]["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
