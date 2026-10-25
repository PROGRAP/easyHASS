import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveHome, deriveRoomDevices } from '../frontend/src/ha-model.js';
import { renderRoomDetail } from '../frontend/src/room-detail.js';

const ids = ['light.a', 'light.b', 'cover.a', 'cover.b', 'switch.socket', 'sensor.temperature'];
const registries = {
  areas: [{ area_id: 'room', name: 'Zimmer' }], devices: [],
  entities: ids.map(entity_id => ({ entity_id, area_id: 'room' })),
};
const states = Object.fromEntries(ids.map(id => [id, { state: id.startsWith('cover.') ? 'open' : 'on',
  attributes: { friendly_name: id, supported_color_modes: ['brightness'], brightness: 128,
    supported_features: 15, current_position: 50 } }]));

function render(order = [], regs = registries, values = states) {
  const home = deriveHome(regs, values);
  const room = home.rooms[0], rows = deriveRoomDevices(room, home.entities, home.entityScopes, order);
  const html = renderRoomDetail(room, rows, { connected: true }, { reading: () => '', customOrder: order.length > 0 });
  const sections = [...html.matchAll(/<section class="device-section"[^>]*>(.*?)<\/section>/gs)].map(([, content]) => ({
    heading: /<h2[^>]*>([^<]+)<\/h2>/.exec(content)[1],
    ids: [...content.matchAll(/data-entity-row="([^"]+)"/g)].map(([, id]) => id),
  }));
  return { html, sections };
}

test('room detail retains standard device-type sections without a saved order', () => {
  assert.deepEqual(render().sections, [
    { heading: 'Licht', ids: ['light.a', 'light.b'] },
    { heading: 'Beschattung', ids: ['cover.a', 'cover.b'] },
    { heading: 'Schalter', ids: ['switch.socket'] },
  ]);
});

test('interleaved custom order keeps each type together and preserves order within its section', () => {
  const order = ['cover.b', 'light.b', 'switch.socket', 'light.a', 'cover.a'].map(id => `entity:${id}`);
  const before = [...order];
  assert.deepEqual(render(order).sections, [
    { heading: 'Beschattung', ids: ['cover.b', 'cover.a'] },
    { heading: 'Licht', ids: ['light.b', 'light.a'] },
    { heading: 'Schalter', ids: ['switch.socket'] },
  ]);
  assert.deepEqual(order, before);
});

test('partial and stale orders keep category headings and append new devices inside their type', () => {
  assert.deepEqual(render(['entity:missing.deleted', 'entity:light.b']).sections, [
    { heading: 'Licht', ids: ['light.b', 'light.a'] },
    { heading: 'Beschattung', ids: ['cover.a', 'cover.b'] },
    { heading: 'Schalter', ids: ['switch.socket'] },
  ]);
});

test('saved ordering retains HA groups as single rows inside their device-type section', () => {
  const regs = { ...registries, entities: [...registries.entities, { entity_id: 'light.group', area_id: 'room' }] };
  const values = { ...states, 'light.group': { state: 'on', attributes: { entity_id: ['light.a', 'light.b'] } } };
  const result = render(['entity:cover.b', 'entity:light.group', 'entity:cover.a'], regs, values);
  assert.deepEqual(result.sections, [
    { heading: 'Beschattung', ids: ['cover.b', 'cover.a'] },
    { heading: 'Licht', ids: ['light.group'] },
    { heading: 'Schalter', ids: ['switch.socket'] },
  ]);
  assert.match(result.html, /Gruppe · 2 Geräte/);
});

test('a saved order cannot create an empty device section in an empty room', () => {
  const result = render(['entity:missing.deleted'], { ...registries, entities: [] }, {});
  assert.deepEqual(result.sections, []);
  assert.match(result.html, /noch keine steuerbaren Geräte/);
});
