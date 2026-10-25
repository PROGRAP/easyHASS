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

Die Geräteliste der Raumansicht enthält keine `sensor`- oder `binary_sensor`-Einträge.
Temperatur und Luftfeuchtigkeit werden weiterhin aus den Sensoren ermittelt und im Raumheader angezeigt.

## Raumverwaltung

Die Raumverwaltung unter **Mehr → Einstellungen → Räume** verwendet
`listRegisteredAreas(registries)`: echte HA-Bereiche einschließlich leerer Räume,
ohne den synthetischen Auffangbereich „Ohne Raum“. `createArea(hass, name, options)`
und `updateArea(hass, areaId, changes)` verwenden die HA-Registry-WebSocket-Befehle.
Schreiben erfordert eine aktive Verbindung und ein Administratorkonto. Namen
werden getrimmt und auf 1–100 Zeichen begrenzt; beim Umbenennen bleibt die Area-ID
erhalten. Das Bildfeld wird nur bei einer bewussten Bildänderung mitgeschrieben;
Sensoren und Gerätezuordnungen bleiben unverändert.

Die Bildauswahl erzeugt zunächst nur eine lokale Vorschau. Erst Speichern lädt
JPG, PNG oder GIF bis 10 MiB über die authentifizierte HA-Bildverwaltung hoch und
ordnet die zurückgegebene Bildadresse dem Raum zu. Entfernen setzt `picture` auf
`null`. Bestehende Bilder werden nicht aus der Bildverwaltung gelöscht, da sie
auch von anderen Räumen oder Ansichten verwendet werden können. Nicht zugeordnete
eigene Uploads werden beim Verwerfen nach einer erneuten Referenzprüfung bereinigt.

`reorderAreas(hass, orderedIds)` nutzt den nativen, atomaren HA-Befehl
`config/area_registry/reorder`. Vor dem Schreiben werden die IDs gegen die
aktuelle Registry geprüft: Jede echte Area muss genau einmal vorkommen.
Die gespeicherte Registry-Reihenfolge gilt für die Einstellungen und die
Startseite; „Ohne Raum“ bleibt als synthetischer Auffangbereich zuletzt.
Das Ereignis `area_registry_updated` aktualisiert auch andere offene Ansichten.

**In EasyHASS ausblenden** ist eine separate Anzeigeeinstellung pro Raum.
`entry.options.hidden_area_ids` speichert sie zentral auf dem HA-Server; die
nativen Areas, Geräte, Bilder und ihre Reihenfolge bleiben erhalten. Ausgeblendete
Räume fehlen in der Übersicht und beim Wechseln der Raumdetails. In den
Einstellungen bleiben sie mit „Ausgeblendet“ erreichbar; die Roboterliste und
die vollständige Gruppenzuordnung bleiben unverändert.

`easy_hass/settings/get` und `easy_hass/settings/subscribe` liefern authentifizierten
Clients `{hidden_area_ids, room_device_order, room_device_links}`. `easy_hass/room_visibility/set` ändert als Administrator
genau eine echte Area über `{area_id, hidden}` und verteilt den neuen Stand an
alle Clients. Die Änderung wird erst mit **Speichern** übernommen. Vor dem ersten
Einstellungs-Snapshot zeigt das Panel keine Raumkarten, damit ausgeblendete Räume
nicht kurz aufblitzen. Direkte Links auf ausgeblendete Räume führen zur Übersicht.

Unter **Räume → Raum → Geräte** lassen sich registrierte Geräte hinzufügen,
aus der Raumzuordnung entfernen und am linken Griff sortieren. Geräte ohne native
Raumzuordnung werden direkt zugewiesen. Bereits zugeordnete Geräte öffnen eine
Auswahl zwischen **Verschieben** und **Zusätzlich anzeigen**. Verschieben ändert
die native Geräte-Registry; eigenständige steuerbare Entitäten und Gruppen ohne
Gerät verwenden die Entity-Registry. Explizite Raumzuordnungen einzelner Entitäten
bleiben beim Verschieben ihres Geräts erhalten. Physische Sensorgeräte können
zugeordnet werden, ihre einzelnen Sensorentitäten erzeugen weiterhin keine Zeilen
in der Raumansicht.

`easy_hass/room_device_assignment/set` prüft als Administrator die erwartete
bisherige Zuordnung (`expected_area_id`, auch `null`) und setzt atomar die neue
`area_id` für `key`. Ein zwischenzeitliches Verschieben durch einen anderen Client
wird als Konflikt gemeldet. Redundante zusätzliche Verweise im bisherigen und im
neuen nativen Raum werden entfernt; Verweise in weiteren Räumen bleiben bestehen.

**Zusätzlich anzeigen** speichert ausschließlich einen EasyHASS-Verweis in
`entry.options.room_device_links` (Area-ID → Liste von Geräteschlüsseln). Der Befehl
`easy_hass/room_device_link/set` ändert als Administrator mit `{area_id, key, linked}`
genau einen Verweis. Entfernen einer zusätzlichen Anzeige löscht nur diesen Verweis.
Die native Zuordnung und andere Räume bleiben erhalten. Referenzen nutzen dieselben
Entity-IDs und Zustände wie die native Anzeige; sie lassen sich pro Raum sortieren.
Explizit hinzugefügte Gruppen ersetzen weiterhin ihre Mitglieder. Ein zusätzlich
angezeigtes Einzelgerät zieht jedoch keine fremde Gruppe samt weiteren Geräten
in den Raum. Die globale Zahl eingeschalteter Lampen zählt identische Entities nur einmal.

