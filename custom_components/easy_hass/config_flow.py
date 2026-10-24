"""Set up the Easy-Hass panel from the Home Assistant UI."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN, NAME


class EasyHassConfigFlow(ConfigFlow, domain=DOMAIN):
    """A single local panel with no connection parameters."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm installation of the panel."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title=NAME, data={})

        return self.async_show_form(step_id="user")
