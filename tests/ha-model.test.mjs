import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistries, subscribeRegistries, deriveRooms, deriveHome, deriveEntities,
  toggleRoomLights, setRoomBrightness, toggleRoomCovers, setRoomCoverPosition,
  callVacuumAction, pictureUrl, UNASSIGNED_ROOM_ID,
  deriveRoomDevices, entityControlTarget, toggleEntity,
} from '../frontend/src/ha-model.js';

const state = (entity_id, value, attributes = {}) => ({ entity_id, state: value, attributes });
const registry = (entities = [], areas = [{ area_id: 'a', name: 'Bibliothek' }], devices = []) => ({ entities, areas, devices });
const assigned = (entity_id, extra = {}) => ({ entity_id, area_id: 'a', ...extra });
const mockHass = (states) => {
  const calls = [];
  return { states, connected: true, calls, callService: async (...args) => { calls.push(args); return { success: true }; } };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 80));

test('loads the real three registries and propagates failure rather than inventing rooms', async () => {
  const types = [];
  const result = await loadRegistries({ callWS: async ({ type }) => { types.push(type); return [{ name: type }]; } });
  assert.deepEqual(types, ['config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list']);
  assert.equal(result.areas[0].name, types[0]);
  assert.equal(result.entities[0].name, types[2]);
  await assert.rejects(loadRegistries({ callWS: async () => { throw new Error('Disconnected'); } }), /Disconnected/);
  await assert.rejects(loadRegistries({ callWS: async () => ({}) }), /ungültige/);
});

test('entity area overrides device area, room order and pictures come directly from HA', () => {
  const regs = registry([
    assigned('light.override', { device_id: 'd' }),
    { entity_id: 'light.inherited', device_id: 'd' },
  ], [{ area_id: 'b', name: 'Galerie', picture: '/api/image/serve/picture/512x512' }, { area_id: 'a', name: 'Musikzimmer' }], [{ id: 'd', area_id: 'b' }]);
  const rooms = deriveRooms(regs, { 'light.override': state('light.override', 'on'), 'light.inherited': state('light.inherited', 'off') });
  assert.deepEqual(rooms.map((room) => room.name), ['Galerie', 'Musikzimmer']);
  assert.equal(rooms[0].lights[0].id, 'light.inherited');
  assert.equal(rooms[1].lights[0].id, 'light.override');
  assert.equal(rooms[0].picture, regs.areas[0].picture);
  assert.deepEqual(regs.entities[0], assigned('light.override', { device_id: 'd' }));
});

test('empty HA areas stay visible; state-only devices are explicitly unassigned', () => {
  const rooms = deriveRooms(registry(), { 'light.yaml': state('light.yaml', 'off'), 'weather.forecast': state('weather.forecast', 'sunny') });
  assert.equal(rooms[0].name, 'Bibliothek');
  assert.equal(rooms[0].light.count, 0);
  assert.equal(rooms[0].temperature, null);
  assert.equal(rooms[1].id, UNASSIGNED_ROOM_ID);
  assert.deepEqual(rooms[1].entities.map((entity) => entity.id), ['light.yaml']);
});

test('hidden and disabled entities and disabled devices cannot leak through live states', () => {
  const regs = registry([
    assigned('light.visible'), assigned('light.hidden', { hidden_by: 'user' }),
    assigned('light.disabled', { disabled_by: 'integration' }), assigned('light.disabled_device', { device_id: 'd' }),
  ], undefined, [{ id: 'd', disabled_by: 'user' }]);
  const states = Object.fromEntries(regs.entities.map(({ entity_id }) => [entity_id, state(entity_id, 'on')]));
  assert.deepEqual(deriveEntities(regs, states).map((entity) => entity.id), ['light.visible']);
});

test('unavailable registered devices remain visible with disabled controls and no fabricated readings', () => {
  const room = deriveRooms(registry([assigned('light.missing'), assigned('sensor.temp')]), {
    'sensor.temp': state('sensor.temp', 'unavailable', { device_class: 'temperature', unit_of_measurement: '°C' }),
  })[0];
  assert.equal(room.light.canToggle, false);
  assert.equal(room.light.unavailableCount, 1);
  assert.equal(room.light.brightness, null);
  assert.equal(room.temperature.value, null);
  assert.equal(room.temperature.unit, '°C');
  assert.equal(room.temperature.available, false);
});

