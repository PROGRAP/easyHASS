/** Home Assistant data and commands. No room or device configuration lives here. */
const REGISTRIES = ['area', 'device', 'entity'];
const UNAVAILABLE = new Set(['unavailable', 'unknown']);
const BRIGHTNESS_MODES = new Set(['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white']);
const COVER = Object.freeze({ open: 1, close: 2, position: 4, stop: 8 });
const VACUUM = Object.freeze({ start: 8192, pause: 4, stop: 8, return_to_base: 16, locate: 512, clean_spot: 1024 });
const DETAIL_EXCLUDED_DOMAINS = new Set([
  'automation', 'script', 'scene', 'update', 'person', 'weather', 'zone', 'sun',
  'device_tracker', 'persistent_notification', 'conversation', 'stt', 'tts',
  'ai_task', 'notify', 'wake_word',
]);
export const UNASSIGNED_ROOM_ID = '__easy_hass_unassigned__';

const entries = (value) => Array.isArray(value) ? value : Object.values(value || {});
const numeric = (value) => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percent = (value) => Math.min(100, Math.max(0, Math.round(value)));
const feature = (attributes, flag) => (Number(attributes.supported_features || 0) & flag) !== 0;

/** Fetch a complete snapshot; failed requests reject instead of fabricating empty rooms. */
export async function loadRegistries(hass) {
  const values = await Promise.all(REGISTRIES.map((name) => hass.callWS({ type: `config/${name}_registry/list` })));
  if (values.some((value) => !Array.isArray(value))) throw new Error('Home Assistant hat ungültige Raum- oder Gerätedaten geliefert.');
  return { areas: values[0], devices: values[1], entities: values[2] };
}

/**
 * Subscribe before the initial loadRegistries call. Reloads on registry edits and
 * reconnection; normal state updates come from the panel's hass setter.
 */
