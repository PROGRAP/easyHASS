import { icon, coverIcon, lightIcon } from './icons.js';
import { pictureUrl, entityControlTarget } from './ha-model.js';
import { controlValueLabel } from './control-label.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const number = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(Number(value));
const sections = [
  ['light', 'Licht', ['light']], ['cover', 'Beschattung', ['cover']],
  ['switch', 'Schalter', ['switch', 'input_boolean']], ['climate', 'Raumklima', ['climate', 'fan', 'humidifier']],
  ['media', 'Unterhaltung', ['media_player', 'remote']], ['vacuum', 'Reinigung', ['vacuum', 'lawn_mower']],
  ['other', 'Weitere Geräte', []],
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

function inlineControl(entity, roomName, hass, group, pending) {
  const kind = entity.domain, id = escape(entity.id), name = escape(entity.name);
  const state = entityControlTarget(entity)[kind];
  const adjustable = kind === 'light' ? entity.canDim : entity.canSetPosition;
  const level = kind === 'light' ? entity.brightness : entity.position;
  const known = entity.available && numeric(level);
  const value = known ? Math.max(0, Math.min(100, Number(level))) : null;
  const unavailable = !entity.available || hass?.connected === false;
  const disabled = unavailable || pending;
  const status = !entity.available ? '—' : kind === 'light'
    ? entity.state === 'on' ? 'An' : entity.state === 'off' ? 'Aus' : '—'
    : ({ open: 'Auf', closed: 'Zu', opening: 'Öffnet', closing: 'Schließt' })[entity.state] || '—';
  const output = adjustable ? controlValueLabel(kind, value) : status;
  const fill = adjustable ? value ?? 0 : entity.available && (kind === 'light' ? state.isOn : state.isOpen) ? 100 : 0;
  const action = kind === 'light' ? state.isOn ? 'ausschalten' : 'einschalten'
    : state.moving ? 'stoppen' : state.isOpen ? 'schließen' : 'öffnen';
  const valueText = !entity.available ? entity.state === 'unknown' ? 'Wert unbekannt' : 'Nicht verfügbar'
    : value === null ? `${kind === 'light' ? 'Helligkeit' : 'Öffnung'} unbekannt`
      : controlValueLabel(kind, value);
  return `<article class="device-row inline-control ${kind}${unavailable ? ' is-unavailable' : ''}${pending ? ' is-pending' : ''}${adjustable ? '' : ' is-binary'}" data-entity-row="${id}" data-inline-control="${id}"${pending ? ' aria-busy="true"' : ''}>
    <div class="inline-fill" style="width: ${fill}%" aria-hidden="true"></div>
    <button type="button" class="inline-icon" data-inline-toggle="${id}" data-inline-kind="${kind}" aria-label="${name}: ${kind === 'light' ? 'Licht' : 'Rollladen'} ${action}" ${kind === 'light' ? `aria-pressed="${state.isOn}"` : ''} ${disabled || !state.canToggle ? 'disabled' : ''}>${kind === 'light' ? lightIcon(adjustable ? value : entity.available && state.isOn ? 100 : 0) : coverIcon(value ?? (entity.state === 'closed' ? 0 : null))}</button>
    <span class="inline-title"><span class="device-name" title="${name}">${escape(displayName(entity.name, roomName))}</span>${group ? `<span class="device-state">${escape(group)}</span>` : ''}</span>
    <output class="inline-value" aria-live="off">${escape(output)}</output>
    ${adjustable ? `<input type="range" min="0" max="100" step="1" value="${value ?? 50}" data-inline-range="${id}" data-inline-kind="${kind}" aria-label="${name}: ${kind === 'light' ? 'Helligkeit' : 'Öffnung'} in Prozent" aria-valuetext="${escape(valueText)}" ${disabled ? 'disabled' : ''}>` : ''}
    ${kind === 'light' ? `<button type="button" class="inline-details" data-inline-details="${id}" data-inline-kind="light" aria-label="${name}: Details öffnen"${adjustable ? ' aria-description="Seitlich ziehen, um die Helligkeit zu ändern."' : ''} ${disabled ? 'disabled' : ''}></button>` : ''}
  </article>`;
}

/** Render real HA entities; action callbacks are scoped to the actual entity/group. */
export function renderRoomDetail(room, devices, hass, { reading, current = true, status = '', pending = () => false, customOrder = false }) {
  if (!room) return `<header class="detail-header"><button class="room-back" data-room-back>${icon('back')}<span>Zuhause</span></button><h1 tabindex="-1">Raum nicht mehr vorhanden</h1></header><div class="empty-state">Dieser Raum ist in Home Assistant nicht mehr vorhanden.</div>`;
  const picture = pictureUrl(hass, room.picture);
  const buckets = new Map(sections.map(([id]) => [id, []]));
  const sectionOrder = [];
  for (const entity of devices) {
    const sectionId = sections.find(([, , domains]) => domains.includes(entity.domain))?.[0] || 'other';
    if (!buckets.get(sectionId).length) sectionOrder.push(sectionId);
    buckets.get(sectionId).push(entity);
  }
  // Keep device types together after sorting. Each section follows its first
  // ordered device; the order within a section is already supplied by the model.
  const visibleSections = customOrder ? sectionOrder.map(id => sections.find(section => section[0] === id))
    : sections.filter(([id]) => buckets.get(id).length);
  const row = entity => {
    const id = escape(entity.id);
    const state = stateLabel(entity, hass);
    const group = entity.isGroup ? entity.isSharedGroup ? 'Gruppe · mehrere Räume' : `Gruppe · ${entity.memberCount} Geräte` : '';
    const adjustable = ['light', 'cover'].includes(entity.domain);
    if (adjustable) return inlineControl(entity, room.name, hass, group, pending(entity.id, entity.domain));
    const toggle = ['switch', 'fan', 'input_boolean'].includes(entity.domain);
    const label = group ? `${state} · ${group}` : state;
    let action;
    if (toggle) action = `<button class="round-control switch-control ${entity.state === 'on' ? 'is-on' : ''}" data-toggle-entity="${id}" aria-label="${escape(entity.name)} ${entity.state === 'on' ? 'ausschalten' : 'einschalten'}" aria-pressed="${entity.state === 'on'}" ${!entity.available || hass?.connected === false ? 'disabled' : ''}>${icon('power')}</button>`;
    else action = `<span class="device-chevron" aria-hidden="true">${icon('forward')}</span>`;
    return `<article class="device-row" data-entity-row="${id}">
      <button type="button" class="device-info" data-more-info="${id}" aria-label="${escape(entity.name)}: Details öffnen">
        ${!adjustable && !toggle ? `<span class="device-symbol" aria-hidden="true">${icon(deviceIcon(entity))}</span>` : ''}
        <span class="device-copy"><span class="device-name" title="${escape(entity.name)}">${escape(displayName(entity.name, room.name))}</span><span class="device-state">${escape(label)}</span></span>
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
    ${devices.length ? visibleSections.map(([id, label]) => `<section class="device-section" aria-labelledby="devices-${escape(room.id)}-${id}"><h2 id="devices-${escape(room.id)}-${id}">${label}</h2><div class="device-list">${buckets.get(id).map(row).join('')}</div></section>`).join('') : '<div class="empty-state"><p>In diesem Raum sind noch keine steuerbaren Geräte eingerichtet.</p></div>'}
  </div>`;
}