test('area climate sensor preferences win, zero is valid and unknown is not zero', () => {
  const regs = registry([assigned('sensor.a'), assigned('sensor.preferred'), assigned('sensor.humidity')], [
    { area_id: 'a', name: 'Raum', temperature_entity_id: 'sensor.preferred', humidity_entity_id: 'sensor.humidity' },
  ]);
  const states = {
    'sensor.a': state('sensor.a', '23', { device_class: 'temperature', unit_of_measurement: '°C' }),
    'sensor.preferred': state('sensor.preferred', '0', { device_class: 'temperature', unit_of_measurement: '°F' }),
    'sensor.humidity': state('sensor.humidity', 'unknown', { device_class: 'humidity', unit_of_measurement: '%' }),
  };
  const room = deriveRooms(regs, states)[0];
  assert.equal(room.temperature.value, 0);
  assert.equal(room.temperature.unit, '°F');
  assert.equal(room.humidity.value, null);
  assert.equal(room.humidity.available, false);
  states['sensor.preferred'] = state('sensor.preferred', 'unavailable', { device_class: 'temperature', unit_of_measurement: '°F' });
  assert.equal(deriveRooms(regs, states)[0].temperature.value, null, 'do not silently switch away from the explicitly configured sensor');
});

test('live hass.states changes recompute room values without reloading registries', () => {
  const regs = registry([assigned('light.a'), assigned('sensor.h')]);
  const states = { 'light.a': state('light.a', 'off'), 'sensor.h': state('sensor.h', '42', { device_class: 'humidity' }) };
  assert.equal(deriveRooms(regs, states)[0].light.isOn, false);
  states['light.a'] = state('light.a', 'on');
  states['sensor.h'] = state('sensor.h', '51', { device_class: 'humidity' });
  const next = deriveRooms(regs, states)[0];
  assert.equal(next.light.isOn, true);
  assert.equal(next.humidity.value, 51);
});

test('multiple lights distinguish mixed power, average dimmable brightness and unsupported dimming', () => {
  const regs = registry([assigned('light.dim'), assigned('light.off'), assigned('light.binary'), assigned('light.missing')]);
  const states = {
    'light.dim': state('light.dim', 'on', { supported_color_modes: ['brightness'], brightness: 255 }),
    'light.off': state('light.off', 'off', { supported_color_modes: ['color_temp'], brightness: 128 }),
    'light.binary': state('light.binary', 'on', { supported_color_modes: ['onoff'] }),
    'light.missing': state('light.missing', 'unavailable', { supported_color_modes: ['brightness'] }),
  };
  const light = deriveRooms(regs, states)[0].light;
  assert.equal(light.count, 4);
  assert.equal(light.availableCount, 3);
  assert.equal(light.mixed, true);
  assert.equal(light.brightness, 50);
  assert.equal(light.dimmableCount, 2);
});

test('light groups replace members once and unavailable groups leave available members usable', () => {
  const ids = ['light.group', 'light.member_a', 'light.member_b'];
  const regs = registry(ids.map((id) => assigned(id)));
  const states = {
    'light.group': state('light.group', 'on', { entity_id: ['light.member_a', 'light.member_b'], supported_color_modes: ['brightness'], brightness: 128 }),
    'light.member_a': state('light.member_a', 'on'), 'light.member_b': state('light.member_b', 'off'),
  };
  assert.deepEqual(deriveRooms(regs, states)[0].lights.map((entity) => entity.id), ['light.group']);
  states['light.group'] = { ...states['light.group'], state: 'unavailable' };
  const room = deriveRooms(regs, states)[0];
  assert.equal(room.light.availableCount, 2);
  assert.equal(room.light.canToggle, true);
});

test('short light tap changes all available room lights coherently, not an inversion of each member', async () => {
  const states = { 'light.a': state('light.a', 'on'), 'light.b': state('light.b', 'off'), 'light.offline': state('light.offline', 'unavailable') };
  const hass = mockHass(states);
  const room = deriveRooms(registry(Object.keys(states).map((id) => assigned(id))), states)[0];
  await toggleRoomLights(hass, room);
  assert.deepEqual(hass.calls, [['light', 'turn_off', { entity_id: ['light.a', 'light.b'] }]]);
  hass.states['light.a'] = state('light.a', 'off');
  await toggleRoomLights(hass, room);
  assert.equal(hass.calls[1][1], 'turn_on', 'reads latest state, not stale rendered state');
});

