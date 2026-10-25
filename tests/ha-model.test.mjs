import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadRegistries, subscribeRegistries, deriveRooms, deriveHome, deriveEntities,
  loadPanelSettings, subscribePanelSettings, setRoomHidden,
  toggleRoomLights, setRoomBrightness, toggleRoomCovers, setRoomCoverPosition,
  callVacuumAction, pictureUrl, UNASSIGNED_ROOM_ID,
  deriveRoomDevices, entityControlTarget, toggleEntity,
  listRegisteredAreas, createArea, renameArea, reorderAreas, AREA_NAME_MAX_LENGTH,
  listRoomAssignments, listAssignableDevices, setDeviceRoom, setRoomDeviceOrder,
  updateArea, validateAreaName, validateAreaImageFile, uploadAreaImage, deleteUploadedAreaImage,
  AREA_IMAGE_ACCEPT, AREA_IMAGE_MAX_BYTES,
} from '../frontend/src/ha-model.js';

const state = (entity_id, value, attributes = {}) => ({ entity_id, state: value, attributes });
const registry = (entities = [], areas = [{ area_id: 'a', name: 'Bibliothek' }], devices = []) => ({ entities, areas, devices });
const assigned = (entity_id, extra = {}) => ({ entity_id, area_id: 'a', ...extra });
const mockHass = (states) => {
  const calls = [];
  return { states, connected: true, calls, callService: async (...args) => { calls.push(args); return { success: true }; } };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 80));

const assignmentFixture = () => registry([
  { entity_id: 'light.control', device_id: 'lamp', area_id: 'b' },
  { entity_id: 'sensor.temperature', device_id: 'climate' },
  { entity_id: 'switch.independent', area_id: 'a', name: 'Independent' },
  { entity_id: 'sensor.raw', area_id: 'a' },
  { entity_id: 'light.hidden', hidden_by: 'user', area_id: 'a' },
  { entity_id: 'light.diagnostic', entity_category: 'diagnostic', area_id: 'a' },
  { entity_id: 'light.disabled', disabled_by: 'user', area_id: 'a' },
], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }], [
  { id: 'lamp', name: 'Lamp', area_id: 'a' },
  { id: 'climate', name: 'Climate', area_id: 'a' },
  { id: 'empty', name: 'Empty', area_id: null },
  { id: 'disabled', name: 'Disabled', disabled_by: 'user' },
]);

test('assignment lists include physical sensor devices, preserve native scope and expose explicit overrides', () => {
  const regs = assignmentFixture();
  const items = listRoomAssignments(regs, {}, 'a');
  assert.deepEqual(items.map(item => item.key), ['device:climate', 'entity:switch.independent', 'device:lamp']);
  const lamp = items.find(item => item.id === 'lamp');
  assert.equal(lamp.areaId, 'a');
  assert.equal(lamp.overrideCount, 1);
  assert.equal(lamp.explicitAreaCount, 1);
  assert.equal(lamp.canRemove, true);
  assert.deepEqual(listAssignableDevices(regs, {}, 'a').map(item => item.key), ['device:empty']);
  assert.deepEqual(listRoomAssignments(regs, {}, 'missing'), []);
  assert.deepEqual(listAssignableDevices(regs, {}, UNASSIGNED_ROOM_ID), []);
  const inherited = listRoomAssignments(regs, {}, 'b');
  assert.equal(inherited.length, 1);
  assert.equal(inherited[0].key, 'device:lamp');
  assert.equal(inherited[0].areaId, 'a');
  assert.equal(inherited[0].inherited, true);
  assert.equal(inherited[0].inheritedReason, 'entity');
  assert.equal(inherited[0].canRemove, false);
});

test('unassigned shared groups remain real sortable assignments with hidden nested member scope', () => {
  const regs = assignmentFixture();
  regs.entities.push({ entity_id: 'group.outer', name: 'Outer' },
    { entity_id: 'group.hidden', hidden_by: 'integration' },
    { entity_id: 'light.member', area_id: 'a', hidden_by: 'integration' });
  const states = {
    'group.outer': state('group.outer', 'unavailable', { entity_id: ['group.hidden', 'light.control'] }),
    'group.hidden': state('group.hidden', 'on', { entity_id: ['light.member', 'group.outer'] }),
  };
  for (const areaId of ['a', 'b']) {
    const group = listRoomAssignments(regs, states, areaId).find(item => item.key === 'entity:group.outer');
    assert.equal(group.isGroup, true);
    assert.equal(group.inherited, true);
    assert.equal(group.inheritedReason, 'group');
    assert.equal(group.areaId, null);
    assert.equal(group.canRemove, false);
  }
  assert.ok(listAssignableDevices(regs, states, 'a').some(item => item.key === 'entity:group.outer'));
  assert.ok(!listAssignableDevices(regs, states, 'a').some(item => item.key === 'entity:group.hidden'));
});