`easy_hass/room_device_order/set` speichert als Administrator `{area_id, keys}`
in `entry.options.room_device_order`. Schlüssel sind `device:<id>` bzw.
`entity:<entity_id>`; eine leere Liste entfernt die individuelle Sortierung.
Der gemeinsame Einstellungs-Stream verteilt Änderungen an andere Clients.
Die Raumansicht behält auch mit individueller Sortierung ihre Abschnitte wie
**Licht** und **Beschattung**. Innerhalb jedes Abschnitts gilt die gespeicherte
Gerätereihenfolge. Die Abschnitte folgen dem jeweils ersten Gerät in dieser
Reihenfolge; ohne individuelle Sortierung gilt die übliche Reihenfolge der
Gerätetypen. Gerätegruppen ersetzen weiterhin ihre Mitglieder, auch unter
„Ohne Raum“ bei verwaisten Raumzuordnungen. Neue Geräte erscheinen innerhalb
ihres Abschnitts hinter den bereits sortierten Geräten.

## Geräteaktionen

Licht- und Rollladenknöpfe in der Raumübersicht schalten bei kurzem Tippen. Horizontales Ziehen bei
gedrückter Maus oder mit dem Finger öffnet den Regler sofort und verändert den
Wert bereits mit derselben Bewegung. Langes Halten öffnet ihn weiterhin nach
400 ms. Eine kleine Bewegungstoleranz verhindert versehentliches Öffnen beim
Tippen; vertikales Ziehen vor dem Öffnen bricht die Geste ab. Der angezeigte Wert wird erst beim
Loslassen übernommen, Abbrechen verwirft ihn. Regler erscheinen nur für
dimmbare Lichter beziehungsweise positionierbare Rollläden.

In der Raumdetailansicht sind dieselben gelben und lila Balken dauerhaft sichtbar.
Das Icon schaltet die jeweilige Entität oder Gruppe. Bei Licht öffnet ein kurzer
Tipp auf den Balken die nativen Home-Assistant-Gerätedetails. Horizontales Ziehen
ändert die Helligkeit, vertikales Ziehen scrollt die Raumansicht ohne Geräteaktion.
Die Lichtfläche wartet auf eine eindeutige Richtung, bevor sie den Wert ändert;
reine An/Aus-Lichter erhalten keine Helligkeitsregelung. Rollladenbalken stellen
die Öffnung weiterhin durch Tippen oder Ziehen ein. Ein Wert wird beim
Loslassen übernommen. Der Balken bleibt währenddessen in der Geräteliste,
einschließlich Gerätename, Prozentwert und gegebenenfalls Gruppenhinweis.
Geräte ohne entsprechende Einstellmöglichkeit zeigen nur ihren Status und den
Schalter. Unbekannte Werte bleiben als „—“ gekennzeichnet.
Das Glühbirnen-Symbol zeigt bekannte Helligkeit durch kurze Strahlen, die mit dem
Wert länger und deutlicher werden, sowie eine dezente warme Innenfüllung.
Übersicht und Raumdetails verwenden dieselbe Darstellung;
beim Ziehen folgt sie der Vorschau und kehrt beim Abbrechen zum Gerätestand zurück.
Reine An/Aus-Lampen zeigen nur die beiden Zustände, unbekannte Helligkeit bleibt neutral.
Die Regler beschriften Licht bei 0/100 mit „Aus“/„An“ und Rollläden mit „Zu“/„Auf“.
Zwischenwerte von 1 bis 99 behalten Zahl und Prozentzeichen, unbekannte Werte „—“.

Alle Funktionen liefern ein Promise und lassen HA-Fehler zum UI durch. Vor dem Aufruf prüfen sie die aktuellen `hass.states` erneut. Jeder Service-Aufruf hat konkrete Entity-IDs; es gibt keine pauschalen Aktionen ohne Targets.

- `toggleRoomLights(hass, room)`: sobald mindestens eine verfügbare Leuchte an ist, alle verfügbaren Raumleuchten ausschalten; andernfalls einschalten.
- `setRoomBrightness(hass, room, percent)`: nur verfügbare Leuchten mit dimmbaren `supported_color_modes`; reine Ein/Aus-Leuchten bleiben unberührt. 0 schaltet diese dimmbaren Leuchten aus.
- `toggleRoomCovers(hass, room)`: offene Raum-Rollläden schließen, sonst öffnen. Es werden nur unterstützte Befehle geschickt. Geräte, die ausschließlich Position unterstützen, erhalten Position 0 oder 100.
- `setRoomCoverPosition(hass, room, percent)`: nur verfügbare Geräte mit `SET_POSITION`.
- `callVacuumAction(hass, entity, action)`: `start`, `pause`, `stop`, `return_to_base`, `locate` oder `clean_spot`, soweit das Gerät den passenden Feature-Bit meldet. Zulässige Aktionen stehen in `entity.actions`.

## Offizielle Grundlagen

Geprüft gegen HA Core **2026.10.2**: [Registry-WebSocket-Befehle](https://github.com/home-assistant/core/tree/2026.10.2/homeassistant/components/config), [Area-Felder und Ereignisse](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/helpers/area_registry.py), [Licht-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/light/const.py), [Cover-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/cover/const.py), [Vacuum-Fähigkeiten](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/vacuum/const.py). Das [hass-Objekt](https://contributors.home-assistant.io/frontend/reference/hass-object/) stellt Zustände, Verbindung und Service-Methoden bereit.

Tests: `node --test tests/ha-model.test.mjs`. Diese Tests prüfen Datenzuordnung, Fähigkeiten, Targets und Lebenszyklus. Sie ersetzen die Abnahme im tatsächlichen Home Assistant nicht.
