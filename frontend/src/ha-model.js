/** Home Assistant data and commands. No room or device configuration lives here. */
const REGISTRIES = ['area', 'device', 'entity'];
const UNAVAILABLE = new Set(['unavailable', 'unknown']);
const BRIGHTNESS_MODES = new Set(['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white']);
const COVER = Object.freeze({ open: 1, close: 2, position: 4, stop: 8 });
const VACUUM = Object.freeze({ start: 8192, pause: 4, stop: 8, return_to_base: 16, locate: 512, clean_spot: 1024 });
const DETAIL_EXCLUDED_DOMAINS = new Set([
  'sensor', 'binary_sensor',
  'automation', 'script', 'scene', 'update', 'person', 'weather', 'zone', 'sun',
  'device_tracker', 'persistent_notification', 'conversation', 'stt', 'tts',
  'ai_task', 'notify', 'wake_word',
]);
export const UNASSIGNED_ROOM_ID = '__easy_hass_unassigned__';
export const AREA_NAME_MAX_LENGTH = 100;
// Verified against HA 2026.10.2 components/image_upload: MIME types and MAX_SIZE.
export const AREA_IMAGE_ACCEPT = 'image/jpeg,image/png,image/gif';
export const AREA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const AREA_IMAGE_TYPES = new Set(AREA_IMAGE_ACCEPT.split(','));
const pendingAreaImages = new WeakMap();

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

function panelSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.hidden_area_ids)) {
    throw new Error('Home Assistant hat ungültige Anzeigeeinstellungen geliefert.');
  }
  const ids = Array.from(value.hidden_area_ids);
  if (ids.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id === UNASSIGNED_ROOM_ID)
    || new Set(ids).size !== ids.length) {
    throw new Error('Home Assistant hat ungültige Anzeigeeinstellungen geliefert.');
  }
  const result = { hidden_area_ids: [...ids] };
  // Optional maps keep older settings snapshots compatible.
  for (const field of ['room_device_order', 'room_device_links']) if (value[field] !== undefined) {
    const values = value[field];
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Home Assistant hat ungültige Geräteeinstellungen geliefert.');
    result[field] = Object.fromEntries(Object.entries(values).map(([areaId, keys]) => {
      validatedAreaId(areaId);
      return [areaId, validatedAssignmentOrder(keys)];
    }));
  }
  return result;
}

/** Panel-only preferences; every authenticated user may read the same snapshot. */
export async function loadPanelSettings(hass) {
  if (hass?.connected !== true || typeof hass.callWS !== 'function') throw new Error('Die Verbindung zu Home Assistant ist unterbrochen.');
  return panelSettings(await hass.callWS({ type: 'easy_hass/settings/get' }));
}

/** The HA connection resubscribes on reconnect, receiving a fresh initial push.
 * A ready refresh also reports a missing backend; newer pushes always win over
 * an older in-flight read. Disposal silences both paths and releases listeners.
 */
export async function subscribePanelSettings(hass, onSettings, onError = () => {}) {
  const connection = hass?.connection;
  if (typeof connection?.subscribeMessage !== 'function') throw new Error('Die Home-Assistant-Verbindung fehlt.');
  let active = true, revision = 0, request = 0, unsubscribe;
  const receive = value => {
    if (!active) return;
    let settings;
    try { settings = panelSettings(value); }
    catch (error) { onError(error); return; }
    revision++;
    onSettings(settings);
  };
  const refresh = async () => {
    if (!active) return;
    const pending = ++request, before = revision;
    try {
      const settings = await loadPanelSettings(hass);
      if (active && pending === request && before === revision) receive(settings);
    } catch (error) {
      if (active && pending === request && before === revision) onError(error);
    }
  };
  const cleanup = () => {
    if (!active) return;
    active = false;
    connection.removeEventListener?.('ready', refresh);
    if (unsubscribe) Promise.resolve().then(unsubscribe).catch(() => {});
  };
  connection.addEventListener?.('ready', refresh);
  try {
    unsubscribe = await connection.subscribeMessage(receive, { type: 'easy_hass/settings/subscribe' }, { resubscribe: true });
  } catch (error) { cleanup(); throw error; }
  return cleanup;
}

/** Change one room's visibility without overwriting other clients' preferences. */
export async function setRoomHidden(hass, areaId, hidden) {
  requireAreaWrite(hass);
  const id = validatedAreaId(areaId);
  if (typeof hidden !== 'boolean') throw new TypeError('Die Sichtbarkeit muss ein Wahrheitswert sein.');
  return panelSettings(await hass.callWS({ type: 'easy_hass/room_visibility/set', area_id: id, hidden }));
}

