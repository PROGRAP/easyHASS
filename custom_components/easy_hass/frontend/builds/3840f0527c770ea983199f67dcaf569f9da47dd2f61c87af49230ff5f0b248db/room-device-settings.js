import { icon } from './icons.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderRoomDeviceChoice({ item, areaName, disabled, saving, error, help }) {
  if (!item) return '';
  return `<div class="settings-device-choice" aria-busy="${!!saving}">
    <p class="settings-device-question"><strong>${escape(item.name)}</strong> ist bereits dem Raum <strong>${escape(item.areaName || 'Anderer Raum')}</strong> zugeordnet.</p>
    <div class="settings-device-options">
      <button type="button" class="settings-row" data-settings-device-mode="additional" ${disabled ? 'disabled' : ''}>
        <span class="settings-row-label">Zusätzlich anzeigen<span class="settings-room-status">Auch in ${escape(areaName)} anzeigen.</span></span>${icon('plus')}
      </button>
      <button type="button" class="settings-row" data-settings-device-mode="move" ${disabled ? 'disabled' : ''}>
        <span class="settings-row-label">Verschieben<span class="settings-room-status">Von ${escape(item.areaName || 'diesem Raum')} nach ${escape(areaName)}.</span></span>${icon('forward')}
      </button>
    </div>
    ${saving ? '<p class="settings-help" role="status">Wird gespeichert …</p>' : ''}
    ${error ? `<p class="settings-error" role="alert">${escape(error)}</p>` : ''}
    ${help ? `<p class="settings-help" role="status">${escape(help)}</p>` : ''}
    <button type="button" class="settings-choice-cancel" data-settings-choice-cancel ${saving ? 'disabled' : ''}>Abbrechen</button>
  </div>`;
}

/** Assignments and extra displays are saved independently of the room-name draft. */
export function renderRoomDeviceSettings({ areaName, items, adding, query = '', disabled, saving,
  error, help, status, missing, loading, orderingDisabled = disabled, handleDisabled = orderingDisabled }) {
  const intro = `<p class="settings-device-room">${escape(areaName)}</p>`;
  if (missing) return `${intro}<p class="settings-error" role="alert">Dieser Raum ist nicht mehr vorhanden.</p>`;
  if (loading) return `${intro}<p class="settings-help" role="status">Geräte werden geladen …</p>`;
  const messages = `${error ? `<p class="settings-error" role="alert">${escape(error)}</p>` : ''}${help ? `<p class="settings-help" role="status">${escape(help)}</p>` : ''}`;
  if (adding) {
    const search = `<div class="settings-field settings-device-search"><input class="settings-input" id="settings-device-search" type="search" value="${escape(query)}" placeholder=" " autocomplete="off"><label class="settings-floating-label" for="settings-device-search">Gerät suchen</label></div>`;
    const term = query.trim().toLocaleLowerCase('de');
    const results = items.filter(item => `${item.name} ${item.areaName || ''}`.toLocaleLowerCase('de').includes(term));
    return `${intro}${search}<div class="settings-list" aria-busy="${!!saving}">${results.length ? results.map(item => `<button type="button" class="settings-row" id="settings-assign-${escape(item.key)}" data-settings-device-assign="${escape(item.key)}" ${disabled ? 'disabled' : ''}><span class="settings-row-label">${escape(item.name)}<span class="settings-room-status">${escape(item.areaName ? `In ${item.areaName}` : 'Keinem Raum zugeordnet')}${item.isGroup ? ' · Gruppe' : ''}${item.explicitAreaCount ? ' · Einzelne Raumzuordnungen bleiben erhalten' : ''}</span></span>${icon('plus')}</button>`).join('') : `<p class="settings-help settings-device-empty">${term ? 'Keine passenden Geräte gefunden.' : 'Alle verfügbaren Geräte sind bereits zugeordnet.'}</p>`}</div>${messages}`;
  }
  const list = items.length ? `<div class="settings-list${saving ? ' is-order-saving' : ''}" role="list" aria-label="Zugeordnete Geräte" aria-busy="${!!saving}">${items.map(item => `<div class="settings-area-row settings-device-row" id="settings-device-${escape(item.key)}" data-settings-device-row="${escape(item.key)}"${item.isAdditional ? ' data-additional="true"' : ''} role="listitem"><button type="button" class="settings-drag" data-settings-device-drag="${escape(item.key)}" aria-label="${escape(item.name)} verschieben" aria-describedby="settings-device-order-hint" aria-pressed="false" aria-disabled="${orderingDisabled || items.length < 2}" ${handleDisabled || items.length < 2 ? 'disabled' : ''}>${icon('reorder')}</button><span class="settings-row-label"><span class="settings-device-name">${escape(item.name)}</span>${item.isAdditional ? `<span class="settings-room-status">${escape(item.areaName ? `Zusätzlich aus ${item.areaName}` : 'Zusätzlich angezeigt')}</span>` : item.inherited ? `<span class="settings-room-status">${item.inheritedReason === 'entity' ? 'Einzelne Funktionen in diesem Raum' : 'Über Gruppenmitglieder zugeordnet'}</span>` : item.overrideCount ? `<span class="settings-room-status">${item.overrideCount} ${item.overrideCount === 1 ? 'abweichende Raumzuordnung' : 'abweichende Raumzuordnungen'}</span>` : ''}</span><button type="button" class="settings-device-remove" data-settings-device-remove="${escape(item.key)}" aria-label="${escape(item.name)}${item.isAdditional ? ': zusätzliche Anzeige entfernen' : ' aus diesem Raum entfernen'}" ${disabled || item.canRemove === false ? 'disabled' : ''}>${icon('close')}</button></div>`).join('')}</div>` : '<p class="settings-help settings-device-empty">Diesem Raum sind noch keine Geräte zugeordnet.</p>';
  return `${intro}${list}<span class="sr-only" id="settings-device-order-hint">Am Griff ziehen zum Sortieren. Mit der Tastatur Leertaste oder Enter drücken, mit den Pfeiltasten verschieben und erneut bestätigen. Escape bricht ab.</span><span class="sr-only" id="settings-device-order-status" role="status" aria-live="polite" aria-atomic="true">${escape(status)}</span>${messages}<button type="button" class="settings-new" data-settings-device-add ${disabled ? 'disabled' : ''}>${icon('plus')}<span>Gerät hinzufügen</span></button><p class="settings-help settings-device-note">Änderungen werden direkt gespeichert.</p>`;
}
