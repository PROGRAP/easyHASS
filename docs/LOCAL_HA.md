# Lokale Prüfung in Home Assistant

Die Entwicklung wird gegen eine echte, getrennte Home-Assistant-Instanz geprüft:
**Home Assistant 2026.10.2**, offizielles Container-Image
`ghcr.io/home-assistant/home-assistant:2026.10.2`.
Sie ist ausschließlich unter `http://127.0.0.1:8123` erreichbar.

Auf diesem Mac läuft der Container in der Linux-VM von Docker Desktop. Das ist
eine lokale Entwicklungsumgebung. Für eine dauerhafte Hausinstallation empfiehlt
Home Assistant unter macOS HA OS in einer VM; der produktiv unterstützte
Container-Betrieb verwendet Docker Engine unter Linux. Hardware, Multicast-
Discovery und Companion-Apps sind von diesem Test nicht abgedeckt.

Offizielle Grundlagen: [Installationsarten](https://www.home-assistant.io/installation/),
[Container unter Linux](https://www.home-assistant.io/installation/linux/),
[macOS](https://www.home-assistant.io/installation/macos/).

## Starten und einrichten

Voraussetzungen: laufende Docker-Engine, Python 3 und Node.js 22 oder neuer.
Vom Repository-Verzeichnis aus:

```sh
npm run build
python3 scripts/ha-local.py start
node scripts/ha-bootstrap.mjs
```

Beim ersten Start wird das offizielle Image geladen. Die Einrichtung aktiviert
Easy-Hass und die separate Testgeräte-Integration über die normalen
HA-Einrichtungsdialog-APIs. Danach ist das Panel unter
[Easy-Hass lokal](http://127.0.0.1:8123/easy-hass) verfügbar.

Nach Änderungen am Frontend erneut `npm run build` ausführen und die Integration
**Easy-Hass** unter Geräte & Dienste neu laden. Anschließend den Browser-Tab neu
laden. Jeder Build erhält einen Fingerprint für alle zusammengehörigen Module,
Styles und Bilder; der Home-Assistant-Cache kann dadurch keine alten Dateien
mit dem neuen Stand mischen. Bei Änderungen an der Python-Integration ist
stattdessen ein Neustart der lokalen HA-Instanz erforderlich.

Für einen direkten Einstieg kann ein angemeldetes Browserfenster geöffnet werden.
Nach Installation der Playwright-Entwicklungsabhängigkeit und Chromium:

```sh
npm install
npx playwright install chromium
node scripts/browser-login.mjs --open
```

Das Fenster verwendet ausschließlich das lokale Testkonto und bleibt bis zum
Schließen geöffnet. Passwörter und Sitzungstoken werden dabei nicht ausgegeben.

Anmeldedaten liegen ausschließlich in `.local-ha/auth.json`; die Datei hat
Zugriffsmodus `0600` und wird von Git ignoriert. Bei einer neuen Einrichtung heißt
das Konto in der Oberfläche „Easy-Hass Test“ und erhält ein zufälliges Passwort.
Die Datei enthält außerdem die lokalen Test-Zugriffstoken; diese nicht
veröffentlichen.

Konfiguration, HA-Datenbank und Konto liegen unter `.local-ha/`. Es wird kein
vorhandenes Home Assistant verändert. Der Container verwendet keine privilegierte
Ausführung, kein Host-Netzwerk und keine angeschlossene Hardware. Er startet
nicht automatisch beim Einschalten des Rechners.

```sh
python3 scripts/ha-local.py status
python3 scripts/ha-local.py stop
```

## Testdaten und Datenherkunft

`tests/ha-fixture/easy_hass_fixture/` ist eine reine Entwicklungsintegration.
Sie erzeugt normale HA-Räume, Geräte und Entities in den echten HA-Registries:

- Wohnzimmer, Küche, Esstisch, Schlafzimmer und Flur.
- Sechs Lichter; im Wohnzimmer ein dimmbares Licht und ein separates Licht, das
  nur ein- und ausgeschaltet werden kann.
- Einen Rollladen mit Positionssteuerung, zehn Temperatur-/Feuchtesensoren,
  einen Energiesensor und einen Saugroboter.

Die Testgeräte reagieren auf die normalen HA-Serviceaufrufe. Zustandsänderungen
werden von HA über seine WebSocket-Verbindung gemeldet. Die Geräte sind
synthetisch; es werden keine physischen Geräte geschaltet. Ihre Anfangszustände
werden bei Neustart zurückgesetzt.

Für optionale Raumfotos können eigene PNG-Dateien vor dem Start unter
`.local-ha/photos/` im Repository-Verzeichnis abgelegt werden. Dieser Ordner
wird wie die übrigen lokalen Laufzeitdaten von Git ignoriert:

| Datei | Testraum |
| --- | --- |
| `living.png` | Wohnzimmer |
| `kitchen.png` | Küche |
| `dining.png` | Esstisch |
| `bedroom.png` | Schlafzimmer |
| `hall.png` | Flur |

Das Startskript kopiert vorhandene Quelldateien nach
`.local-ha/config/www/easy-hass-fixture/`, sofern die jeweilige Zieldatei noch
nicht existiert. Bereits dort vorhandene Bilder bleiben erhalten. Das
Einrichtungsprogramm hinterlegt die Bilder als `picture` in der HA-Area-Registry.
Ohne Fotoquelle funktioniert die Testinstanz mit den normalen Platzhaltern für
fehlende Raumbilder. Der Produktcode enthält weder diese Räume noch eine feste
Zuordnung von Räumen zu Fotos. In einer eigenen Installation werden die dort
konfigurierten HA-Räume, Zuordnungen und Bilder verwendet.

Die Testintegration und diese Fotos werden **nicht** mit dem installierbaren
Easy-Hass-Paket ausgeliefert.

Die lokale Konfiguration aktiviert außerdem die nativen HA-Ansichten für Karte
und Energie. Die Energieansicht benötigt wie in einer normalen HA-Installation
eine Einrichtung ihrer Datenquellen. Es werden keine Verbrauchsverläufe oder
Kosten erfunden; der synthetische Energiesensor stellt zunächst nur einen
konstanten Zählerstand bereit.

## Reproduzierbare API-Prüfung

```sh
node scripts/ha-smoke.mjs
```

Der Test prüft reale Registry-Zuordnungen, die HA-Panelregistrierung, ausgelieferte
Frontenddateien, Lichtschalten und Dimmen, Rollladenpositionen 49/0/100 %, den
Saugroboter, Klimadaten und WebSocket-Ereignisse. Er erstellt und benennt außerdem
einen zusätzlichen Raum um und verschiebt ein Licht vorübergehend in diesen
Raum. Damit werden Änderungen an HA-Daten ohne Änderungen am Frontend geprüft.
Die Änderungen werden anschließend zurückgesetzt. Der Bericht liegt unter
`test-results/ha-smoke.json`.

Die fünf optionalen Raumfotos müssen für die vollständige Foto-Prüfung vorhanden sein.
Browserprüfungen ergänzen diesen API-Test: Der API-Test allein beweist keine
Darstellung oder Touch-Geste in der Oberfläche.

`npm run test:settings` prüft die Navigation **Mehr → Einstellungen → Räume**,
Anlegen und Umbenennen über die Oberfläche, Persistenz nach Neuladen,
Duplikatfehler sowie Fokusführung und schmale Displays in Hell/Dunkel.
Die Bildprüfungen decken lokale Vorschau, ungültige Dateien, Upload zusammen mit
Namensänderung, Neuladen, Abbrechen und Entfernen eines Raumbilds ab.
Es wird ausschließlich ein eindeutig benannter Testraum erstellt und im
Cleanup anhand seiner eigenen Area-ID entfernt. Eigene Testbild-Uploads werden
anhand ihrer bestätigten IDs bereinigt, sofern kein Raum sie referenziert.
Bestehende Räume, Bilder, Geräte und
Gerätezustände bleiben unverändert. Bericht und Screenshots liegen unter
`test-results/browser-settings.json` beziehungsweise `test-results/settings-*.png`.

`npm run test:room-order` prüft Maus-, Touch- und Tastatursortierung,
Persistenz nach Neuladen, die Reihenfolge auf der Startseite, Abbruch,
fehlgeschlagenes Speichern und automatisches Scrollen in einer längeren Liste.
Der Test stellt abschließend die ursprüngliche HA-Reihenfolge wieder her und
entfernt ausschließlich seine eigenen temporären Räume. Bericht:
`test-results/browser-room-order.json`.

`npm run test:room-devices` prüft die Gerätezuordnung und Sortierung in einem
eigenen temporären Testraum. Dafür werden ausschließlich bekannte lokale
Fixture-Geräte kurz umgeordnet und anschließend mit ihren ursprünglichen
Area-IDs wiederhergestellt. Geprüft werden Hinzufügen/Entfernen, Persistenz,
Reihenfolge in der Raumansicht und die Trennung von Sensorgeräten und
Sensorzeilen. Geräteaktionen werden im Test abgefangen. Bericht:
`test-results/browser-room-devices.json`.

`npm run test:room-device-links` prüft direkte Zuweisung, die Auswahl bei bestehenden
Zuordnungen, zusätzliche Anzeigen in mehreren Räumen, Sortierung, Neuladen und das
gezielte Entfernen eines Verweises. Abbrechen, Speicherfehler sowie Offline- und
Admin-Sperren werden ebenfalls geprüft. Der Test erstellt eigene temporäre Räume,
blockiert Geräteaktionen und stellt alle veränderten lokalen Fixture-Zuordnungen
und EasyHASS-Einstellungen wieder her. Nicht gleichzeitig mit anderen Tests ausführen,
die diese Fixtures verschieben. Bericht: `test-results/browser-room-device-links.json`.

`npm run test:room-group-scope` prüft einen echten, eigenen HA-Gruppenhelper in
zwei temporären Räumen. Mitglieder bleiben sichtbar, solange ihre Gruppe in
einem anderen Raum oder unter „Ohne Raum“ liegt. Eine ausdrücklich zusätzlich
angezeigte oder nativ in den Raum verschobene Gruppe ersetzt ihre Mitglieder;
nach Entfernen beziehungsweise Zurückverschieben erscheinen diese wieder.
Der Test prüft Übersicht, Raumdetails, Einstellungen und Neuladen, blockiert
Gerätebefehle und stellt die ursprünglichen Fixture-Zuordnungen und Einstellungen
wieder her. Nicht parallel zu anderen Fixture-Tests ausführen. Bericht:
`test-results/browser-room-group-scope.json`.

`npm run test:room-visibility` prüft das Ausblenden und Wiedereinblenden eines
eigenen Testraums, Abbrechen, Persistenz nach Neuladen, direkte Raumlinks,
Raumwechsel, Synchronisierung zwischen zwei Clients und fehlgeschlagenes
Speichern. Bestehende Räume werden nicht ausgeblendet. Bericht und Screenshots:
`test-results/browser-room-visibility.json` und `test-results/room-visibility-*.png`.

`npm run test:weather` prüft die Wetterkarte gegen die echte lokale Wetter-Entity
und vergleicht die angezeigten Werte mit den nativen
`weather/subscribe_forecast`-Abonnements. Der Test steuert keine Geräte und ändert
keine HA-Wetterzustände. Er prüft den Chip-Morph in beide Richtungen, Scrollen,
Fokusführung, Hell/Dunkel und reduzierte Bewegung. Fehlerfälle werden ausschließlich
im isolierten Browser simuliert. Bericht: `test-results/browser-weather.json`.

Die Wetterkarte verwendet den Wetterchip als Quelle, zeigt nur tatsächlich
vorhandene Messwerte und abonniert unterstützte Stunden-/Tagesprognosen nur während
sie geöffnet ist. Tagesgrenzen folgen der HA-Zeitzone; Einheiten kommen von der
Wetter-Entity. Eine Regenmenge für die nächsten 24 Stunden erscheint nur bei einer
vollständigen, lückenlosen Stundenprognose mit 24 Niederschlagswerten;
sonst wird eine vorhandene Tagesmenge als „Heute“ angezeigt.

Die vorhandenen Backendtests lassen sich gegen die im Container installierten
echten HA-Klassen ausführen:

```sh
docker cp tests/test_integration.py easy-hass-local:/tmp/test_integration.py
docker cp tests/test_settings.py easy-hass-local:/tmp/test_settings.py
docker exec -e PYTHONPATH=/config -w /tmp easy-hass-local python -m unittest test_integration test_settings -v
```

Für weitere lokale Integrationsprüfungen stellt `scripts/ha-client.mjs` einen
kleinen authentifizierten HTTP-/WebSocket-Client bereit. Er liest Tokens nur aus
der ignorierten lokalen Datei und gibt sie nicht aus.