test('custom ordering crosses domains, orders physical device functions and keeps group suppression', () => {
  const regs = registry([
    { entity_id: 'light.member', device_id: 'lamp' }, assigned('light.group'),
    assigned('cover.shade'), assigned('switch.socket'), assigned('sensor.temperature'),
    { entity_id: 'fan.breeze', device_id: 'fan' },
  ], undefined, [{ id: 'lamp', area_id: 'a' }, { id: 'fan', area_id: 'a' }]);
  const states = { 'light.group': state('light.group', 'on', { entity_id: ['light.member'] }) };
  const home = deriveHome(regs, states), order = ['entity:switch.socket', 'device:fan', 'entity:light.group'];
  assert.deepEqual(deriveRoomDevices(home.rooms[0], home.entities, home.entityScopes, order).map(row => row.id),
    ['switch.socket', 'fan.breeze', 'light.group', 'cover.shade']);
  assert.deepEqual(order, ['entity:switch.socket', 'device:fan', 'entity:light.group']);
  assert.deepEqual(listRoomAssignments(regs, states, 'a', order).slice(0, 3).map(item => item.key), order);
});

const assignmentHass = (regs = assignmentFixture()) => {
  const calls = [], connection = {};
  return { connected: true, user: { is_admin: true }, connection, states: {}, calls,
    callWS: async payload => {
      calls.push(payload);
      const kind = /^config\/(area|device|entity)_registry\/list$/.exec(payload.type)?.[1];
      if (kind) return regs[`${kind === 'entity' ? 'entitie' : kind}s`];
      const entry = { id: payload.device_id || payload.entity_id, area_id: payload.area_id };
      return payload.entity_id ? { entity_entry: entry } : entry;
    },
  };
};

test('native room assignment changes only area_id and returns actual updated device/entity entries', async () => {
  const regs = assignmentFixture(), before = structuredClone(regs), hass = assignmentHass(regs);
  assert.deepEqual(await setDeviceRoom(hass, 'device:lamp', 'b'), { id: 'lamp', area_id: 'b' });
  assert.deepEqual(await setDeviceRoom(hass, 'entity:switch.independent', null), { id: 'switch.independent', area_id: null });
  assert.deepEqual(hass.calls.filter(call => call.type.endsWith('/update')), [
    { type: 'config/device_registry/update', device_id: 'lamp', area_id: 'b' },
    { type: 'config/entity_registry/update', entity_id: 'switch.independent', area_id: null },
  ]);
  assert.deepEqual(regs, before, 'no optimistic registry/override mutation');
});

test('assignment writes reject stale, hidden, sensor entities, missing rooms and changed connections', async () => {
  for (const [key, area] of [['device:missing', 'a'], ['entity:light.hidden', 'a'], ['entity:sensor.raw', 'a'],
    ['entity:light.control', 'a'], ['device:disabled', 'a'], ['device:lamp', 'missing']]) {
    const hass = assignmentHass();
    await assert.rejects(setDeviceRoom(hass, key, area), /existiert nicht mehr|zugeordnet werden/);
    assert.equal(hass.calls.filter(call => call.type.endsWith('/update')).length, 0);
  }
  const hass = assignmentHass(), original = hass.callWS;
  hass.callWS = async payload => { const result = await original(payload); hass.connection = {}; return result; };
  await assert.rejects(setDeviceRoom(hass, 'device:lamp', 'a'), /Verbindung.*geändert/);
  assert.equal(hass.calls.filter(call => call.type.endsWith('/update')).length, 0);
});

test('assignment and order validation performs no requests without admin/connection or for malformed input', async () => {
  for (const patch of [{ user: { is_admin: false } }, { connected: false }, { callWS: null }]) {
    const hass = Object.assign(assignmentHass(), patch);
    await assert.rejects(setDeviceRoom(hass, 'device:lamp', 'a'), /Administratoren|unterbrochen/);
    await assert.rejects(setRoomDeviceOrder(hass, 'a', []), /Administratoren|unterbrochen/);
    assert.deepEqual(hass.calls, []);
  }
  const hass = assignmentHass();
  for (const key of [null, '', 'light.control', 'device: a', 'entity:invalid', 'device:x:y'])
    await assert.rejects(setDeviceRoom(hass, key, 'a'), TypeError);
  for (const keys of [null, {}, ['device:x', 'device:x'], ['entity:bad'], Array(1)])
    await assert.rejects(setRoomDeviceOrder(hass, 'a', keys), TypeError);
  await assert.rejects(setDeviceRoom(hass, 'device:lamp', UNASSIGNED_ROOM_ID), TypeError);
  assert.deepEqual(hass.calls, []);
});

test('order WS writes use exact keys, reset one area, copy response and preserve server errors', async () => {
  const snapshot = { hidden_area_ids: ['b'], room_device_order: { a: ['device:lamp'], b: ['entity:cover.other'] } }, calls = [];
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => { calls.push(payload); return snapshot; } };
  const result = await setRoomDeviceOrder(hass, 'a', ['device:lamp']);
  await setRoomDeviceOrder(hass, 'a', []);
  assert.deepEqual(calls, [
    { type: 'easy_hass/room_device_order/set', area_id: 'a', keys: ['device:lamp'] },
    { type: 'easy_hass/room_device_order/set', area_id: 'a', keys: [] },
  ]);
  snapshot.room_device_order.a.push('entity:light.later');
  assert.deepEqual(result.room_device_order.a, ['device:lamp']);
  const error = { code: 'not_found', message: 'Stale assignment' };
  await assert.rejects(setRoomDeviceOrder({ ...hass, callWS: async () => { throw error; } }, 'a', []), value => value === error);
  for (const room_device_order of [null, [], { a: ['device:x', 'device:x'] }, { a: ['sensor.raw'] }, { [UNASSIGNED_ROOM_ID]: [] }])
    await assert.rejects(loadPanelSettings({ ...hass, callWS: async () => ({ hidden_area_ids: [], room_device_order }) }));
});