test('brightness targets only available dimmable lights and zero turns those off', async () => {
  const states = {
    'light.dim': state('light.dim', 'on', { supported_color_modes: ['rgb'] }),
    'light.binary': state('light.binary', 'on', { supported_color_modes: ['onoff'] }),
    'light.gone': state('light.gone', 'unavailable', { supported_color_modes: ['brightness'] }),
  };
  const hass = mockHass(states);
  const room = deriveRooms(registry(Object.keys(states).map((id) => assigned(id))), states)[0];
  await setRoomBrightness(hass, room, 62.4);
  await setRoomBrightness(hass, room, 0);
  assert.deepEqual(hass.calls, [
    ['light', 'turn_on', { brightness_pct: 62, entity_id: ['light.dim'] }],
    ['light', 'turn_off', { entity_id: ['light.dim'] }],
  ]);
  assert.throws(() => setRoomBrightness(hass, room, NaN), /ungültig/);
});

test('covers follow HA 0=closed / 100=open and position capability rather than assuming a slider', async () => {
  const states = {
    'cover.position': state('cover.position', 'open', { current_position: 25, supported_features: 7 }),
    'cover.binary': state('cover.binary', 'closed', { supported_features: 3 }),
    'cover.unsupported': state('cover.unsupported', 'open', { supported_features: 0 }),
  };
  const hass = mockHass(states);
  const room = deriveRooms(registry(Object.keys(states).map((id) => assigned(id))), states)[0];
  assert.equal(room.cover.position, 25);
  assert.equal(room.cover.canPosition, true);
  assert.equal(room.cover.mixed, true);
  await setRoomCoverPosition(hass, room, 77);
  await toggleRoomCovers(hass, room);
  assert.deepEqual(hass.calls, [
    ['cover', 'set_cover_position', { position: 77, entity_id: ['cover.position'] }],
    ['cover', 'close_cover', { entity_id: ['cover.binary', 'cover.position'] }],
  ]);
});

test('covers supporting only position can open and close on short tap', async () => {
  const states = { 'cover.a': state('cover.a', 'closed', { supported_features: 4, current_position: 0 }) };
  const hass = mockHass(states);
  const room = deriveRooms(registry([assigned('cover.a')]), states)[0];
  await toggleRoomCovers(hass, room);
  assert.deepEqual(hass.calls[0], ['cover', 'set_cover_position', { position: 100, entity_id: ['cover.a'] }]);
});

test('a close-only cover already closed cannot advertise an unsupported open action', () => {
  const states = { 'cover.a': state('cover.a', 'closed', { supported_features: 2 }) };
  const room = deriveRooms(registry([assigned('cover.a')]), states)[0];
  assert.equal(room.cover.canToggle, false);
  assert.equal(room.cover.canPosition, false);
});

test('a tap stops only moving capable covers without reversing other room covers', async () => {
  const states = {
    'cover.moving': state('cover.moving', 'opening', { supported_features: 15, current_position: 25 }),
    'cover.stop_only': state('cover.stop_only', 'closing', { supported_features: 8 }),
    'cover.stationary': state('cover.stationary', 'open', { supported_features: 15, current_position: 50 }),
    'cover.no_stop': state('cover.no_stop', 'opening', { supported_features: 7, current_position: 25 }),
    'cover.offline': state('cover.offline', 'unavailable', { supported_features: 15 }),
  };
  const hass = mockHass(states);
  const room = deriveRooms(registry(Object.keys(states).map((id) => assigned(id))), states)[0];
  assert.equal(room.cover.moving, true);
  assert.equal(room.cover.canStop, true);
  assert.equal(room.cover.canToggle, true);
  await toggleRoomCovers(hass, room);
  assert.deepEqual(hass.calls, [['cover', 'stop_cover', { entity_id: ['cover.moving', 'cover.stop_only'] }]]);
});