/** Actual HA areas, including empty ones, in HA's persisted registry order.
 * Copies retain HA fields; id is normalized for UI use. No synthetic room is added.
 */
export function listRegisteredAreas(registries) {
  return entries(registries?.areas).flatMap((area) => {
    const id = area?.area_id || area?.id;
    if (typeof id !== 'string' || !id.trim() || id === UNASSIGNED_ROOM_ID || area.unassigned || typeof area.name !== 'string') return [];
    return [{ ...area, id, area_id: id }];
  });
}

function assignmentKey(key) {
  if (typeof key !== 'string') throw new TypeError('Bitte ein registriertes Gerät auswählen.');
  const match = /^(device|entity):([^\s:]+)$/.exec(key);
  if (!match || (match[1] === 'entity' && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(match[2]))) throw new TypeError('Bitte ein registriertes Gerät auswählen.');
  return { kind: match[1], id: match[2] };
}

function validatedAssignmentOrder(keys) {
  if (!Array.isArray(keys)) throw new TypeError('Die Gerätereihenfolge muss eine Liste sein.');
  const result = Array.from(keys, key => { assignmentKey(key); return key; });
  if (new Set(result).size !== result.length) throw new TypeError('Jedes Gerät darf nur einmal in der Reihenfolge vorkommen.');
  return result;
}

function assignmentItems(registries, states) {
  const areas = new Map(listRegisteredAreas(registries).map(area => [area.id, area.name]));
  const registered = entries(registries?.entities), byEntity = new Map(registered.map(entity => [entity.entity_id, entity]));
  const devices = entries(registries?.devices).filter(device => device?.id && !device.disabled_by).map(device => {
    const entities = registered.filter(entity => entity.device_id === device.id);
    return {
      key: `device:${device.id}`, kind: 'device', id: device.id,
      name: device.name_by_user || device.name || [device.manufacturer, device.model].filter(Boolean).join(' ') || 'Gerät',
      areaId: device.area_id || null, areaName: areas.get(device.area_id) || null,
      entityIds: entities.map(entity => entity.entity_id), entityCount: entities.length,
      overrideCount: entities.filter(entity => entity.area_id && entity.area_id !== device.area_id).length,
      explicitAreaCount: entities.filter(entity => entity.area_id).length,
      isGroup: false, inherited: false,
    };
  });
  const independent = deriveEntities(registries, states).filter(entity => {
    const entry = byEntity.get(entity.id);
    return entry && !entry.device_id && !entity.category && !DETAIL_EXCLUDED_DOMAINS.has(entity.domain);
  }).map(entity => ({
    key: `entity:${entity.id}`, kind: 'entity', id: entity.id, name: entity.name,
    areaId: entity.areaId, areaName: areas.get(entity.areaId) || null,
    entityIds: [entity.id], entityCount: 1, overrideCount: 0, explicitAreaCount: 0,
    isGroup: entity.domain === 'group' || byEntity.get(entity.id)?.platform === 'group'
      || (Array.isArray(entity.attributes.entity_id) && entity.attributes.entity_id.length > 0),
    inherited: false,
  }));
  return [...devices, ...independent];
}

function assignmentRanks(order) {
  return new Map((Array.isArray(order) ? order : []).map((key, index) => [key, index]));
}