test('panel settings reads are authenticated-user accessible, copied and validated without fallback defaults', async () => {
  const response = { hidden_area_ids: ['a'], future_option: true }, calls = [];
  const hass = { connected: true, user: { is_admin: false }, callWS: async payload => { calls.push(payload); return response; } };
  const settings = await loadPanelSettings(hass);
  assert.deepEqual(calls, [{ type: 'easy_hass/settings/get' }]);
  assert.deepEqual(settings, { hidden_area_ids: ['a'] });
  response.hidden_area_ids.push('b');
  assert.deepEqual(settings.hidden_area_ids, ['a']);
  for (const value of [null, [], {}, { hidden_area_ids: 'a' }, ...[
    ['a', 'a'], [null], [1], [''], [' a'], [UNASSIGNED_ROOM_ID], Array(1),
  ].map(hidden_area_ids => ({ hidden_area_ids }))]) {
    await assert.rejects(loadPanelSettings({ ...hass, callWS: async () => value }), /ungültige Anzeigeeinstellungen/);
  }
  const failure = { code: 'not_loaded', message: 'Integration not loaded' };
  await assert.rejects(loadPanelSettings({ ...hass, callWS: async () => { throw failure; } }), error => error === failure);
  for (const unavailable of [null, { connected: false }, { connected: true }]) await assert.rejects(loadPanelSettings(unavailable), /unterbrochen/);
});

test('room visibility writes change exactly one ID and retain other clients hidden rooms', async () => {
  const hidden = new Set(['other']), calls = [];
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => {
    calls.push(payload);
    if (payload.hidden) hidden.add(payload.area_id); else hidden.delete(payload.area_id);
    return { hidden_area_ids: [...hidden] };
  } };
  assert.deepEqual(await setRoomHidden(hass, 'a', true), { hidden_area_ids: ['other', 'a'] });
  hidden.add('concurrent');
  assert.deepEqual(await setRoomHidden(hass, 'a', false), { hidden_area_ids: ['other', 'concurrent'] });
  assert.deepEqual(calls, [
    { type: 'easy_hass/room_visibility/set', area_id: 'a', hidden: true },
    { type: 'easy_hass/room_visibility/set', area_id: 'a', hidden: false },
  ]);
});

test('room visibility rejects nonadmin/offline/malformed writes and preserves backend failures', async () => {
  let calls = 0;
  const hass = { connected: true, user: { is_admin: true }, callWS: async () => { calls++; return { hidden_area_ids: [] }; } };
  for (const area of [null, '', ' a', 'a ', UNASSIGNED_ROOM_ID]) await assert.rejects(setRoomHidden(hass, area, true), TypeError);
  for (const hidden of [undefined, null, 0, 1, 'true', {}]) await assert.rejects(setRoomHidden(hass, 'a', hidden), TypeError);
  for (const user of [undefined, {}, { is_admin: false }]) await assert.rejects(setRoomHidden({ ...hass, user }, 'a', true), /Administratoren/);
  for (const connected of [undefined, false]) await assert.rejects(setRoomHidden({ ...hass, connected }, 'a', true), /unterbrochen/);
  await assert.rejects(setRoomHidden({ ...hass, callWS: null }, 'a', true), /unterbrochen/);
  assert.equal(calls, 0);
  const failure = { code: 'not_found', message: 'Area was removed' };
  await assert.rejects(setRoomHidden({ ...hass, callWS: async () => { throw failure; } }, 'a', true), error => error === failure);
  await assert.rejects(setRoomHidden({ ...hass, callWS: async () => ({}) }, 'a', true), /ungültige Anzeigeeinstellungen/);
});

test('settings subscription delivers initial and live snapshots, reconnect reads cannot overwrite newer pushes', async () => {
  const snapshots = [], errors = [], listeners = new Map(), requests = [];
  let push, subscriptions = 0, removed = 0;
  const hass = { connected: true, callWS: payload => {
    assert.deepEqual(payload, { type: 'easy_hass/settings/get' });
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  }, connection: {
    subscribeMessage: async (callback, payload, options) => {
      subscriptions++;
      assert.deepEqual(payload, { type: 'easy_hass/settings/subscribe' });
      assert.equal(options.resubscribe, true);
      push = callback;
      push({ hidden_area_ids: ['initial'] });
      return async () => { removed++; throw new Error('Socket already closed'); };
    },
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { assert.equal(listeners.get(type), callback); listeners.delete(type); },
  } };
  const dispose = await subscribePanelSettings(hass, value => snapshots.push(value), error => errors.push(error));
  push({ hidden_area_ids: ['live'] });
  push({ hidden_area_ids: 'broken' });
  assert.equal(errors.length, 1);
  const ready = listeners.get('ready');
  const reconnect = ready();
  push({ hidden_area_ids: ['reconnected'] });
  requests[0].resolve({ hidden_area_ids: ['stale'] });
  await reconnect;
  assert.deepEqual(snapshots.map(value => value.hidden_area_ids), [['initial'], ['live'], ['reconnected']]);
  const oldRead = ready(), newerRead = ready();
  requests[2].resolve({ hidden_area_ids: ['latest'] });
  await newerRead;
  requests[1].resolve({ hidden_area_ids: ['older'] });
  await oldRead;
  assert.deepEqual(snapshots.at(-1), { hidden_area_ids: ['latest'] });
  const failedOldRead = ready();
  push({ hidden_area_ids: ['newer-than-error'] });
  requests[3].reject(new Error('Old read failed'));
  await failedOldRead;
  assert.equal(errors.length, 1, 'a stale read failure does not invalidate a newer valid push');
  const pending = ready();
  dispose(); dispose();
  push({ hidden_area_ids: ['after-dispose'] });
  requests[4].resolve({ hidden_area_ids: ['late'] });
  await pending;
  await Promise.resolve();
  assert.deepEqual(snapshots.at(-1), { hidden_area_ids: ['newer-than-error'] });
  assert.equal(removed, 1);
  assert.equal(listeners.size, 0);
  assert.equal(subscriptions, 1, 'native resubscription is not duplicated on ready');
});

