/** Real HA integration test: registries, event stream, services and panel. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { LocalHA, baseUrl } from './ha-client.mjs';

const ha = await LocalHA.open();
const results = [];
const events = [];
let temporaryArea;
let movedEntity;
const restore = [];
const check = (name, condition, detail) => {
  assert.ok(condition, name);
  results.push({ name, pass: true, ...(detail ? { detail } : {}) });
};
const states = () => ha.call('get_states').then((items) => Object.fromEntries(items.map((item) => [item.entity_id, item])));

try {
  const [areas, devices, entities, panels, config] = await Promise.all([
    ha.call('config/area_registry/list'), ha.call('config/device_registry/list'),
    ha.call('config/entity_registry/list'), ha.call('get_panels'), ha.call('get_config'),
  ]);
  const find = (suffix) => {
    const item = entities.find((entity) => entity.unique_id === `easy_hass_test_${suffix}`);
    assert.ok(item, `Fixture ${suffix} exists in actual HA entity registry`);
    return item;
  };
  const light = find('living_light');
  const onoff = find('living_onoff');
  const cover = find('living_cover');
  const vacuum = find('hall_vacuum');
  const fixtureEntities = entities.filter((entity) => entity.platform === 'easy_hass_fixture');
  check('Real HA runtime responds', config.version === '2026.10.2', config.version);
  check('Five registered areas with photos', areas.length === 5 && areas.every((area) => area.picture?.startsWith('/local/')));
  check('All test entities are assigned via real device/area registries', fixtureEntities.every((entity) => devices.some((device) => device.id === entity.device_id && areas.some((area) => area.area_id === device.area_id))), `${fixtureEntities.length} entities`);
  check('Easy-Hass panel registered', panels['easy-hass']?.config?._panel_custom?.name === 'easy-hass-panel');
  const moduleUrl = panels['easy-hass'].config._panel_custom.module_url;
  const module = await fetch(new URL(moduleUrl, baseUrl));
  check('Custom frontend is served by HA', module.ok && (await module.text()).includes('easy-hass-panel'));
  await ha.call('subscribe_events', { event_type: 'state_changed' }, (event) => events.push(event));
  await ha.call('subscribe_events', { event_type: 'area_registry_updated' }, (event) => events.push(event));
  const initial = await states();
  for (const entity of [light, onoff]) {
    restore.push(() => ha.call('call_service', { domain: 'light', service: initial[entity.entity_id].state === 'on' ? 'turn_on' : 'turn_off', target: { entity_id: entity.entity_id }, service_data: initial[entity.entity_id].state === 'on' && initial[entity.entity_id].attributes.brightness ? { brightness: initial[entity.entity_id].attributes.brightness } : {} }));
  }
  restore.push(() => ha.call('call_service', { domain: 'cover', service: 'set_cover_position', target: { entity_id: cover.entity_id }, service_data: { position: initial[cover.entity_id].attributes.current_position } }));
  restore.push(() => ha.call('call_service', { domain: 'vacuum', service: 'return_to_base', target: { entity_id: vacuum.entity_id } }));
  await ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: [light.entity_id, onoff.entity_id] } });
  let state = await states();
  check('Room light toggle operates both dimmable and on/off lights', [light, onoff].every((entity) => state[entity.entity_id].state === 'on'));
  await ha.call('call_service', { domain: 'light', service: 'turn_on', target: { entity_id: light.entity_id }, service_data: { brightness_pct: 37 } });
  state = await states();
  check('Real dimming service updates HA brightness', Math.abs(state[light.entity_id].attributes.brightness / 255 * 100 - 37) < 1);
  check('On/off-only light advertises no brightness control', state[onoff.entity_id].attributes.supported_color_modes.length === 1 && state[onoff.entity_id].attributes.supported_color_modes[0] === 'onoff');
  for (const position of [49, 0, 100]) {
    await ha.call('call_service', { domain: 'cover', service: 'set_cover_position', target: { entity_id: cover.entity_id }, service_data: { position } });
    state = await states();
    check(`Cover service reaches ${position}% open`, state[cover.entity_id].attributes.current_position === position && state[cover.entity_id].state === (position === 0 ? 'closed' : 'open'));
  }
  await ha.call('call_service', { domain: 'vacuum', service: 'start', target: { entity_id: vacuum.entity_id } });
  state = await states();
  check('Vacuum service changes actual HA state', state[vacuum.entity_id].state === 'cleaning');
  check('Temperature and humidity advertise semantic device classes', ['temperature', 'humidity'].every((deviceClass) => Object.values(state).some((entity) => entity.attributes.device_class === deviceClass && entity.state !== 'unavailable')));

  temporaryArea = await ha.call('config/area_registry/create', { name: `Dynamischer Testraum ${Date.now()}` });
  const changed = await ha.call('config/area_registry/update', { area_id: temporaryArea.area_id, name: 'Dynamisch umbenannter Testraum' });
  check('A new room can be created and renamed in HA without a UI code change', changed.area_id === temporaryArea.area_id && changed.name === 'Dynamisch umbenannter Testraum');
  movedEntity = onoff;
  await ha.call('config/entity_registry/update', { entity_id: onoff.entity_id, area_id: temporaryArea.area_id });
  const updated = await ha.call('config/entity_registry/get', { entity_id: onoff.entity_id });
  check('Device assignment can be overridden in the live HA entity registry', updated.area_id === temporaryArea.area_id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('HA pushes light changes over the real WebSocket event stream', events.some((event) => event.event_type === 'state_changed' && event.data.entity_id === light.entity_id));
  check('HA pushes room registry changes', events.some((event) => event.event_type === 'area_registry_updated' && event.data.area_id === temporaryArea.area_id));
} finally {
  if (movedEntity) await ha.call('config/entity_registry/update', { entity_id: movedEntity.entity_id, area_id: movedEntity.area_id ?? null });
  if (temporaryArea) await ha.call('config/area_registry/delete', { area_id: temporaryArea.area_id });
  for (const revert of restore) await revert();
  ha.close();
}
const report = { at: new Date().toISOString(), runtime: baseUrl, results };
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(new URL('../test-results/ha-smoke.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: results.length, report: 'test-results/ha-smoke.json' }));