function sortAssignments(items, order) {
  const ranks = assignmentRanks(order);
  return items.sort((a, b) => (ranks.get(a.key) ?? Infinity) - (ranks.get(b.key) ?? Infinity)
    || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Native devices (including sensor devices) plus independently assigned controls.
 * A device shown through an entity's explicit area override is sortable, but
 * clearing its foreign native area would not remove that independent override.
 */
export function listRoomAssignments(registries, states = {}, areaId, order = [], settings = {}) {
  if (!listRegisteredAreas(registries).some(area => area.id === areaId)) return [];
  const all = assignmentItems(registries, states), items = new Map();
  const links = new Set(settings?.room_device_links?.[areaId] || []);
  for (const item of all) {
    if (item.areaId === areaId) items.set(item.key, { ...item, canRemove: true, isAdditional: false });
    else if (links.has(item.key)) items.set(item.key, { ...item, canRemove: true, isAdditional: true });
  }
  const room = deriveRooms(registries, states, settings).find(candidate => candidate.id === areaId);
  const rows = deriveRoomDevices(room, deriveEntities(registries, states), deriveEntityScopes(registries, states));
  for (const entity of rows) {
    const key = entity.deviceId ? `device:${entity.deviceId}` : `entity:${entity.id}`;
    const item = all.find(candidate => candidate.key === key);
    if (item && !items.has(key)) items.set(key, { ...item, inherited: true, canRemove: false,
      inheritedReason: entity.areaId === areaId ? 'entity' : 'group', isGroup: item.isGroup || entity.isGroup });
  }
  return sortAssignments([...items.values()], order);
}

/** Picker candidates retain their real current room; assigning moves that scope. */
export function listAssignableDevices(registries, states = {}, areaId, settings = {}) {
  if (!listRegisteredAreas(registries).some(area => area.id === areaId)) return [];
  const links = new Set(settings?.room_device_links?.[areaId] || []);
  return sortAssignments(assignmentItems(registries, states).filter(item => item.areaId !== areaId && !links.has(item.key)), []);
}

/** Only native area_id changes. Entity overrides on physical devices are retained.
 * Returns the updated device entry, or the entity response's entity_entry.
 */
export async function setDeviceRoom(hass, key, areaId) {
  requireAreaWrite(hass);
  const { kind, id } = assignmentKey(key), area = areaId === null ? null : validatedAreaId(areaId);
  const connection = hass.connection, registries = await loadRegistries(hass);
  requireAreaWrite(hass);
  if (hass.connection !== connection) throw new Error('Die Verbindung zu Home Assistant hat sich geändert. Bitte erneut versuchen.');
  if (area !== null && !listRegisteredAreas(registries).some(candidate => candidate.id === area)) throw new Error('Der ausgewählte Raum existiert nicht mehr.');
  if (!assignmentItems(registries, hass.states || {}).some(item => item.key === key)) throw new Error('Das ausgewählte Gerät existiert nicht mehr oder kann hier nicht zugeordnet werden.');
  const result = await hass.callWS({ type: `config/${kind}_registry/update`, [`${kind}_id`]: id, area_id: area });
  return kind === 'entity' ? result?.entity_entry : result;
}

/** Save one room's order atomically; [] restores its default order. */
export async function setRoomDeviceOrder(hass, areaId, keys) {
  requireAreaWrite(hass);
  const id = validatedAreaId(areaId), order = validatedAssignmentOrder(keys);
  return panelSettings(await hass.callWS({ type: 'easy_hass/room_device_order/set', area_id: id, keys: order }));
}

/** Additional display scope only; the original native HA assignment is untouched. */
export async function setRoomDeviceLink(hass, areaId, key, linked) {
  requireAreaWrite(hass);
  const id = validatedAreaId(areaId);
  assignmentKey(key);
  if (typeof linked !== 'boolean') throw new TypeError('Die zusätzliche Anzeige muss ein Wahrheitswert sein.');
  return panelSettings(await hass.callWS({ type: 'easy_hass/room_device_link/set', area_id: id, key, linked }));
}

/** Atomic server-side compare-and-assign, including an expected unassigned null.
 * Returns the settings snapshot after removing a redundant destination link.
 * Other extra-room links and native entity overrides stay unchanged.
 */
export async function assignDeviceRoom(hass, key, areaId, expectedAreaId) {
  requireAreaWrite(hass);
  assignmentKey(key);
  const area = areaId === null ? null : validatedAreaId(areaId);
  const expected = expectedAreaId === null ? null : validatedAreaId(expectedAreaId);
  return panelSettings(await hass.callWS({ type: 'easy_hass/room_device_assignment/set', key,
    area_id: area, expected_area_id: expected }));
}

export function validateAreaName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Bitte einen Raumnamen eingeben.');
  const name = value.trim();
  // A UI length bound, not a claim about the server's own name constraints.
  if (name.length > AREA_NAME_MAX_LENGTH) throw new RangeError(`Der Raumname darf höchstens ${AREA_NAME_MAX_LENGTH} Zeichen lang sein.`);
  return name;
}

function requireAreaWrite(hass) {
  if (hass?.connected !== true || typeof hass.callWS !== 'function') throw new Error('Die Verbindung zu Home Assistant ist unterbrochen.');
  if (hass.user?.is_admin !== true) throw new Error('Nur Administratoren können Räume bearbeiten.');
}

function validatedAreaId(areaId) {
  if (typeof areaId !== 'string' || !areaId.trim() || areaId !== areaId.trim() || areaId === UNASSIGNED_ROOM_ID) {
    throw new TypeError('Bitte einen registrierten Raum auswählen.');
  }
  return areaId;
}

function validatedAreaPicture(picture) {
  if (picture === null) return null;
  if (typeof picture !== 'string' || !picture || picture !== picture.trim()) throw new TypeError('Die Bildadresse ist ungültig.');
  if (picture.startsWith('/') && !picture.startsWith('//')) return picture;
  try {
    const url = new URL(picture);
    if (['http:', 'https:'].includes(url.protocol)) return picture;
  } catch { /* A local preview/blob URL must never enter the HA registry. */ }
  throw new TypeError('Die Bildadresse muss eine dauerhafte Home-Assistant- oder HTTP-Adresse sein.');
}

function areaChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new TypeError('Die Raumänderungen sind ungültig.');
  if (Object.keys(changes).some(key => !['name', 'picture'].includes(key))) throw new TypeError('Nur Raumname und Bild können hier geändert werden.');
  const result = {};
  if (Object.hasOwn(changes, 'name')) result.name = validateAreaName(changes.name);
  if (Object.hasOwn(changes, 'picture')) result.picture = validatedAreaPicture(changes.picture);
  return result;
}