test('settings subscription surfaces current reconnect errors and cleans up failed setup', async () => {
  let ready, push, removed = 0;
  const failure = { code: 'not_loaded', message: 'Unavailable' }, errors = [], snapshots = [];
  const connection = {
    addEventListener: (_, callback) => { ready = callback; },
    removeEventListener: (_, callback) => { assert.equal(ready, callback); ready = null; removed++; },
    subscribeMessage: async callback => { push = callback; return () => {}; },
  };
  const hass = { connected: true, connection, callWS: async () => { throw failure; } };
  const dispose = await subscribePanelSettings(hass, value => snapshots.push(value), error => errors.push(error));
  await ready();
  assert.equal(errors[0], failure);
  push({ hidden_area_ids: [] });
  assert.deepEqual(snapshots, [{ hidden_area_ids: [] }]);
  dispose();
  connection.subscribeMessage = async callback => { push = callback; throw failure; };
  await assert.rejects(subscribePanelSettings(hass, value => snapshots.push(value), error => errors.push(error)), error => error === failure);
  push({ hidden_area_ids: ['late'] });
  assert.equal(snapshots.length, 1);
  assert.equal(ready, null);
  assert.equal(removed, 2);
  await assert.rejects(subscribePanelSettings({}, () => {}), /Verbindung fehlt/);
});

test('hidden rooms leave settings, shared-group topology and robots complete while filtering only room navigation', () => {
  const regs = registry([
    assigned('light.group', { area_id: 'b' }), assigned('light.a'), assigned('light.b', { area_id: 'b' }),
    assigned('vacuum.b', { area_id: 'b' }), { entity_id: 'light.unassigned' },
  ], [{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }, { area_id: 'empty', name: 'Empty' }]);
  const states = {
    'light.group': state('light.group', 'on', { entity_id: ['light.a', 'light.b'] }),
    'light.a': state('light.a', 'on'), 'light.b': state('light.b', 'on'),
    'vacuum.b': state('vacuum.b', 'docked'), 'light.unassigned': state('light.unassigned', 'off'),
  };
  const all = deriveHome(regs, states);
  const hidden = deriveHome(regs, states, { hidden_area_ids: ['b', 'empty', 'removed-room'] });
  assert.deepEqual(hidden.rooms.map(room => room.id), ['a', UNASSIGNED_ROOM_ID]);
  assert.deepEqual(hidden.entities, all.entities);
  assert.deepEqual(hidden.entityScopes, all.entityScopes);
  assert.deepEqual(hidden.vacuums, all.vacuums);
  assert.equal(hidden.vacuums[0].areaId, 'b');
  assert.deepEqual(deriveRoomDevices(hidden.rooms[0], hidden.entities, hidden.entityScopes), deriveRoomDevices(all.rooms[0], all.entities, all.entityScopes));
  assert.equal(deriveRoomDevices(hidden.rooms[0], hidden.entities, hidden.entityScopes)[0].id, 'light.group');
  assert.deepEqual(listRegisteredAreas(regs).map(area => area.id), ['a', 'b', 'empty']);
  assert.deepEqual(deriveHome(regs, states, ['a', 'b', 'empty', UNASSIGNED_ROOM_ID]).rooms.map(room => room.id), [UNASSIGNED_ROOM_ID]);
  assert.deepEqual(deriveHome(regs, states, { hidden_area_ids: [] }), all, 'unhide restores original HA order');
});

test('loads the real three registries and propagates failure rather than inventing rooms', async () => {
  const types = [];
  const result = await loadRegistries({ callWS: async ({ type }) => { types.push(type); return [{ name: type }]; } });
  assert.deepEqual(types, ['config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list']);
  assert.equal(result.areas[0].name, types[0]);
  assert.equal(result.entities[0].name, types[2]);
  await assert.rejects(loadRegistries({ callWS: async () => { throw new Error('Disconnected'); } }), /Disconnected/);
  await assert.rejects(loadRegistries({ callWS: async () => ({}) }), /ungültige/);
});