export async function subscribeRegistries(hass, onReload, onError = () => {}) {
  const connection = hass.connection;
  if (!connection?.subscribeEvents) throw new Error('Die Home-Assistant-Verbindung fehlt.');
  let active = true;
  let timer;
  let loading = false;
  let again = false;
  const unsubscribers = [];
  const refresh = async () => {
    if (!active) return;
    if (loading) { again = true; return; }
    loading = true;
    try {
      const registries = await loadRegistries(hass);
      if (active) onReload(registries);
    } catch (error) {
      if (active) onError(error);
    } finally {
      loading = false;
      if (active && again) { again = false; schedule(); }
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (active) timer = setTimeout(refresh, 50);
  };
  const cleanup = () => {
    active = false;
    clearTimeout(timer);
    connection.removeEventListener?.('ready', schedule);
    for (const unsubscribe of unsubscribers) Promise.resolve().then(unsubscribe).catch(() => {});
  };
  const subscriptions = await Promise.allSettled(REGISTRIES.map((name) =>
    connection.subscribeEvents(schedule, `${name}_registry_updated`)));
  for (const subscription of subscriptions) {
    if (subscription.status === 'fulfilled') unsubscribers.push(subscription.value);
  }
  const failed = subscriptions.find((subscription) => subscription.status === 'rejected');
  if (failed) { cleanup(); throw failed.reason; }
  connection.addEventListener?.('ready', schedule);
  return cleanup;
}

function entityModel(entityId, state, registry = {}, device = {}) {
  const attributes = state?.attributes || {};
  const domain = entityId.split('.')[0];
  const available = Boolean(state && typeof state.state === 'string' && state.state && !UNAVAILABLE.has(state.state));
  const modes = attributes.supported_color_modes;
  const canDim = domain === 'light' && Array.isArray(modes) && modes.some((mode) => BRIGHTNESS_MODES.has(mode));
  const brightness = numeric(attributes.brightness);
  const position = numeric(attributes.current_position);
  return {
    id: entityId, entity_id: entityId, domain,
    name: registry.name || attributes.friendly_name || registry.original_name || entityId,
    icon: registry.icon || attributes.icon || registry.original_icon || null,
    areaId: registry.area_id || device.area_id || null,
    deviceId: registry.device_id || null,
    deviceClass: registry.device_class || attributes.device_class || registry.original_device_class || null,
    state: state?.state || 'unavailable', attributes, available,
    category: registry.entity_category || null,
    canDim,
    brightness: domain === 'light' && available
      ? state.state === 'off' ? 0 : brightness === null ? null : percent(brightness / 255 * 100)
      : null,
    canOpen: domain === 'cover' && feature(attributes, COVER.open),
    canClose: domain === 'cover' && feature(attributes, COVER.close),
    canSetPosition: domain === 'cover' && feature(attributes, COVER.position),
    canStop: domain === 'cover' && feature(attributes, COVER.stop),
    position: domain === 'cover' && available && position !== null ? percent(position) : null,
    actions: domain === 'vacuum' ? Object.entries(VACUUM).filter(([, flag]) => feature(attributes, flag)).map(([action]) => action) : [],
  };
}

/** Includes state-only YAML entities as well as registered but unavailable entities. */
export function deriveEntities(registries, states = {}) {
  const deviceById = new Map(entries(registries?.devices).map((device) => [device.id, device]));
  const registryById = new Map(entries(registries?.entities).map((entity) => [entity.entity_id, entity]));
  const ids = new Set([...Object.keys(states), ...registryById.keys()]);
  return [...ids].filter(Boolean).flatMap((id) => {
    const registry = registryById.get(id) || {};
    const device = deviceById.get(registry.device_id) || {};
    if (registry.hidden_by || registry.disabled_by || device.disabled_by) return [];
    return [entityModel(id, states[id], registry, device)];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Prefer visible available group entities to their visible members, once only. */
function withoutGroupMembers(entities) {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const descendants = (entity, seen = new Set()) => {
    if (seen.has(entity.id)) return seen;
    seen.add(entity.id);
    for (const id of entity.attributes.entity_id || []) {
      const child = byId.get(id);
      if (child) descendants(child, seen);
    }
    return seen;
  };
  const groups = entities.filter((entity) => entity.available && Array.isArray(entity.attributes.entity_id)
    && entity.attributes.entity_id.length).map((entity) => ({ entity, members: descendants(entity) }))
    .sort((a, b) => b.members.size - a.members.size || a.entity.id.localeCompare(b.entity.id));
  const hidden = new Set();
  for (const { entity, members } of groups) {
    if (hidden.has(entity.id)) continue;
    for (const id of members) if (id !== entity.id) hidden.add(id);
  }
  return entities.filter((entity) => !hidden.has(entity.id));
}

function lightSummary(lights) {
  const available = lights.filter((entity) => entity.available);
  const on = available.filter((entity) => entity.state === 'on');
  const dimmable = available.filter((entity) => entity.canDim);
  const levels = dimmable.map((entity) => entity.brightness).filter((value) => value !== null);
  return {
    count: lights.length, availableCount: available.length, unavailableCount: lights.length - available.length,
    onCount: on.length, isOn: on.length > 0, allOn: available.length > 0 && on.length === available.length,
    mixed: on.length > 0 && on.length < available.length,
    canToggle: available.length > 0, canDim: dimmable.length > 0,
    brightness: levels.length ? percent(mean(levels)) : null,
    brightnessMixed: new Set(levels).size > 1,
    dimmableCount: dimmable.length,
  };
}

function coverSummary(covers) {
  const available = covers.filter((entity) => entity.available);
  const moving = available.filter((entity) => entity.state === 'opening' || entity.state === 'closing');
  const positions = available.map((entity) => entity.position).filter((value) => value !== null);
  const open = available.filter((entity) => entity.position === null ? entity.state !== 'closed' : entity.position > 0);
  const closing = open.length > 0;
  return {
    count: covers.length, availableCount: available.length, unavailableCount: covers.length - available.length,
    isOpen: open.length > 0, allClosed: available.length > 0 && open.length === 0,
    moving: moving.length > 0,
    canStop: moving.some((entity) => entity.canStop),
    mixed: new Set(positions).size > 1 || (open.length > 0 && open.length < available.length),
    position: positions.length ? percent(mean(positions)) : null,
    canToggle: moving.length > 0 ? moving.some((entity) => entity.canStop)
      : available.some((entity) => entity.canSetPosition || (closing ? entity.canClose : entity.canOpen)),
    canSetPosition: available.some((entity) => entity.canSetPosition),
    canPosition: available.some((entity) => entity.canSetPosition),
    positionCount: available.filter((entity) => entity.canSetPosition).length,
  };
}

function climateReading(roomEntities, allEntities, deviceClass, preferredId) {
  const sensors = roomEntities.filter((entity) => entity.domain === 'sensor' && entity.deviceClass === deviceClass && !entity.category);
  const preferred = preferredId && allEntities.find((entity) => entity.id === preferredId && entity.domain === 'sensor' && entity.deviceClass === deviceClass);
  const entity = preferred || sensors.find((candidate) => candidate.available && numeric(candidate.state) !== null) || sensors[0];
  if (!entity) return null;
  const value = entity.available ? numeric(entity.state) : null;
  return {
    entityId: entity.id, name: entity.name, value,
    unit: entity.attributes.unit_of_measurement || (deviceClass === 'humidity' ? '%' : ''),
    available: entity.available && value !== null,
    state: entity.state, sourceCount: sensors.length,
  };
}

function makeRoom(area, roomEntities, allEntities, unassigned = false) {
  const lights = withoutGroupMembers(roomEntities.filter((entity) => entity.domain === 'light' && !entity.category));
  const covers = withoutGroupMembers(roomEntities.filter((entity) => entity.domain === 'cover' && !entity.category));
  return {
    id: area.area_id || area.id, name: area.name,
    picture: area.picture || null, icon: area.icon || null,
    floorId: area.floor_id || null, unassigned,
    entities: roomEntities, lights, covers,
    light: lightSummary(lights), cover: coverSummary(covers),
    temperature: climateReading(roomEntities, allEntities, 'temperature', area.temperature_entity_id),
    humidity: climateReading(roomEntities, allEntities, 'humidity', area.humidity_entity_id),
  };
}

/** Preserve the user's HA area order and keep empty areas. */
export function deriveRooms(registries, states = {}) {
  const entities = deriveEntities(registries, states);
  const areas = entries(registries?.areas);
  const areaIds = new Set(areas.map((area) => area.area_id || area.id));
  const rooms = areas.map((area) => makeRoom(area, entities.filter((entity) => entity.areaId === (area.area_id || area.id)), entities));
  const unassigned = entities.filter((entity) => !areaIds.has(entity.areaId) && !entity.category && (
    ['light', 'cover', 'climate', 'fan', 'switch', 'vacuum'].includes(entity.domain)
    || (entity.domain === 'sensor' && ['temperature', 'humidity'].includes(entity.deviceClass))
  ));
  if (unassigned.length) rooms.push(makeRoom({ area_id: UNASSIGNED_ROOM_ID, name: 'Ohne Raum' }, unassigned, entities, true));
  return rooms;
}

/** Scope metadata is independent of visibility and can never become a device row. */
function deriveEntityScopes(registries, states) {
  const devices = new Map(entries(registries?.devices).map((device) => [device.id, device]));
  const registry = new Map(entries(registries?.entities).map((entity) => [entity.entity_id, entity]));
  const ids = new Set([...Object.keys(states), ...registry.keys()]);
  return Object.freeze(Object.fromEntries([...ids].filter(Boolean).map((id) => {
    const entry = registry.get(id) || {};
    const members = states[id]?.attributes?.entity_id;
    return [id, Object.freeze({
      id, areaId: entry.area_id || devices.get(entry.device_id)?.area_id || null,
      memberIds: Object.freeze(Array.isArray(members) ? [...new Set(members.filter((member) => typeof member === 'string' && member))] : []),
    })];
  })));
}

export function deriveHome(registries, states = {}) {
  const entities = deriveEntities(registries, states);
  return {
    rooms: deriveRooms(registries, states), entities, entityScopes: deriveEntityScopes(registries, states),
    vacuums: entities.filter((entity) => entity.domain === 'vacuum'),
    weather: entities.filter((entity) => entity.domain === 'weather'),
    people: entities.filter((entity) => entity.domain === 'person'),
    // Keep distinct meters separate; summing them can double-count consumption.
    energy: entities.filter((entity) => entity.domain === 'sensor' && !entity.category && ['energy', 'power'].includes(entity.deviceClass)),
  };
}

/**
 * Room-detail rows preserve real HA group boundaries, including shared groups.
 * Unlike the home summary, an unavailable group still represents its members.
 * allEntities supplies visible candidate rows. Optional entityScopes contains
 * topology only, including hidden members; it never supplies rows/suppressors.
 */
export function deriveRoomDevices(room, allEntities = room.entities, entityScopes) {
  const relevant = (entity) => entity?.id && !entity.category && !entity.hidden_by && !entity.disabled_by
    && !DETAIL_EXCLUDED_DOMAINS.has(entity.domain);
  const locals = (room.entities || []).filter(relevant);
  const localIds = new Set(locals.map((entity) => entity.id));
  const all = new Map([...entries(allEntities), ...locals].filter(relevant).map((entity) => [entity.id, entity]));
  const memberIds = (entity) => Array.isArray(entity.attributes?.entity_id)
    ? [...new Set(entity.attributes.entity_id.filter((id) => typeof id === 'string' && id))] : [];
  const isGroup = (entity) => entity.domain === 'group' || memberIds(entity).length > 0;
  const scopes = new Map([...all.values()].map((entity) => [entity.id, { id: entity.id, areaId: entity.areaId, memberIds: memberIds(entity) }]));
  for (const scope of entries(entityScopes)) scopes.set(scope.id, scope);
  const scopeLocalIds = new Set(localIds);
  for (const scope of scopes.values()) {
    if (scope.areaId === room.id || (room.unassigned && !scope.areaId)) scopeLocalIds.add(scope.id);
  }
  const descendants = (entity) => {
    const ids = new Set();
    const visit = (current) => {
      for (const id of current.memberIds || []) {
        if (id === entity.id || ids.has(id)) continue;
        ids.add(id);
        const child = scopes.get(id);
        if (child) visit(child);
      }
    };
    visit(scopes.get(entity.id));
    return ids;
  };
  const leafCount = (entity) => {
    const leaves = new Set();
    const visited = new Set();
    const visit = (current) => {
      if (visited.has(current.id)) return;
      visited.add(current.id);
      for (const id of current.memberIds || []) {
        if (id === entity.id) continue;
        const child = scopes.get(id);
        if (child && (child.id.startsWith('group.') || child.memberIds?.length)) visit(child);
        else leaves.add(id);
      }
    };
    visit(scopes.get(entity.id));
    return leaves.size;
  };
  const groups = [...all.values()].filter(isGroup).map((entity) => ({ entity, descendants: descendants(entity) }))
    .filter(({ entity, descendants: ids }) => localIds.has(entity.id) || entity.areaId === room.id
      || [...ids].some((id) => scopeLocalIds.has(id)))
    .sort((a, b) => b.descendants.size - a.descendants.size || a.entity.id.localeCompare(b.entity.id));
  const suppressed = new Set();
  const selectedGroups = [];
  for (const group of groups) {
    if (suppressed.has(group.entity.id)) continue;
    selectedGroups.push(group);
    for (const id of group.descendants) suppressed.add(id);
  }
  const selectedIds = new Set(selectedGroups.map(({ entity }) => entity.id));
  const rows = locals.filter((entity) => !suppressed.has(entity.id) && !selectedIds.has(entity.id))
    .map((entity) => ({ ...entity, isGroup: false, memberCount: 0, isSharedGroup: false }));
  for (const { entity, descendants: ids } of selectedGroups) {
    const memberScopes = [entity, ...[...ids].map((id) => scopes.get(id)).filter(Boolean)];
    rows.push({
      ...entity, isGroup: true, memberCount: leafCount(entity),
      isSharedGroup: memberScopes.some((member) => member.areaId && member.areaId !== room.id),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Reuse the room gesture/actions against exactly one real entity or HA group. */
export function entityControlTarget(entity) {
  const lights = entity.domain === 'light' ? [entity] : [];
  const covers = entity.domain === 'cover' ? [entity] : [];
  return { id: `entity:${entity.id}`, name: entity.name, lights, covers, light: lightSummary(lights), cover: coverSummary(covers) };
}

/** Return HA's actual picture URL. UI must assign it as an attribute/property. */
export function pictureUrl(hass, picture) {
  if (!picture || typeof picture !== 'string') return null;
  if (/^https?:\/\//i.test(picture)) return picture;
  if (!picture.startsWith('/') || picture.startsWith('//')) return null;
  return hass?.hassUrl ? hass.hassUrl(picture) : picture;
}

function latest(hass, entities) {
  return entities.map((entity) => entityModel(entity.id, hass.states?.[entity.id])).filter((entity) => entity.available);
}

async function callTargets(hass, domain, service, entities, data = {}) {
  const entityIds = [...new Set(entities.map((entity) => entity.id))];
  if (!entityIds.length) throw new Error('Kein verfügbares Gerät unterstützt diese Aktion.');
  if (hass.connected === false) throw new Error('Die Verbindung zu Home Assistant ist unterbrochen.');
  // Entity targets are explicit: never issue an unscoped service call.
  return hass.callService(domain, service, { ...data, entity_id: entityIds });
}

function validPercent(value) {
  const number = numeric(value);
  if (number === null) throw new TypeError('Der Prozentwert ist ungültig.');
  return percent(number);
}

export function toggleRoomLights(hass, room) {
  const lights = latest(hass, room.lights || []);
  return callTargets(hass, 'light', lights.some((entity) => entity.state === 'on') ? 'turn_off' : 'turn_on', lights);
}

export function setRoomBrightness(hass, room, value) {
  const brightness = validPercent(value);
  const lights = latest(hass, room.lights || []).filter((entity) => entity.canDim);
  return callTargets(hass, 'light', brightness === 0 ? 'turn_off' : 'turn_on', lights, brightness === 0 ? {} : { brightness_pct: brightness });
}

export async function toggleRoomCovers(hass, room) {
  const covers = latest(hass, room.covers || []);
  const moving = covers.filter((entity) => entity.state === 'opening' || entity.state === 'closing');
  if (moving.length) return callTargets(hass, 'cover', 'stop_cover', moving.filter((entity) => entity.canStop));
  const close = covers.some((entity) => entity.position === null ? entity.state !== 'closed' : entity.position > 0);
  const direct = covers.filter((entity) => close ? entity.canClose : entity.canOpen);
  const positioned = covers.filter((entity) => !direct.includes(entity) && entity.canSetPosition);
  if (!direct.length && !positioned.length) throw new Error('Kein verfügbarer Rollladen unterstützt diese Aktion.');
  const calls = [];
  if (direct.length) calls.push(callTargets(hass, 'cover', close ? 'close_cover' : 'open_cover', direct));
  if (positioned.length) calls.push(callTargets(hass, 'cover', 'set_cover_position', positioned, { position: close ? 0 : 100 }));
  return Promise.all(calls);
}

export function setRoomCoverPosition(hass, room, value) {
  const position = validPercent(value);
  const covers = latest(hass, room.covers || []).filter((entity) => entity.canSetPosition);
  return callTargets(hass, 'cover', 'set_cover_position', covers, { position });
}

export function callVacuumAction(hass, entity, action) {
  const current = latest(hass, [entity]);
  if (!current[0]?.actions.includes(action)) return Promise.reject(new Error('Der Saugroboter unterstützt diese Aktion nicht.'));
  return callTargets(hass, 'vacuum', action, current);
}

export function toggleEntity(hass, entity) {
  const current = latest(hass, [entity]);
  const domain = current[0]?.domain;
  if (!['switch', 'fan', 'input_boolean'].includes(domain)) {
    return Promise.reject(new Error('Kein verfügbares Gerät unterstützt diese Aktion.'));
  }
  return callTargets(hass, domain, current[0].state === 'on' ? 'turn_off' : 'turn_on', current);
}