test('stop-only moving cover enables a tap while unsupported stop sends no broad or opposite command', async () => {
  const states = { 'cover.a': state('cover.a', 'closing', { supported_features: 8 }) };
  const hass = mockHass(states);
  const regs = registry([assigned('cover.a')]);
  const room = deriveRooms(regs, states)[0];
  assert.equal(room.cover.canToggle, true);
  await toggleRoomCovers(hass, room);
  assert.deepEqual(hass.calls[0], ['cover', 'stop_cover', { entity_id: ['cover.a'] }]);
  hass.states['cover.a'] = state('cover.a', 'opening', { supported_features: 7 });
  const next = deriveRooms(regs, hass.states)[0];
  assert.equal(next.cover.canStop, false);
  assert.equal(next.cover.canToggle, false);
  await assert.rejects(toggleRoomCovers(hass, room), /Kein verfügbares/);
  assert.equal(hass.calls.length, 1);
});

test('no targets, lost connection and lost capabilities never issue a broad service call', async () => {
  const states = { 'light.a': state('light.a', 'on', { supported_color_modes: ['brightness'] }) };
  const hass = mockHass(states);
  const room = deriveRooms(registry([assigned('light.a')]), states)[0];
  hass.states['light.a'] = state('light.a', 'unavailable');
  await assert.rejects(toggleRoomLights(hass, room), /Kein verfügbares/);
  hass.states['light.a'] = state('light.a', 'on', { supported_color_modes: ['onoff'] });
  await assert.rejects(setRoomBrightness(hass, room, 60), /Kein verfügbares/);
  hass.connected = false;
  await assert.rejects(toggleRoomLights(hass, room), /unterbrochen/);
  assert.equal(hass.calls.length, 0);
});

test('home model exposes real weather/person/vacuum/meters without summing unrelated meters', async () => {
  const states = {
    'vacuum.bot': state('vacuum.bot', 'cleaning', { supported_features: 8192 + 4 + 16 }),
    'weather.home': state('weather.home', 'cloudy', { temperature: 17 }),
    'person.someone': state('person.someone', 'home'),
    'sensor.energy_a': state('sensor.energy_a', '100', { device_class: 'energy', unit_of_measurement: 'kWh' }),
    'sensor.energy_b': state('sensor.energy_b', '10', { device_class: 'energy', unit_of_measurement: 'kWh' }),
  };
  const home = deriveHome(registry(), states);
  assert.equal(home.weather[0].attributes.temperature, 17);
  assert.equal(home.people[0].state, 'home');
  assert.equal(home.energy.length, 2);
  assert.deepEqual(home.vacuums[0].actions, ['start', 'pause', 'return_to_base']);
  const hass = mockHass(states);
  await callVacuumAction(hass, home.vacuums[0], 'pause');
  await assert.rejects(callVacuumAction(hass, home.vacuums[0], 'stop'), /unterstützt/);
  assert.deepEqual(hass.calls[0], ['vacuum', 'pause', { entity_id: ['vacuum.bot'] }]);
});

test('photo URLs remain real HA URLs and cannot be script or protocol-relative URLs', () => {
  const hass = { hassUrl: (path) => `https://home.example${path}` };
  assert.equal(pictureUrl(hass, '/api/image/serve/a/512x512'), 'https://home.example/api/image/serve/a/512x512');
  assert.equal(pictureUrl(hass, 'https://images.example/picture.jpg'), 'https://images.example/picture.jpg');
  assert.equal(pictureUrl(hass, 'javascript:alert(1)'), null);
  assert.equal(pictureUrl(hass, '//images.example/picture.jpg'), null);
});

test('registry changes and reconnect reload, disposal removes listeners and suppresses pending results', async () => {
  const listeners = new Map();
  let ready;
  let removed = 0;
  let calls = 0;
  let results = 0;
  const hass = {
    connection: {
      subscribeEvents: async (callback, event) => { listeners.set(event, callback); return () => { removed++; listeners.delete(event); }; },
      addEventListener: (type, callback) => { assert.equal(type, 'ready'); ready = callback; },
      removeEventListener: (type, callback) => { assert.equal(callback, ready); ready = null; },
    },
    callWS: async () => { calls++; return []; },
  };
  const dispose = await subscribeRegistries(hass, () => { results++; });
  assert.equal(listeners.size, 3);
  listeners.get('area_registry_updated')();
  listeners.get('device_registry_updated')();
  await flush();
  assert.equal(calls, 3, 'bursts coalesce');
  assert.equal(results, 1);
  ready();
  await flush();
  assert.equal(results, 2);
  // One shared deferred response makes all three calls wait without holding the process open.
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  hass.callWS = async () => { await wait; return []; };
  listeners.get('entity_registry_updated')();
  await flush();
  dispose();
  release();
  await flush();
  assert.equal(results, 2, 'late network result cannot update disconnected panel');
  assert.equal(removed, 3);
  assert.equal(listeners.size, 0);
  assert.equal(ready, null);
});