test('settings lists only registered areas, keeps empty rooms and preserves the home registry order', () => {
  const areas = [
    { area_id: 'room_10', name: 'Raum 10', picture: '/api/image/serve/photo/512x512', floor_id: 'upstairs' },
    { area_id: 'room_2', name: 'Raum 2', icon: 'mdi:desk', aliases: ['Office'] },
    { area_id: 'empty', name: 'Leerer Raum' },
  ];
  const regs = registry([{ entity_id: 'light.unassigned' }, { entity_id: 'light.known', area_id: 'room_2' }], areas);
  const states = { 'light.unassigned': state('light.unassigned', 'on') };
  const listed = listRegisteredAreas(regs);
  assert.deepEqual(listed.map(({ id }) => id), deriveRooms(regs, states).filter(room => !room.unassigned).map(({ id }) => id));
  assert.deepEqual(listed.map(({ name }) => name), ['Raum 10', 'Raum 2', 'Leerer Raum']);
  assert.equal(listed[0].picture, areas[0].picture);
  assert.equal(listed[0].floor_id, 'upstairs');
  assert.equal(listed[1].icon, 'mdi:desk');
  assert.notEqual(listed, areas);
  listed[0].name = 'Local edit';
  assert.equal(areas[0].name, 'Raum 10');
  assert.deepEqual(listRegisteredAreas(), []);
  assert.deepEqual(listRegisteredAreas({ areas: [null, { name: 'No ID' }, { area_id: UNASSIGNED_ROOM_ID, name: 'Ohne Raum' }, { id: 'synthetic', name: 'Synthetic', unassigned: true }] }), []);
  assert.deepEqual(listRegisteredAreas({ areas: { empty: { id: 'empty', name: 'Empty' } } }), [{ id: 'empty', area_id: 'empty', name: 'Empty' }]);
});

test('native area reorder persists one complete order used by settings and home, retaining empty rooms and fields', async () => {
  const original = [
    { area_id: 'a', name: 'Bibliothek', picture: '/local/room.jpg', floor_id: 'upstairs' },
    { area_id: 'empty', name: 'Leerer Raum', aliases: ['Office'] },
    { area_id: 'b', name: 'Küche', icon: 'mdi:pot' },
  ];
  let areas = [...original];
  const calls = [], result = { success: true };
  const hass = { connected: true, connection: {}, user: { is_admin: true }, callWS: async payload => {
    calls.push(payload);
    if (payload.type === 'config/area_registry/list') return areas;
    const byId = new Map(areas.map(area => [area.area_id, area]));
    areas = payload.area_ids.map(id => byId.get(id));
    return result;
  } };
  assert.equal(await reorderAreas(hass, ['b', 'empty', 'a']), result);
  assert.deepEqual(calls, [
    { type: 'config/area_registry/list' },
    { type: 'config/area_registry/reorder', area_ids: ['b', 'empty', 'a'] },
  ]);
  const regs = registry([{ entity_id: 'light.unknown' }], areas);
  assert.deepEqual(listRegisteredAreas(regs).map(area => area.id), ['b', 'empty', 'a']);
  assert.deepEqual(deriveRooms(regs, { 'light.unknown': state('light.unknown', 'off') }).map(room => room.id), ['b', 'empty', 'a', UNASSIGNED_ROOM_ID]);
  assert.deepEqual(areas, [original[2], original[1], original[0]], 'reorder changes no room metadata');
  assert.equal(deriveRooms(regs)[2].picture, '/local/room.jpg');
});

test('area reorder rejects malformed, duplicate and synthetic IDs before any request', async () => {
  const calls = [];
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => calls.push(payload) };
  for (const value of [null, 'a', {}, ['a', 'a'], [''], [' a'], ['a '], [null], [1], [UNASSIGNED_ROOM_ID], Array(1)]) {
    await assert.rejects(reorderAreas(hass, value), TypeError);
  }
  assert.deepEqual(calls, []);
});

test('area reorder includes every current registered area exactly once and rejects stale lists without writes', async () => {
  for (const ids of [[], ['a'], ['a', 'missing'], ['a', 'empty', 'extra']]) {
    const calls = [];
    const hass = { connected: true, user: { is_admin: true }, callWS: async payload => {
      calls.push(payload);
      return [{ area_id: 'a', name: 'Raum' }, { area_id: 'empty', name: 'Leer' }];
    } };
    await assert.rejects(reorderAreas(hass, ids), /aktuelle Liste/);
    assert.deepEqual(calls, [{ type: 'config/area_registry/list' }]);
  }
  for (const areas of [null, {}, [null], [{ area_id: ' a' }], [{ area_id: 'a' }, { area_id: 'a' }]]) {
    let reads = 0;
    const hass = { connected: true, user: { is_admin: true }, callWS: async () => { reads++; return areas; } };
    await assert.rejects(reorderAreas(hass, ['a']), /ungültige Raumdaten/);
    assert.equal(reads, 1);
  }
});

test('area reorder requires an administrator and active connection before reading or writing', async () => {
  let calls = 0;
  const allowed = { connected: true, user: { is_admin: true }, callWS: async () => { calls++; return []; } };
  for (const user of [undefined, {}, { is_admin: false }]) await assert.rejects(reorderAreas({ ...allowed, user }, []), /Administratoren/);
  for (const connected of [false, undefined]) await assert.rejects(reorderAreas({ ...allowed, connected }, []), /unterbrochen/);
  await assert.rejects(reorderAreas(null, []), /unterbrochen/);
  await assert.rejects(reorderAreas({ ...allowed, callWS: undefined }, []), /unterbrochen/);
  assert.equal(calls, 0);
});

test('area reorder rechecks permission and connection after the registry read', async () => {
  for (const change of [hass => { hass.connected = false; }, hass => { hass.user = { is_admin: false }; }, hass => { hass.connection = {}; }]) {
    let calls = 0;
    const hass = { connected: true, connection: {}, user: { is_admin: true }, callWS: async () => {
      calls++;
      change(hass);
      return [{ area_id: 'a', name: 'Raum' }];
    } };
    await assert.rejects(reorderAreas(hass, ['a']));
    assert.equal(calls, 1, 'never writes after a connection or permission change');
  }
});