function imageIdFromPicture(picture) {
  if (typeof picture !== 'string') return null;
  if (picture.startsWith('media-source://image_upload/')) return picture.slice('media-source://image_upload/'.length).split('/')[0];
  try { return new URL(picture, 'http://home-assistant.invalid').pathname.match(/^\/api\/image\/serve\/([^/]+)\//)?.[1] || null; }
  catch { return null; }
}

async function writeArea(hass, payload) {
  const uploads = pendingAreaImages.get(hass.connection);
  const imageId = imageIdFromPicture(payload.picture), upload = uploads?.get(imageId);
  if (upload?.deleting) throw new Error('Dieses Bild wird gerade verworfen. Bitte wähle es erneut aus.');
  // Register ownership before the WS call can settle, including synchronous stubs.
  const operation = Promise.resolve().then(() => hass.callWS(payload));
  upload?.assignments.add(operation);
  try {
    const result = await operation;
    if (upload && uploads.get(imageId) === upload) uploads.delete(imageId);
    return result;
  } finally { upload?.assignments.delete(operation); }
}

/** HA config/area_registry/create, with an optional atomic image assignment. */
export async function createArea(hass, name, options = {}) {
  requireAreaWrite(hass);
  const changes = areaChanges(options);
  if (Object.hasOwn(changes, 'name')) throw new TypeError('Den Raumnamen bitte als separates Argument übergeben.');
  return writeArea(hass, { type: 'config/area_registry/create', name: validateAreaName(name), ...changes });
}

/** Only explicitly supplied name/picture fields change; picture:null removes it. */
export async function updateArea(hass, areaId, changes) {
  requireAreaWrite(hass);
  const id = validatedAreaId(areaId), update = areaChanges(changes);
  if (!Object.keys(update).length) throw new TypeError('Es wurden keine Raumänderungen angegeben.');
  return writeArea(hass, { type: 'config/area_registry/update', area_id: id, ...update });
}

/** Backwards-compatible rename, preserving the image and every other HA field. */
export function renameArea(hass, areaId, name) {
  return updateArea(hass, areaId, { name });
}

/** Persist all actual areas in one native HA reorder command (HA 2026.10.2).
 * The registry list is authoritative; synthetic rooms never enter this command.
 * The server validates the complete ID set again atomically, so a concurrent
 * room addition/removal rejects instead of silently losing it from the order.
 */
export async function reorderAreas(hass, orderedIds) {
  requireAreaWrite(hass);
  if (!Array.isArray(orderedIds)) throw new TypeError('Die Raumreihenfolge muss eine Liste von Raum-IDs sein.');
  const ids = Array.from(orderedIds, validatedAreaId);
  if (new Set(ids).size !== ids.length) throw new TypeError('Jeder Raum muss genau einmal in der Reihenfolge vorkommen.');
  const connection = hass.connection;
  const areas = await hass.callWS({ type: 'config/area_registry/list' });
  requireAreaWrite(hass);
  if (hass.connection !== connection) throw new Error('Die Verbindung zu Home Assistant hat sich geändert. Bitte erneut versuchen.');
  if (!Array.isArray(areas)) throw new Error('Home Assistant hat ungültige Raumdaten geliefert.');
  const currentIds = areas.map(area => area?.area_id || area?.id);
  if (currentIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id === UNASSIGNED_ROOM_ID)
    || new Set(currentIds).size !== currentIds.length) throw new Error('Home Assistant hat ungültige Raumdaten geliefert.');
  const current = new Set(currentIds);
  if (ids.length !== current.size || ids.some(id => !current.has(id))) {
    throw new Error('Die Räume haben sich geändert. Bitte die aktuelle Liste erneut sortieren.');
  }
  return hass.callWS({ type: 'config/area_registry/reorder', area_ids: ids });
}

/** Pure selection validation; call before creating a preview or starting upload. */
export function validateAreaImageFile(file) {
  if (typeof File === 'undefined' || !(file instanceof File)) throw new TypeError('Bitte eine Bilddatei auswählen.');
  if (!AREA_IMAGE_TYPES.has(file.type)) throw new TypeError('Bitte ein JPEG-, PNG- oder GIF-Bild auswählen.');
  if (!file.size) throw new TypeError('Die Bilddatei ist leer.');
  if (file.size > AREA_IMAGE_MAX_BYTES) throw new RangeError('Das Bild darf höchstens 10 MiB groß sein.');
  return file;
}

function imageUploadConnection(hass) {
  const connection = hass.connection;
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) throw new Error('Die Home-Assistant-Verbindung fehlt.');
  return connection;
}