test('partial subscription failure cleans established subscriptions and surfaces error', async () => {
  let disposed = 0;
  await assert.rejects(subscribeRegistries({ connection: {
    subscribeEvents: async (_, event) => { if (event === 'device_registry_updated') throw new Error('denied'); return () => { disposed++; }; },
  } }, () => {}), /denied/);
  await Promise.resolve();
  assert.equal(disposed, 2);
});

test('room detail keeps ordinary device entities and excludes configuration/system rows', () => {
  const ids = ['light.a', 'cover.a', 'switch.a', 'fan.a', 'climate.a', 'vacuum.a', 'media_player.a',
    'sensor.a', 'binary_sensor.a', 'lock.a', 'button.a', 'input_boolean.a', 'automation.a',
    'script.a', 'scene.a', 'update.a', 'person.a', 'weather.a', 'zone.a', 'sun.a'];
  const regs = registry([...ids.map((id) => assigned(id)), assigned('sensor.diagnostic', { entity_category: 'diagnostic' }), assigned('switch.config', { entity_category: 'config' })]);
  const states = Object.fromEntries(regs.entities.map(({ entity_id }) => [entity_id, state(entity_id, 'off')]));
  const rows = deriveRoomDevices(deriveRooms(regs, states)[0]);
  assert.deepEqual(rows.map((entity) => entity.id), ids.slice(0, 12).sort());
  assert.ok(rows.every((entity) => !entity.isGroup && entity.memberCount === 0 && !entity.isSharedGroup));
});

test('room detail shows an unavailable group only, without changing home-summary fallback', () => {
  const regs = registry(['light.group', 'light.one', 'light.two'].map((id) => assigned(id)));
  const states = {
    'light.group': state('light.group', 'unavailable', { entity_id: ['light.one', 'light.two'] }),
    'light.one': state('light.one', 'on'), 'light.two': state('light.two', 'off'),
  };
  const room = deriveRooms(regs, states)[0];
  assert.equal(room.light.availableCount, 2, 'home fallback remains unchanged');
  const rows = deriveRoomDevices(room);
  assert.deepEqual(rows.map((entity) => entity.id), ['light.group']);
  assert.equal(rows[0].isGroup, true);
  assert.equal(rows[0].memberCount, 2);
  assert.equal(rows[0].available, false);
});

test('nested HA group domain and light groups collapse to the outer group with unique leaf count', () => {
  const regs = registry(['group.outer', 'light.inner', 'light.one', 'light.two', 'switch.standalone'].map((id) => assigned(id)));
  const states = {
    'group.outer': state('group.outer', 'on', { entity_id: ['light.inner', 'light.one'] }),
    'light.inner': state('light.inner', 'on', { entity_id: ['light.one', 'light.two'] }),
    'light.one': state('light.one', 'on'), 'light.two': state('light.two', 'off'),
    'switch.standalone': state('switch.standalone', 'off'),
  };
  const rows = deriveRoomDevices(deriveRooms(regs, states)[0]);
  assert.deepEqual(rows.map((entity) => entity.id), ['group.outer', 'switch.standalone']);
  assert.equal(rows[0].memberCount, 2);
  assert.equal(rows[0].isSharedGroup, false);
});

test('hidden, disabled and diagnostic groups never suppress their visible members', () => {
  const regs = registry([
    assigned('light.hidden', { hidden_by: 'integration' }),
    assigned('light.disabled', { disabled_by: 'user' }),
    assigned('group.diagnostic', { entity_category: 'diagnostic' }),
    assigned('light.member'),
  ]);
  const states = {
    'light.hidden': state('light.hidden', 'on', { entity_id: ['light.member'] }),
    'light.disabled': state('light.disabled', 'on', { entity_id: ['light.member'] }),
    'group.diagnostic': state('group.diagnostic', 'on', { entity_id: ['light.member'] }),
    'light.member': state('light.member', 'on'),
  };
  const home = deriveHome(regs, states);
  assert.deepEqual(deriveRoomDevices(home.rooms[0], home.entities).map((entity) => entity.id), ['light.member']);
});