test('area reorder copies the requested order before awaiting and supports an actually empty registry', async () => {
  const ids = ['b', 'a'], calls = [];
  let resolveRead;
  const hass = { connected: true, user: { is_admin: true }, callWS: payload => {
    calls.push(payload);
    return payload.type.endsWith('/list') ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve();
  } };
  const pending = reorderAreas(hass, ids);
  ids.reverse();
  resolveRead([{ area_id: 'a', name: 'A' }, { area_id: 'b', name: 'B' }]);
  await pending;
  assert.deepEqual(calls[1], { type: 'config/area_registry/reorder', area_ids: ['b', 'a'] });
  calls.length = 0;
  const empty = reorderAreas(hass, []);
  resolveRead([]);
  await empty;
  assert.deepEqual(calls[1], { type: 'config/area_registry/reorder', area_ids: [] });
});

test('area reorder preserves native errors, including a server-side registry race', async () => {
  for (const failRead of [true, false]) {
    const failure = { code: failRead ? 'not_connected' : 'invalid_format', message: 'Current area IDs changed' };
    const calls = [];
    const hass = { connected: true, user: { is_admin: true }, callWS: async payload => {
      calls.push(payload);
      if (failRead || payload.type.endsWith('/reorder')) throw failure;
      return [{ area_id: 'a', name: 'Room' }];
    } };
    await assert.rejects(reorderAreas(hass, ['a']), error => error === failure);
    assert.equal(calls.length, failRead ? 1 : 2);
  }
});

test('area create and rename trim names, target exact registry IDs and preserve server responses', async () => {
  const calls = [], response = { area_id: 'reading_room', name: 'Lesezimmer', aliases: [], floor_id: null };
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => { calls.push(payload); return response; } };
  assert.equal(await createArea(hass, ' \tLesezimmer\n '), response);
  assert.equal(await renameArea(hass, 'existing-id', '\u00a0Bibliothek & Büro\u00a0'), response);
  assert.deepEqual(calls, [
    { type: 'config/area_registry/create', name: 'Lesezimmer' },
    { type: 'config/area_registry/update', area_id: 'existing-id', name: 'Bibliothek & Büro' },
  ]);
});

test('area writes require an explicitly connected administrator before sending any WS request', async () => {
  const calls = [];
  const allowed = { connected: true, user: { is_admin: true }, callWS: async payload => calls.push(payload) };
  for (const user of [undefined, {}, { is_admin: false }, { is_admin: 'true' }, { is_owner: true }]) {
    await assert.rejects(createArea({ ...allowed, user }, 'Room'), /Administratoren/);
    await assert.rejects(renameArea({ ...allowed, user }, 'room', 'Room'), /Administratoren/);
  }
  for (const connected of [false, undefined, null]) {
    await assert.rejects(createArea({ ...allowed, connected }, 'Room'), /unterbrochen/);
    await assert.rejects(renameArea({ ...allowed, connected }, 'room', 'Room'), /unterbrochen/);
  }
  await assert.rejects(createArea(null, 'Room'), /unterbrochen/);
  await assert.rejects(renameArea({ ...allowed, callWS: undefined }, 'room', 'Room'), /unterbrochen/);
  assert.deepEqual(calls, []);
});

test('area validation rejects empty or excessive names and invalid/synthetic targets without writes', async () => {
  const calls = [];
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => calls.push(payload) };
  for (const name of ['', ' \n\t\u00a0 ', null, undefined, 42, {}, 'x'.repeat(AREA_NAME_MAX_LENGTH + 1)]) {
    await assert.rejects(createArea(hass, name), /Raumname/);
    await assert.rejects(renameArea(hass, 'room', name), /Raumname/);
  }
  for (const id of [null, undefined, '', ' ', ' room ', UNASSIGNED_ROOM_ID]) {
    await assert.rejects(renameArea(hass, id, 'Room'), /registrierten Raum/);
  }
  assert.deepEqual(calls, []);
  await createArea(hass, `  ${'x'.repeat(AREA_NAME_MAX_LENGTH)}  `);
  assert.equal(calls[0].name.length, AREA_NAME_MAX_LENGTH);
});

test('HA area errors retain their original code and identity, without retries or fallback writes', async () => {
  const failure = { code: 'invalid_info', message: 'Name already in use' }, calls = [];
  const hass = { connected: true, user: { is_admin: true }, callWS: async payload => { calls.push(payload); throw failure; } };
  await assert.rejects(createArea(hass, 'Room'), error => error === failure);
  await assert.rejects(renameArea(hass, 'room', 'Renamed'), error => error === failure);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ type }) => type === 'config/area_registry/create' || type === 'config/area_registry/update'));
});

const IMAGE_ID = 'a'.repeat(32);
const IMAGE_URL = `/api/image/serve/${IMAGE_ID}/512x512`;
const imageFile = (type = 'image/png', bytes = new Uint8Array([137, 80, 78, 71])) => new File([bytes], 'room.png', { type });
function imageHass() {
  const calls = [], uploads = [];
  return {
    connected: true, user: { is_admin: true }, connection: {}, calls, uploads,
    callWS: async payload => { calls.push(payload); return payload.type === 'config/area_registry/list' ? [] : { area_id: 'room', ...payload }; },
    fetchWithAuth: async (path, init) => { uploads.push({ path, init }); return new Response(JSON.stringify({ id: IMAGE_ID, name: 'room.png' }), { status: 200 }); },
  };
}