/** Auth stays with HA. Do not manually construct bearer headers or Content-Type.
 * API matches HA frontend src/data/image_upload.ts and the installed backend.
 * Returns a URL suitable for area.picture and an ID for safe unattached cleanup.
 */
export async function uploadAreaImage(hass, file) {
  requireAreaWrite(hass);
  validateAreaImageFile(file);
  const connection = imageUploadConnection(hass);
  if (typeof hass.fetchWithAuth !== 'function') throw new Error('Der authentifizierte Bildupload ist nicht verfügbar.');
  const body = new FormData();
  body.append('file', file);
  const response = await hass.fetchWithAuth('/api/image/upload', { method: 'POST', body });
  if (response.status !== 200) {
    let info;
    try { info = await response.json(); } catch { /* HA can return plain HTTP errors. */ }
    const error = new Error(response.status === 413 ? 'Das Bild darf höchstens 10 MiB groß sein.'
      : info?.message || 'Das Bild konnte nicht hochgeladen werden.');
    error.status = response.status;
    if (typeof info?.code === 'string') error.code = info.code;
    throw error;
  }
  const image = await response.json();
  if (!image || typeof image.id !== 'string' || !/^[a-f0-9]{32}$/.test(image.id)) throw new Error('Home Assistant hat eine ungültige Bildantwort geliefert.');
  let uploads = pendingAreaImages.get(connection);
  if (!uploads) { uploads = new Map(); pendingAreaImages.set(connection, uploads); }
  uploads.set(image.id, { assignments: new Set(), cleanup: null, deleting: false });
  return { id: image.id, url: `/api/image/serve/${image.id}/512x512` };
}

/** Delete only this connection's own newly uploaded, unattached image.
 * A failed WS response can follow a successful commit: always check actual areas.
 * true = deleted, false = not owned/already assigned/referenced. Read failures
 * reject without deleting. Prior room pictures are never registered as owned.
 */