test('unassigned group is discovered from its room members and keeps its actual identity', () => {
  const regs = registry([{ entity_id: 'light.unassigned' }, assigned('light.member')]);
  const states = {
    'light.unassigned': state('light.unassigned', 'on', { entity_id: ['light.member'], friendly_name: 'Meine Gruppe' }),
    'light.member': state('light.member', 'on'),
  };
  const home = deriveHome(regs, states);
  const rows = deriveRoomDevices(home.rooms[0], home.entities);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'light.unassigned');
  assert.equal(rows[0].areaId, null, 'do not fabricate a registry assignment');
  assert.equal(rows[0].name, 'Meine Gruppe');
  assert.equal(rows[0].isSharedGroup, false);
});

test('cross-room groups replace local members and clearly retain their complete shared scope', async () => {
  const regs = registry([
    { entity_id: 'light.shared' }, assigned('light.one'), { entity_id: 'light.two', area_id: 'b' },
  ], [{ area_id: 'a', name: 'Bibliothek' }, { area_id: 'b', name: 'Galerie' }]);
  const states = {
    'light.shared': state('light.shared', 'on', { entity_id: ['light.one', 'light.two'], supported_color_modes: ['brightness'], brightness: 128 }),
    'light.one': state('light.one', 'on'), 'light.two': state('light.two', 'off'),
  };
  const home = deriveHome(regs, states);
  for (const room of home.rooms.slice(0, 2)) {
    const rows = deriveRoomDevices(room, home.entities);
    assert.deepEqual(rows.map((entity) => entity.id), ['light.shared']);
    assert.equal(rows[0].isSharedGroup, true);
    assert.equal(rows[0].memberCount, 2);
    const hass = mockHass(states);
    await setRoomBrightness(hass, entityControlTarget(rows[0]), 63);
    assert.deepEqual(hass.calls, [['light', 'turn_on', { brightness_pct: 63, entity_id: ['light.shared'] }]], 'target the real group, never an invented room subset');
  }
});

test('an explicitly differently assigned group remains a shared row and unrelated groups stay absent', () => {
  const regs = registry([
    { entity_id: 'group.shared', area_id: 'b' }, { entity_id: 'group.unrelated', area_id: 'b' }, assigned('light.one'),
    { entity_id: 'light.foreign', area_id: 'b' },
  ], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }]);
  const states = {
    'group.shared': state('group.shared', 'on', { entity_id: ['light.one'] }),
    'group.unrelated': state('group.unrelated', 'on', { entity_id: ['light.foreign'] }),
    'light.one': state('light.one', 'on'), 'light.foreign': state('light.foreign', 'on'),
  };
  const home = deriveHome(regs, states);
  const rows = deriveRoomDevices(home.rooms[0], home.entities);
  assert.deepEqual(rows.map((entity) => entity.id), ['group.shared']);
  assert.equal(rows[0].areaId, 'b');
  assert.equal(rows[0].isSharedGroup, true);
});

test('nested unassigned groups and cycles are finite and preserve one deterministic outer representative', () => {
  const regs = registry([{ entity_id: 'group.a' }, { entity_id: 'group.b' }, { entity_id: 'group.outer' }, assigned('light.member')]);
  const states = {
    'group.a': state('group.a', 'on', { entity_id: ['group.b', 'light.member'] }),
    'group.b': state('group.b', 'on', { entity_id: ['group.a'] }),
    'group.outer': state('group.outer', 'on', { entity_id: ['group.b'] }),
    'light.member': state('light.member', 'on'),
  };
  const home = deriveHome(regs, states);
  const rows = deriveRoomDevices(home.rooms[0], home.entities);
  assert.deepEqual(rows.map((entity) => entity.id), ['group.outer']);
  assert.equal(rows[0].memberCount, 1);
  const cycleOnly = home.entities.filter((entity) => entity.id !== 'group.outer');
  assert.deepEqual(deriveRoomDevices(home.rooms[0], cycleOnly).map((entity) => entity.id), ['group.a']);
});