test('image selection validation follows actual HA MIME/10 MiB limits and name validation stays pure', () => {
  assert.equal(AREA_IMAGE_ACCEPT, 'image/jpeg,image/png,image/gif');
  assert.equal(AREA_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  for (const type of AREA_IMAGE_ACCEPT.split(',')) {
    const file = imageFile(type);
    assert.equal(validateAreaImageFile(file), file);
  }
  for (const type of ['image/webp', 'image/svg+xml', 'image/heic', 'application/octet-stream', '']) {
    assert.throws(() => validateAreaImageFile(imageFile(type)), /JPEG.*PNG.*GIF/);
  }
  assert.throws(() => validateAreaImageFile(null), /Bilddatei/);
  assert.throws(() => validateAreaImageFile({ type: 'image/png', size: 4 }), /Bilddatei/);
  assert.throws(() => validateAreaImageFile(imageFile('image/png', new Uint8Array())), /leer/);
  assert.throws(() => validateAreaImageFile(imageFile('image/png', new Uint8Array(AREA_IMAGE_MAX_BYTES + 1))), /10 MiB/);
  assert.equal(validateAreaImageFile(imageFile('image/png', new Uint8Array(AREA_IMAGE_MAX_BYTES))).size, AREA_IMAGE_MAX_BYTES);
  assert.equal(validateAreaName('  Arbeitszimmer  '), 'Arbeitszimmer');
  assert.throws(() => validateAreaName(' \n '), /Raumname/);
});

test('upload delegates authentication to HA and sends only the multipart file field', async () => {
  const hass = imageHass(), file = imageFile();
  assert.deepEqual(await uploadAreaImage(hass, file), { id: IMAGE_ID, url: IMAGE_URL });
  assert.equal(hass.uploads.length, 1);
  const [{ path, init }] = hass.uploads;
  assert.equal(path, '/api/image/upload');
  assert.deepEqual(Object.keys(init).sort(), ['body', 'method']);
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  assert.deepEqual([...init.body.keys()], ['file']);
  assert.equal(init.body.get('file').name, file.name);
  assert.equal(init.body.get('file').type, file.type);
  assert.deepEqual(await init.body.get('file').arrayBuffer(), await file.arrayBuffer());
  assert.deepEqual(hass.calls, []);
});

test('upload and cleanup reject invalid permissions/connections/files before network calls', async () => {
  const hass = imageHass(), file = imageFile();
  for (const invalid of [{ ...hass, connected: false }, { ...hass, user: { is_admin: false } }, { ...hass, connection: null }]) {
    await assert.rejects(uploadAreaImage(invalid, file), /Verbindung|Administratoren/);
    await assert.rejects(deleteUploadedAreaImage(invalid, IMAGE_ID), /Verbindung|Administratoren/);
  }
  await assert.rejects(uploadAreaImage({ ...hass, fetchWithAuth: undefined }, file), /Bildupload/);
  await assert.rejects(uploadAreaImage(hass, imageFile('image/webp')), /JPEG/);
  assert.deepEqual(hass.uploads, []);
  assert.deepEqual(hass.calls, []);
});

test('upload reports HTTP failures, preserves transport errors and rejects malformed success data', async () => {
  const hass = imageHass(), failure = new Error('Connection closed');
  await assert.rejects(uploadAreaImage({ ...hass, fetchWithAuth: async () => { throw failure; } }, imageFile()), error => error === failure);
  await assert.rejects(uploadAreaImage({ ...hass, fetchWithAuth: async () => new Response('too large', { status: 413 }) }, imageFile()), error => error.status === 413 && /10 MiB/.test(error.message));
  await assert.rejects(uploadAreaImage({ ...hass, fetchWithAuth: async () => new Response(JSON.stringify({ code: 'invalid_image', message: 'Unable to identify image file' }), { status: 400 }) }, imageFile()), error => error.code === 'invalid_image' && error.status === 400 && error.message === 'Unable to identify image file');
  for (const data of [{}, { id: '../other' }, null]) {
    await assert.rejects(uploadAreaImage({ ...hass, fetchWithAuth: async () => new Response(JSON.stringify(data)) }, imageFile()), /ungültige Bildantwort/);
  }
});

test('create/update atomically send only explicit name/picture changes; removal is null and rename preserves images', async () => {
  const hass = imageHass();
  await createArea(hass, '  New room  ', { picture: IMAGE_URL });
  await updateArea(hass, 'room', { name: '  New name  ', picture: IMAGE_URL });
  await updateArea(hass, 'room', { picture: null });
  await renameArea(hass, 'room', 'Rename only');
  assert.deepEqual(hass.calls, [
    { type: 'config/area_registry/create', name: 'New room', picture: IMAGE_URL },
    { type: 'config/area_registry/update', area_id: 'room', name: 'New name', picture: IMAGE_URL },
    { type: 'config/area_registry/update', area_id: 'room', picture: null },
    { type: 'config/area_registry/update', area_id: 'room', name: 'Rename only' },
  ]);
  for (const changes of [{}, { floor_id: 'elsewhere' }, { name: '' }, { picture: undefined }, { picture: 'blob:preview' }, { picture: 'data:image/png;base64,AAA' }, { picture: '//example.com/photo' }]) {
    await assert.rejects(updateArea(hass, 'room', changes));
  }
  await assert.rejects(createArea(hass, 'Room', { picture: 'javascript:alert(1)' }));
  assert.equal(hass.calls.length, 4);
});

test('cleanup deletes only its own unattached upload after checking real area references', async () => {
  const hass = imageHass();
  assert.equal(await deleteUploadedAreaImage(hass, IMAGE_ID), false, 'existing images are not owned');
  const image = await uploadAreaImage(hass, imageFile());
  assert.equal(await deleteUploadedAreaImage({ ...hass, connection: {} }, image.id), false, 'ownership cannot cross HA connections');
  assert.deepEqual(hass.calls, []);
  assert.equal(await deleteUploadedAreaImage(hass, image.id), true);
  assert.deepEqual(hass.calls, [
    { type: 'config/area_registry/list' },
    { type: 'image/delete', image_id: IMAGE_ID },
  ]);
  assert.equal(await deleteUploadedAreaImage(hass, image.id), false);
  assert.equal(hass.calls.length, 2);
});

test('successful area assignment ends upload ownership and never deletes the attached image', async () => {
  for (const create of [true, false]) {
    const hass = imageHass(), image = await uploadAreaImage(hass, imageFile());
    if (create) await createArea(hass, 'Room', { picture: image.url });
    else await updateArea(hass, 'room', { picture: image.url });
    assert.equal(await deleteUploadedAreaImage(hass, image.id), false);
    assert.equal(hass.calls.length, 1);
  }
});

test('cleanup preserves images referenced by any actual room, including a commit whose reply failed', async () => {
  for (const picture of [IMAGE_URL, `https://ha.example/api/image/serve/${IMAGE_ID}/original?cache=1`, `media-source://image_upload/${IMAGE_ID}`]) {
    const hass = imageHass(), image = await uploadAreaImage(hass, imageFile());
    const failure = { code: 'connection_lost', message: 'Reply lost after commit' };
    hass.callWS = async payload => {
      hass.calls.push(payload);
      if (payload.type === 'config/area_registry/update') throw failure;
      return [{ area_id: 'some-other-room', picture }];
    };
    await assert.rejects(updateArea(hass, 'room', { picture: image.url }), error => error === failure);
    assert.equal(await deleteUploadedAreaImage(hass, image.id), false);
    assert.deepEqual(hass.calls.map(call => call.type), ['config/area_registry/update', 'config/area_registry/list']);
  }
});

test('cleanup registry errors retain ownership for retry and never issue a deletion', async () => {
  const hass = imageHass(), image = await uploadAreaImage(hass, imageFile());
  const failure = { code: 'connection_lost' };
  hass.callWS = async payload => { hass.calls.push(payload); throw failure; };
  await assert.rejects(deleteUploadedAreaImage(hass, image.id), error => error === failure);
  assert.deepEqual(hass.calls, [{ type: 'config/area_registry/list' }]);
  hass.callWS = async payload => { hass.calls.push(payload); return payload.type === 'config/area_registry/list' ? [] : null; };
  assert.equal(await deleteUploadedAreaImage(hass, image.id), true);
  assert.equal(hass.calls.filter(call => call.type === 'image/delete').length, 1);
});

test('discard waits for pending assignment and cannot delete a concurrently saved image', async () => {
  const hass = imageHass(), image = await uploadAreaImage(hass, imageFile());
  let resolve;
  hass.callWS = payload => { hass.calls.push(payload); return new Promise(done => { resolve = done; }); };
  const save = updateArea(hass, 'room', { picture: image.url });
  const discard = deleteUploadedAreaImage(hass, image.id);
  await Promise.resolve();
  assert.deepEqual(hass.calls.map(call => call.type), ['config/area_registry/update']);
  resolve({ area_id: 'room', picture: image.url });
  await save;
  assert.equal(await discard, false);
  assert.equal(hass.calls.length, 1);
});

test('duplicate cleanup requests share one registry check and one explicitly targeted deletion', async () => {
  const hass = imageHass(), image = await uploadAreaImage(hass, imageFile());
  const results = await Promise.all([deleteUploadedAreaImage(hass, image.id), deleteUploadedAreaImage(hass, image.id)]);
  assert.deepEqual(results, [true, true]);
  assert.deepEqual(hass.calls, [{ type: 'config/area_registry/list' }, { type: 'image/delete', image_id: IMAGE_ID }]);
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

test('room detail keeps device controls and excludes sensors and configuration/system rows', () => {
  const ids = ['light.a', 'cover.a', 'switch.a', 'fan.a', 'climate.a', 'vacuum.a', 'media_player.a',
    'sensor.a', 'binary_sensor.a', 'lock.a', 'button.a', 'input_boolean.a', 'automation.a',
    'script.a', 'scene.a', 'update.a', 'person.a', 'weather.a', 'zone.a', 'sun.a'];
  const regs = registry([...ids.map((id) => assigned(id)), assigned('sensor.diagnostic', { entity_category: 'diagnostic' }), assigned('switch.config', { entity_category: 'config' })]);
  const states = Object.fromEntries(regs.entities.map(({ entity_id }) => [entity_id, state(entity_id, 'off')]));
  const rows = deriveRoomDevices(deriveRooms(regs, states)[0]);
  assert.deepEqual(rows.map((entity) => entity.id), ['light.a', 'cover.a', 'switch.a', 'fan.a', 'climate.a', 'vacuum.a',
    'media_player.a', 'lock.a', 'button.a', 'input_boolean.a'].sort());
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