export async function deleteUploadedAreaImage(hass, imageId) {
  requireAreaWrite(hass);
  const connection = imageUploadConnection(hass);
  if (typeof imageId !== 'string' || !/^[a-f0-9]{32}$/.test(imageId)) throw new TypeError('Die Bild-ID ist ungültig.');
  const uploads = pendingAreaImages.get(connection), upload = uploads?.get(imageId);
  if (!upload) return false;
  if (upload.cleanup) return upload.cleanup;
  const cleanup = async () => {
    while (uploads.get(imageId) === upload) {
      if (upload.assignments.size) await Promise.allSettled([...upload.assignments]);
      if (uploads.get(imageId) !== upload) return false;
      const areas = await hass.callWS({ type: 'config/area_registry/list' });
      if (!Array.isArray(areas)) throw new Error('Home Assistant hat ungültige Raumdaten geliefert.');
      if (areas.some(area => imageIdFromPicture(area?.picture) === imageId)) { uploads.delete(imageId); return false; }
      // Recheck after the asynchronous list to avoid deleting during assignment.
      if (upload.assignments.size) continue;
      if (uploads.get(imageId) !== upload) return false;
      requireAreaWrite(hass);
      if (hass.connection !== connection) return false;
      upload.deleting = true;
      try {
        await hass.callWS({ type: 'image/delete', image_id: imageId });
        uploads.delete(imageId);
        return true;
      } finally { upload.deleting = false; }
    }
    return false;
  };
  upload.cleanup = cleanup();
  try { return await upload.cleanup; }
  finally { upload.cleanup = null; }
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
export function deriveRooms(registries, states = {}, settings = {}) {
  const entities = deriveEntities(registries, states);
  const areas = entries(registries?.areas);
  const areaIds = new Set(areas.map((area) => area.area_id || area.id));
  const eligibleKeys = new Set(assignmentItems(registries, states).map(item => item.key));
  const rooms = areas.map((area) => {
    const areaId = area.area_id || area.id;
    const links = new Set((settings?.room_device_links?.[areaId] || []).filter(key => eligibleKeys.has(key)));
    const linked = entity => links.has(`entity:${entity.id || entity.entity_id}`) || links.has(`device:${entity.deviceId || entity.device_id}`);
    return makeRoom(area, entities.filter(entity => entity.areaId === areaId || linked(entity)), entities);
  });
  const unassigned = entities.filter((entity) => !areaIds.has(entity.areaId) && !entity.category && (
    ['light', 'cover', 'climate', 'fan', 'switch', 'vacuum', 'group'].includes(entity.domain)
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

export function deriveHome(registries, states = {}, settings = {}) {
  const entities = deriveEntities(registries, states);
  const hiddenAreaIds = Array.isArray(settings) ? settings : settings?.hidden_area_ids;
  const hidden = new Set(Array.isArray(hiddenAreaIds) ? hiddenAreaIds : []);
  return {
    // Visibility affects room navigation only. Keep topology for shared groups
    // and leave independent sections such as the robot list fully available.
    rooms: deriveRooms(registries, states, settings).filter(room => room.unassigned || !hidden.has(room.id)),
    entities, entityScopes: deriveEntityScopes(registries, states),
    vacuums: entities.filter((entity) => entity.domain === 'vacuum'),
    weather: entities.filter((entity) => entity.domain === 'weather'),
    people: entities.filter((entity) => entity.domain === 'person'),
    // Keep distinct meters separate; summing them can double-count consumption.
    energy: entities.filter((entity) => entity.domain === 'sensor' && !entity.category && ['energy', 'power'].includes(entity.deviceClass)),
  };
}

/**
 * Only a group actually displayed in this room can replace its local members.
 * Its real HA boundaries remain intact, including members in other rooms.
 * Unlike the home summary, an unavailable group still represents its members.
 * allEntities supplies visible entities for topology. Optional entityScopes contains
 * topology only, including hidden members; it never supplies rows/suppressors.
 */
export function deriveRoomDevices(room, allEntities = room.entities, entityScopes, order = []) {
  const relevant = (entity) => entity?.id && !entity.category && !entity.hidden_by && !entity.disabled_by
    && !DETAIL_EXCLUDED_DOMAINS.has(entity.domain);
  const locals = (room.entities || []).filter(relevant);
  const all = new Map([...entries(allEntities), ...locals].filter(relevant).map((entity) => [entity.id, entity]));
  const memberIds = (entity) => Array.isArray(entity.attributes?.entity_id)
    ? [...new Set(entity.attributes.entity_id.filter((id) => typeof id === 'string' && id))] : [];
  const isGroup = (entity) => entity.domain === 'group' || memberIds(entity).length > 0;
  const scopes = new Map([...all.values()].map((entity) => [entity.id, { id: entity.id, areaId: entity.areaId, memberIds: memberIds(entity) }]));
  for (const scope of entries(entityScopes)) scopes.set(scope.id, scope);
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
  // Global topology is only for traversing a chosen local group's members.
  // A parent assigned elsewhere or unassigned must never hide local controls.
  const groups = locals.filter(isGroup).map((entity) => ({ entity, descendants: descendants(entity) }))
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
  const ranks = assignmentRanks(order);
  const rank = entity => ranks.get(`entity:${entity.id}`) ?? ranks.get(`device:${entity.deviceId}`) ?? Infinity;
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