test('empty and self-referential HA groups stay represented without counting themselves as members', () => {
  const regs = registry([assigned('group.empty'), assigned('group.self')]);
  const states = {
    'group.empty': state('group.empty', 'unknown', { entity_id: [] }),
    'group.self': state('group.self', 'on', { entity_id: ['group.self'] }),
  };
  const rows = deriveRoomDevices(deriveRooms(regs, states)[0]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((entity) => entity.isGroup && entity.memberCount === 0));
});

test('entity targets preserve capabilities and isolate both light and cover services to their entity', async () => {
  const regs = registry([assigned('light.one'), assigned('light.two'), assigned('cover.one')]);
  const states = {
    'light.one': state('light.one', 'on', { supported_color_modes: ['brightness'], brightness: 255 }),
    'light.two': state('light.two', 'off', { supported_color_modes: ['onoff'] }),
    'cover.one': state('cover.one', 'open', { supported_features: 7, current_position: 25 }),
  };
  const entities = deriveEntities(regs, states);
  const light = entityControlTarget(entities.find((entity) => entity.id === 'light.one'));
  assert.equal(light.id, 'entity:light.one');
  assert.equal(light.light.canDim, true);
  assert.equal(light.light.brightness, 100);
  assert.equal(light.cover.count, 0);
  const hass = mockHass(states);
  await toggleRoomLights(hass, light);
  const cover = entityControlTarget(entities.find((entity) => entity.id === 'cover.one'));
  assert.equal(cover.cover.canPosition, true);
  await setRoomCoverPosition(hass, cover, 48);
  assert.deepEqual(hass.calls, [
    ['light', 'turn_off', { entity_id: ['light.one'] }],
    ['cover', 'set_cover_position', { position: 48, entity_id: ['cover.one'] }],
  ]);
});

test('entity toggle reads current state and only supports explicit switch/fan/input_boolean targets', async () => {
  const states = { 'switch.one': state('switch.one', 'on'), 'fan.one': state('fan.one', 'off'), 'input_boolean.one': state('input_boolean.one', 'off'), 'lock.one': state('lock.one', 'locked') };
  const entities = deriveEntities(registry(), states);
  const hass = mockHass(states);
  for (const id of ['switch.one', 'fan.one', 'input_boolean.one']) await toggleEntity(hass, entities.find((entity) => entity.id === id));
  assert.deepEqual(hass.calls, [
    ['switch', 'turn_off', { entity_id: ['switch.one'] }],
    ['fan', 'turn_on', { entity_id: ['fan.one'] }],
    ['input_boolean', 'turn_on', { entity_id: ['input_boolean.one'] }],
  ]);
  const entity = entities.find((item) => item.id === 'switch.one');
  hass.states['switch.one'] = state('switch.one', 'off');
  await toggleEntity(hass, entity);
  assert.equal(hass.calls[3][1], 'turn_on');
  await assert.rejects(toggleEntity(hass, entities.find((item) => item.id === 'lock.one')), /Kein verfügbares/);
  hass.states['switch.one'] = state('switch.one', 'unavailable');
  await assert.rejects(toggleEntity(hass, entity), /Kein verfügbares/);
  hass.connected = false;
  await assert.rejects(toggleEntity(hass, entities.find((item) => item.id === 'fan.one')), /unterbrochen/);
  assert.equal(hass.calls.length, 4);
});

test('hidden group members retain topology without becoming visible entities or room rows', () => {
  const regs = registry([
    { entity_id: 'light.shared' },
    { entity_id: 'light.a', device_id: 'a-device', hidden_by: 'integration' },
    { entity_id: 'light.b', area_id: 'b', hidden_by: 'integration' },
  ], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }], [{ id: 'a-device', area_id: 'a' }]);
  const states = {
    'light.shared': state('light.shared', 'on', { entity_id: ['light.a', 'light.b'] }),
    'light.a': state('light.a', 'on'), 'light.b': state('light.b', 'on'),
  };
  const home = deriveHome(regs, states);
  assert.deepEqual(home.entities.map((entity) => entity.id), ['light.shared']);
  assert.equal(home.entityScopes['light.a'].areaId, 'a');
  assert.ok(Object.isFrozen(home.entityScopes));
  assert.ok(Object.isFrozen(home.entityScopes['light.shared'].memberIds));
  for (const room of home.rooms.slice(0, 2)) {
    assert.deepEqual(room.entities, []);
    const rows = deriveRoomDevices(room, home.entities, home.entityScopes);
    assert.deepEqual(rows.map((entity) => entity.id), ['light.shared']);
    assert.equal(rows[0].isSharedGroup, true);
    assert.equal(rows[0].memberCount, 2);
  }
});

