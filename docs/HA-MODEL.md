# Home-Assistant-Datenmodell

`frontend/src/ha-model.js` ist unabhängig vom DOM. Es enthält keine konfigurierten Raumnamen, Geräte-IDs oder Beispielbilder. Beispielgeräte gehören ausschließlich in eine HA-Testinstanz.

## Laden und Aktualisieren

1. `await subscribeRegistries(hass, onReload, onError)` installiert Listener für `area_registry_updated`, `device_registry_updated`, `entity_registry_updated` und Wiederverbindung. Der Rückgabewert ist eine Cleanup-Funktion. Falls die Komponente während dieses `await` entfernt wird, muss sie die zurückgegebene Funktion sofort ausführen.
2. `await loadRegistries(hass)` liefert `{areas, devices, entities}` über die drei `config/*_registry/list` WebSocket-Befehle. Fehler werden weitergegeben, nicht als leere Installation interpretiert.
3. Bei jedem neuen `hass.states` und nach jedem Registry-Reload `deriveHome(registries, hass.states)` oder `deriveRooms(...)` erneut aufrufen. Es gibt keinen zweiten Zustands-Cache und keine separate Authentifizierung.
4. Beim Entfernen der Komponente Cleanup aufrufen. Laufende Reloads liefern danach keine UI-Updates mehr.

`deriveHome` liefert `{rooms, entities, vacuums, weather, people, energy}`. Die letzten vier Listen enthalten echte normalisierte HA-Entitäten. Energiesensoren werden nicht addiert: Zähler können sich überschneiden.

## Räume

Jeder Raum enthält `{id, name, picture, icon, floorId, unassigned, entities, lights, covers, light, cover, temperature, humidity}`. Reihenfolge und Bilder kommen aus HA; leere Bereiche bleiben erhalten. `pictureUrl(hass, room.picture)` löst relative HA-Bilder über `hass.hassUrl` auf. Das UI setzt die URL als DOM-Attribut/Property.

Die Zuordnung erfolgt über die direkte Entity-Area, danach die Device-Area. Versteckte und deaktivierte Entitäten sowie Entitäten deaktivierter Geräte werden entfernt. Relevante Geräte ohne gültige Area erscheinen in „Ohne Raum“. Dieser Text bezeichnet einen Auffangbereich, keinen vordefinierten Raum.

- `room.light`: `{count, availableCount, unavailableCount, onCount, isOn, allOn, mixed, canToggle, canDim, brightness, brightnessMixed, dimmableCount}`. Helligkeit ist `null` oder `0…100`; der Mittelwert berücksichtigt nur verfügbare dimmbare Leuchten. Ausgeschaltete Leuchten zählen mit 0.
- `room.cover`: `{count, availableCount, unavailableCount, isOpen, allClosed, moving, mixed, position, canToggle, canSetPosition, canPosition, positionCount}`. Position ist `null` oder `0…100`; **0 bedeutet geschlossen, 100 offen**, wie in HA. `canPosition` ist ein Alias für `canSetPosition`.
- `temperature` / `humidity`: `null` oder `{entityId, name, value, unit, available, state, sourceCount}`. Explizite `temperature_entity_id` / `humidity_entity_id` am HA-Bereich haben Vorrang. Sonst wird der erste verfügbare passende Sensor verwendet. Unbekannte/ausgefallene Werte bleiben `null`; das UI zeigt „—“ mit der tatsächlichen Einheit. Es werden keine Messwerte erfunden, gemittelt oder Einheiten still umgerechnet.

`lights` und `covers` enthalten normalisierte Entitäten: `{id, entity_id, domain, name, icon, areaId, deviceId, deviceClass, state, attributes, available, category, canDim, brightness, canOpen, canClose, canSetPosition, canStop, position, actions}`. Verfügbare Gruppen ersetzen ihre im selben Raum sichtbaren Mitglieder, damit ein Raumkommando nicht Gruppe und deren Mitglieder doppelt anspricht. Ausgefallene Gruppen verdecken keine erreichbaren Mitglieder. Konfigurations- und Diagnoseentitäten erzeugen keine alltäglichen Raumregler.

## Geräteaktionen

Alle Funktionen liefern ein Promise und lassen HA-Fehler zum UI durch. Vor dem Aufruf prüfen sie die aktuellen `hass.states` erneut. Jeder Service-Aufruf hat konkrete Entity-IDs; es gibt keine pauschalen Aktionen ohne Targets.

- `toggleRoomLights(hass, room)`: sobald mindestens eine verfügbare Leuchte an ist, alle verfügbaren Raumleuchten ausschalten; andernfalls einschalten.
- `setRoomBrightness(hass, room, percent)`: nur verfügbare Leuchten mit dimmbaren `supported_color_modes`; reine Ein/Aus-Leuchten bleiben unberührt. 0 schaltet diese dimmbaren Leuchten aus.
- `toggleRoomCovers(hass, room)`: offene Raum-Rollläden schließen, sonst öffnen. Es werden nur unterstützte Befehle geschickt. Geräte, die ausschließlich Position unterstützen, erhalten Position 0 oder 100.
- `setRoomCoverPosition(hass, room, percent)`: nur verfügbare Geräte mit `SET_POSITION`.
- `callVacuumAction(hass, entity, action)`: `start`, `pause`, `stop`, `return_to_base`, `locate` oder `clean_spot`, soweit das Gerät den passenden Feature-Bit meldet. Zulässige Aktionen stehen in `entity.actions`.

## Offizielle Grundlagen

Geprüft gegen HA Core **2026.10.2**: [Registry-WebSocket-Befehle](https://github.com/home-assistant/core/tree/2026.10.2/homeassistant/components/config), [Area-Felder und Ereignisse](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/helpers/area_registry.py), [Licht-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/light/const.py), [Cover-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/cover/const.py), [Vacuum-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/vacuum/const.py). Das [hass-Objekt](https://contributors.home-assistant.io/frontend/reference/hass-object/) stellt Zustände, Verbindung und Service-Methoden bereit.

Tests: `node --test tests/ha-model.test.mjs`. Diese Tests prüfen Datenzuordnung, Fähigkeiten, Targets und Lebenszyklus. Sie ersetzen die Abnahme im tatsächlichen Home Assistant nicht.
