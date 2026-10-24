import { icon } from './icons.js';
import { pictureUrl, entityControlTarget } from './ha-model.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(Number(value));
const sections = [
  ['light', 'Licht', ['light']], ['cover', 'Beschattung', ['cover']],
  ['switch', 'Schalter', ['switch', 'input_boolean']], ['climate', 'Raumklima', ['climate', 'fan', 'humidifier']],
  ['media', 'Unterhaltung', ['media_player', 'remote']], ['vacuum', 'Reinigung', ['vacuum', 'lawn_mower']],
  ['sensor', 'Sensoren', ['sensor', 'binary_sensor']], ['other', 'Weitere Geräte', []],
];

function stateLabel(entity, hass) {
  if (!entity.available) return entity.state === 'unknown' ? '—' : 'Nicht verfügbar';
  if (entity.domain === 'light') return entity.state === 'off' ? 'Aus' : entity.brightness === null ? 'An' : `${entity.brightness} %`;
  if (entity.domain === 'cover') {
    if (entity.state === 'opening') return 'Öffnet';
    if (entity.state === 'closing') return 'Schließt';
    return entity.position === 0 || entity.state === 'closed' ? 'Geschlossen'
      : entity.position === 100 ? 'Offen' : entity.position !== null ? `${entity.position} % geöffnet` : 'Offen';
  }
  if (entity.domain === 'sensor' && numeric(entity.state)) return `${number(entity.state)}${entity.attributes.unit_of_measurement ? ` ${entity.attributes.unit_of_measurement}` : ''}`;
  if (entity.domain === 'binary_sensor') {
    const active = entity.state === 'on';
    if (['door', 'window', 'opening', 'garage_door'].includes(entity.deviceClass)) return active ? 'Offen' : 'Geschlossen';
    if (['motion', 'occupancy', 'presence'].includes(entity.deviceClass)) return active ? 'Erkannt' : 'Keine Aktivität';
    if (entity.deviceClass === 'moisture') return active ? 'Feuchtigkeit erkannt' : 'Trocken';
    return active ? 'Aktiv' : 'Inaktiv';
  }
  if (entity.domain === 'climate' && numeric(entity.attributes.current_temperature)) {
    return `${number(entity.attributes.current_temperature)} ${hass?.config?.unit_system?.temperature || '°'}`;
  }
  return ({ on: 'An', off: 'Aus', idle: 'Bereit', playing: 'Wiedergabe', paused: 'Pausiert',
    cleaning: 'Reinigt', docked: 'In der Station', returning: 'Kehrt zurück',
    locked: 'Verriegelt', unlocked: 'Entriegelt', heat: 'Heizen', cool: 'Kühlen', auto: 'Automatisch',
    open: 'Offen', closed: 'Geschlossen', home: 'Zuhause', not_home: 'Abwesend' })[entity.state] || entity.state;
}

function deviceIcon(entity) {
  if (entity.deviceClass === 'temperature' || entity.domain === 'climate') return 'temperature';
  if (entity.deviceClass === 'humidity' || entity.deviceClass === 'moisture') return 'humidity';
  if (['energy', 'power', 'battery'].includes(entity.deviceClass)) return 'energy';
  if (entity.domain === 'vacuum') return 'robot';
  if (['switch', 'input_boolean', 'fan'].includes(entity.domain)) return 'power';
  return 'devices';
}

function displayName(name, roomName) {
  const full = String(name), prefix = String(roomName);
  let short = full;
  // The room is already the page heading; retain HA's full name in accessible labels.
  while (prefix && short.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    && /^[\s·:|–—-]/.test(short.slice(prefix.length))) {
    const remaining = short.slice(prefix.length).replace(/^[\s·:|–—-]+/, '');
    if (!remaining) break;
    short = remaining;
  }
  return short;
}

/** Render real HA entities; action callbacks are scoped to the actual entity/group. */
export function renderRoomDetail(room, devices, hass, { reading, control, current = true, status = '' }) {
  if (!room) return `<header class="detail-header"><button class="room-back" data-room-back>${icon('back')}<span>Zuhause</span></button><h1 tabindex="-1">Raum nicht mehr vorhanden</h1></header><div class="empty-state">Dieser Raum ist in Home Assistant nicht mehr vorhanden.</div>`;
  const picture = pictureUrl(hass, room.picture);
  const buckets = new Map(sections.map(([id]) => [id, []]));
  for (const entity of devices) buckets.get(sections.find(([, , domains]) => domains.includes(entity.domain))?.[0] || 'other').push(entity);
  const row = entity => {
    const id = escape(entity.id);
    const state = stateLabel(entity, hass);
    const group = entity.isGroup ? entity.isSharedGroup ? 'Gruppe · mehrere Räume' : `Gruppe · ${entity.memberCount} Geräte` : '';
    const adjustable = ['light', 'cover'].includes(entity.domain);
    const toggle = ['switch', 'fan', 'input_boolean'].includes(entity.domain);
    const sensor = ['sensor', 'binary_sensor'].includes(entity.domain);
    const label = group ? `${state} · ${group}` : state;
    let action;
    if (adjustable) action = control(entityControlTarget(entity), entity.domain, entity.id);
    else if (toggle) action = `<button class="round-control switch-control ${entity.state === 'on' ? 'is-on' : ''}" data-toggle-entity="${id}" aria-label="${escape(entity.name)} ${entity.state === 'on' ? 'ausschalten' : 'einschalten'}" aria-pressed="${entity.state === 'on'}" ${!entity.available || hass?.connected === false ? 'disabled' : ''}>${icon('power')}</button>`;
    else if (sensor) action = `<span class="device-reading">${escape(state)}</span>`;
    else action = `<span class="device-chevron" aria-hidden="true">${icon('forward')}</span>`;
    return `<article class="device-row ${sensor ? 'sensor-row' : ''}" data-entity-row="${id}">
      <button type="button" class="device-info" data-more-info="${id}" aria-label="${escape(entity.name)}: Details öffnen">
        ${!adjustable && !toggle ? `<span class="device-symbol" aria-hidden="true">${icon(deviceIcon(entity))}</span>` : ''}
        <span class="device-copy"><span class="device-name" title="${escape(entity.name)}">${escape(displayName(entity.name, room.name))}</span>${sensor && !group ? '' : `<span class="device-state">${escape(sensor ? group : label)}</span>`}</span>
      </button>${action}</article>`;
  };
  return `<div class="room-detail" data-room-detail="${escape(room.id)}" ${current ? 'data-current-room' : ''}>
    <button type="button" class="room-back" data-room-back aria-label="Zurück zu Zuhause">${icon('close')}</button>
    <header class="detail-header ${picture ? 'has-photo' : ''}">
      ${picture ? `<div class="detail-photo"><img data-room-picture src="${escape(picture)}" alt="" draggable="false"><div class="detail-photo-tint" aria-hidden="true"></div></div>` : ''}
      <div class="detail-intro"><div class="detail-heading"><h1 tabindex="-1">${escape(room.name)}</h1><div class="detail-climate">${reading(room.temperature, 'temperature')}${reading(room.humidity, 'humidity')}</div></div>
      </div>
    </header>
    ${status}
    ${devices.length ? sections.filter(([id]) => buckets.get(id).length).map(([id, label]) => `<section class="device-section" aria-labelledby="devices-${escape(room.id)}-${id}"><h2 id="devices-${escape(room.id)}-${id}">${label}</h2><div class="device-list">${buckets.get(id).map(row).join('')}</div></section>`).join('') : '<div class="empty-state"><p>In diesem Raum sind noch keine Geräte eingerichtet.</p></div>'}
  </div>`;
}