test('an assigned group detects hidden members in another area and entity area overrides hidden device area', () => {
  const regs = registry([
    assigned('light.group'), assigned('light.a', { hidden_by: 'integration' }),
    { entity_id: 'light.b', area_id: 'b', device_id: 'device-a', hidden_by: 'user' },
  ], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }], [{ id: 'device-a', area_id: 'a' }]);
  const states = {
    'light.group': state('light.group', 'on', { entity_id: ['light.a', 'light.b'] }),
    'light.a': state('light.a', 'on'), 'light.b': state('light.b', 'off'),
  };
  const home = deriveHome(regs, states);
  assert.equal(home.entityScopes['light.b'].areaId, 'b');
  const rows = deriveRoomDevices(home.rooms[0], home.entities, home.entityScopes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isSharedGroup, true);
});

test('visible parent traverses hidden/disabled nested groups but those groups never become rows or suppressors themselves', () => {
  const regs = registry([
    { entity_id: 'group.outer' },
    { entity_id: 'group.hidden', hidden_by: 'integration' },
    { entity_id: 'group.disabled', disabled_by: 'user' },
    assigned('light.visible'), assigned('light.hidden', { hidden_by: 'integration' }),
    assigned('light.disabled', { disabled_by: 'integration' }),
  ]);
  const states = {
    'group.outer': state('group.outer', 'on', { entity_id: ['group.hidden'] }),
    'group.hidden': state('group.hidden', 'on', { entity_id: ['group.disabled', 'light.visible'] }),
    'group.disabled': state('group.disabled', 'unavailable', { entity_id: ['group.hidden', 'light.hidden', 'light.disabled'] }),
    'light.visible': state('light.visible', 'on'), 'light.hidden': state('light.hidden', 'on'),
  };
  const home = deriveHome(regs, states);
  assert.deepEqual(home.entities.map((entity) => entity.id), ['group.outer', 'light.visible']);
  assert.ok(home.entityScopes['light.disabled'], 'registry-only disabled member retains its area');
  const rows = deriveRoomDevices(home.rooms[0], home.entities, home.entityScopes);
  assert.deepEqual(rows.map((entity) => entity.id), ['group.outer']);
  assert.equal(rows[0].memberCount, 3);
  const withoutParent = home.entities.filter((entity) => entity.id !== 'group.outer');
  assert.deepEqual(deriveRoomDevices(home.rooms[0], withoutParent, home.entityScopes).map((entity) => entity.id), ['light.visible'], 'topology alone never adds a hidden group or hides its visible member');
});

test('category-filtered members inform shared group scope but never appear as ordinary rows', () => {
  const regs = registry([
    { entity_id: 'group.sensors' }, assigned('sensor.local', { entity_category: 'diagnostic' }),
    { entity_id: 'sensor.remote', area_id: 'b', entity_category: 'config' },
  ], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }]);
  const states = {
    'group.sensors': state('group.sensors', 'on', { entity_id: ['sensor.local', 'sensor.remote'] }),
    'sensor.local': state('sensor.local', '2'), 'sensor.remote': state('sensor.remote', '3'),
  };
  const home = deriveHome(regs, states);
  const rows = deriveRoomDevices(home.rooms[0], home.entities, home.entityScopes);
  assert.deepEqual(rows.map((entity) => entity.id), ['group.sensors']);
  assert.equal(rows[0].isSharedGroup, true);
});

test('optional topology fallback remains compatible for callers with visible entities only', () => {
  const regs = registry([assigned('light.group'), assigned('light.member')]);
  const states = {
    'light.group': state('light.group', 'on', { entity_id: ['light.member'] }),
    'light.member': state('light.member', 'on'),
  };
  const home = deriveHome(regs, states);
  const implicit = deriveRoomDevices(home.rooms[0]);
  assert.deepEqual(deriveRoomDevices(home.rooms[0], home.entities), implicit);
  assert.deepEqual(deriveRoomDevices(home.rooms[0], home.entities, home.entityScopes), implicit);
  assert.equal(implicit[0].memberCount, 1);
});
