"""Backend tests using real Home Assistant 2026.10.2 classes.

Run from the repository root after installing requirements-python-test.txt:
    .venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v

No running Home Assistant, device connection, or HTTP socket is required.
"""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import MappingProxyType
import unittest
from unittest.mock import patch

from homeassistant import loader
from homeassistant.components import frontend
from homeassistant.components.http.cors import setup_cors
from homeassistant.components.http.server import HomeAssistantHTTP
from homeassistant.config_entries import ConfigEntries, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import AbortFlow, FlowResultType
from homeassistant.exceptions import ConfigEntryError

from custom_components.easy_hass import async_setup_entry, async_unload_entry
from custom_components.easy_hass.config_flow import EasyHassConfigFlow
from custom_components.easy_hass.const import (
    DOMAIN,
    BUILD_METADATA_FILE,
    MODULE_FILE,
    NAME,
    PANEL_ELEMENT,
    PANEL_PATH,
    STATIC_URL,
)


def make_entry(unique_id=DOMAIN, options=None):
    """Construct a real config entry without starting HA bootstrap."""
    return ConfigEntry(
        data={},
        discovery_keys=MappingProxyType({}),
        domain=DOMAIN,
        minor_version=1,
        options=options or {},
        source="user",
        subentries_data=None,
        title=NAME,
        unique_id=unique_id,
        version=1,
    )


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    """Exercise the actual panel registry and HTTP route registration."""

    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.build_directory = Path(self.directory.name) / "frontend"
        self.write_build("a" * 64)
        self.frontend_patch = patch(
            "custom_components.easy_hass.FRONTEND_DIRECTORY", self.build_directory
        )
        self.frontend_patch.start()
        self.hass = HomeAssistant(self.directory.name)
        self.hass.config_entries = ConfigEntries(self.hass, {})
        self.hass.http = HomeAssistantHTTP(
            self.hass,
            ssl_certificate=None,
            ssl_peer_certificate=None,
            ssl_key=None,
            server_host=["127.0.0.1"],
            server_port=0,
            trusted_proxies=[],
            ssl_profile="intermediate",
        )
        setup_cors(self.hass.http.app, [])
        self.entry = make_entry()

    async def asyncTearDown(self):
        await self.hass.async_stop(force=True)
        self.frontend_patch.stop()
        self.directory.cleanup()

    def write_build(self, revision):
        self.metadata = {
            "schema_version": 1,
            "revision": revision,
            "entry": f"builds/{revision}/{MODULE_FILE}",
            "files": [MODULE_FILE],
        }
        entry = self.build_directory / self.metadata["entry"]
        entry.parent.mkdir(parents=True, exist_ok=True)
        entry.write_text("export const testBuild = true;\n")
        (self.build_directory / BUILD_METADATA_FILE).write_text(json.dumps(self.metadata))

    @property
    def module_url(self):
        return f"{STATIC_URL}/{self.metadata['entry']}"

    def make_flow(self):
        flow = EasyHassConfigFlow()
        flow.hass = self.hass
        flow.handler = DOMAIN
        flow.context = {"source": "user"}
        return flow

    async def test_manifest_is_visible_in_add_integration_picker(self):
        # Exercise HA's real manifest discovery and the metadata endpoint used by
        # the picker. A working config flow alone does not guarantee visibility:
        # integration_type="system" is deliberately omitted by HA.
        loader.async_setup(self.hass)
        descriptions = await loader.async_get_integration_descriptions(self.hass)
        integrations = descriptions["custom"]["integration"]
        self.assertIn(DOMAIN, integrations)
        self.assertTrue(integrations[DOMAIN]["config_flow"])
        self.assertEqual(integrations[DOMAIN]["name"], NAME)
        self.assertTrue(integrations[DOMAIN]["single_config_entry"])

        # Reproduce the alpha.1 regression in memory without changing any files.
        discovered = await loader.async_get_custom_components(self.hass)
        current = discovered[DOMAIN]
        legacy_integration = loader.Integration(
            self.hass,
            current.pkg_path,
            current.file_path,
            {**current.manifest, "integration_type": "system"},
        )
        with patch.dict(discovered, {DOMAIN: legacy_integration}):
            legacy = await loader.async_get_integration_descriptions(self.hass)
        self.assertNotIn(DOMAIN, legacy["custom"]["integration"])

    async def test_setup_unload_reload_reuses_static_routes(self):
        self.assertTrue(await async_setup_entry(self.hass, self.entry))
        panel = self.hass.data[frontend.DATA_PANELS][PANEL_PATH]
        self.assertFalse(panel.require_admin)
        self.assertEqual(panel.sidebar_title, NAME)
        self.assertEqual(panel.config["_panel_custom"]["name"], PANEL_ELEMENT)
        self.assertEqual(panel.config["_panel_custom"]["module_url"], self.module_url)
        self.assertFalse(panel.config["_panel_custom"]["embed_iframe"])
        routes = tuple(self.hass.http.app.router.routes())
        self.assertTrue(routes)
        commands = self.hass.data["websocket_api"].copy()
        self.assertIn("easy_hass/settings/get", commands)
        self.assertIn("easy_hass/room_visibility/set", commands)
        self.assertIn("easy_hass/settings/subscribe", commands)

        self.assertTrue(await async_unload_entry(self.hass, self.entry))
        self.assertFalse(frontend.async_panel_exists(self.hass, PANEL_PATH))
        self.assertTrue(await async_setup_entry(self.hass, self.entry))
        self.assertEqual(tuple(self.hass.http.app.router.routes()), routes)
        self.assertEqual(self.hass.data["websocket_api"], commands)

    async def test_changed_build_reload_updates_graph_url_without_duplicate_route(self):
        await async_setup_entry(self.hass, self.entry)
        before = self.hass.data[frontend.DATA_PANELS][PANEL_PATH]
        routes = tuple(self.hass.http.app.router.routes())
        await async_unload_entry(self.hass, self.entry)
        self.write_build("b" * 64)
        await async_setup_entry(self.hass, self.entry)
        after = self.hass.data[frontend.DATA_PANELS][PANEL_PATH]
        self.assertNotEqual(
            before.config["_panel_custom"]["module_url"],
            after.config["_panel_custom"]["module_url"],
        )
        self.assertEqual(after.config["_panel_custom"]["module_url"], self.module_url)
        self.assertEqual(tuple(self.hass.http.app.router.routes()), routes)

    async def test_invalid_metadata_never_registers_routes_or_panel(self):
        invalid = [
            "{not json",
            json.dumps({**self.metadata, "entry": "../../secret.js"}),
            json.dumps({**self.metadata, "revision": "not-a-fingerprint"}),
            json.dumps({**self.metadata, "schema_version": 99}),
        ]
        for contents in invalid:
            with self.subTest(contents=contents):
                (self.build_directory / BUILD_METADATA_FILE).write_text(contents)
                with self.assertRaises(ConfigEntryError):
                    await async_setup_entry(self.hass, self.entry)
                self.assertFalse(tuple(self.hass.http.app.router.routes()))
                self.assertFalse(frontend.async_panel_exists(self.hass, PANEL_PATH))

    async def test_metadata_without_entry_file_is_rejected(self):
        (self.build_directory / self.metadata["entry"]).unlink()
        with self.assertRaises(ConfigEntryError):
            await async_setup_entry(self.hass, self.entry)
        self.assertFalse(tuple(self.hass.http.app.router.routes()))
        self.assertFalse(frontend.async_panel_exists(self.hass, PANEL_PATH))

    async def test_panel_collision_preserves_existing_panel(self):
        frontend.async_register_built_in_panel(
            self.hass, "other", frontend_url_path=PANEL_PATH
        )
        other = self.hass.data[frontend.DATA_PANELS][PANEL_PATH]
        with self.assertRaises(ConfigEntryError):
            await async_setup_entry(self.hass, self.entry)
        self.assertIs(self.hass.data[frontend.DATA_PANELS][PANEL_PATH], other)
        self.assertFalse(tuple(self.hass.http.app.router.routes()))

    async def test_unload_does_not_remove_a_replacement_panel(self):
        await async_setup_entry(self.hass, self.entry)
        frontend.async_remove_panel(self.hass, PANEL_PATH)
        frontend.async_register_built_in_panel(
            self.hass, "other", frontend_url_path=PANEL_PATH
        )
        other = self.hass.data[frontend.DATA_PANELS][PANEL_PATH]
        await async_unload_entry(self.hass, self.entry)
        self.assertIs(self.hass.data[frontend.DATA_PANELS][PANEL_PATH], other)

    async def test_unload_is_idempotent_and_checks_entry_ownership(self):
        await async_setup_entry(self.hass, self.entry)
        await async_unload_entry(self.hass, make_entry("unrelated"))
        self.assertTrue(frontend.async_panel_exists(self.hass, PANEL_PATH))
        self.assertTrue(await async_unload_entry(self.hass, self.entry))
        self.assertTrue(await async_unload_entry(self.hass, self.entry))

    async def test_missing_frontend_does_not_register_anything(self):
        with patch(
            "custom_components.easy_hass.FRONTEND_DIRECTORY",
            Path(self.directory.name),
        ):
            with self.assertRaises(ConfigEntryError):
                await async_setup_entry(self.hass, self.entry)
        self.assertFalse(frontend.async_panel_exists(self.hass, PANEL_PATH))
        self.assertFalse(tuple(self.hass.http.app.router.routes()))

    async def test_config_flow_confirms_without_connection_parameters(self):
        flow = self.make_flow()
        form = await flow.async_step_user()
        self.assertEqual(form["type"], FlowResultType.FORM)
        self.assertIsNone(form["data_schema"])
        result = await flow.async_step_user({})
        self.assertEqual(result["type"], FlowResultType.CREATE_ENTRY)
        self.assertEqual(result["title"], NAME)
        self.assertEqual(result["data"], {})
        self.assertEqual(flow.unique_id, DOMAIN)

    async def test_config_flow_rejects_second_instance(self):
        # Populate the real registry without triggering bootstrap or disk saves.
        self.hass.config_entries._entries[self.entry.entry_id] = self.entry
        with self.assertRaises(AbortFlow) as raised:
            await self.make_flow().async_step_user()
        self.assertEqual(raised.exception.reason, "already_configured")


if __name__ == "__main__":
    unittest.main()
