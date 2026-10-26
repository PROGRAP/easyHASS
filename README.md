# Easy-Hass · Alpha

Eine reduzierte, raumorientierte Oberfläche für Home Assistant.

**Aktuelle Vorabversion: `0.2.0-alpha.6` · Noch keine stabile Veröffentlichung.**
Die Alpha wurde mit Home Assistant 2026.10.2 in einer getrennten Testinstallation
geprüft. Andere HA-Versionen, physische Geräte und native Companion-Apps sind
noch nicht vollständig abgedeckt.

Easy-Hass erscheint als zusätzlicher Menüpunkt unter `/easy-hass`.
**Das vorhandene Standarddashboard bleibt unverändert.** Die Integration nutzt
die vorhandene Home-Assistant-Anmeldung und die bestehenden Berechtigungen.

## Funktionen

- Räume mit Foto, Temperatur, Luftfeuchtigkeit und kompakten Licht-/Rollladenreglern.
- Raumkarten vergrößern sich zur Detailansicht; horizontal wischen wechselt den Raum.
- Raumverwaltung mit Fotoauswahl, Ausblenden und Drag & Drop für die Raumreihenfolge.
- Geräte pro Raum zuweisen, zusätzlich anzeigen und sortieren; Gerätegruppen ohne doppelte Darstellung ihrer Mitglieder.
- Licht und Rollläden direkt durch seitliches Ziehen einstellen; in der Übersicht auch durch langes Halten.
- In Raumdetails öffnet ein Tipp auf den Lichtbalken die Gerätedetails, das Glühbirnen-Icon schaltet.
- Wetterdetailansicht mit stündlicher und täglicher Vorhersage aus Home Assistant.
- Helle, dunkle und automatische Darstellung, Tastaturbedienung und reduzierte Bewegung.
- Fotoheader mit automatisch berechneter Durchschnittsfarbe des sichtbaren Bildausschnitts.
- Rückkehr zur normalen HA-Oberfläche über „Mehr → Expertenansicht“.

Räume, Fotos, Geräte und Zustände kommen aus deiner eigenen HA-Installation.
Es werden keine Beispielräume oder Geräte auf dem Server angelegt.

## Über HACS installieren

[Repository in HACS öffnen](https://my.home-assistant.io/redirect/hacs_repository/?owner=prograp&repository=easyHASS&category=integration)

1. In HACS unter **⋮ → Benutzerdefinierte Repositories**
   `https://github.com/prograp/easyHASS` mit Typ **Integration** hinzufügen.
2. **Easy-Hass** öffnen und herunterladen. Im Versionsdialog die Vorabversion
   **`v0.2.0-alpha.6`** wählen; bei Bedarf „Need a different version?“ öffnen.
3. Home Assistant neu starten.
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → Easy-Hass**.
5. Den zusätzlichen Menüpunkt öffnen. Für die erste Prüfung mit sichtbarem
   HA-Menü `/easy-hass?easy_hass_navigation=show` verwenden.

HACS verwaltet die Dateien; der Einrichtungsdialog aktiviert anschließend das
Panel. Das Repository ist ein benutzerdefiniertes HACS-Repository und wird nicht
als Bestandteil des offiziellen Standardkatalogs angeboten.

[Ausführliche Installation, Updates und Entfernung](docs/INSTALLATION.md)

## Manuell installieren

Das ZIP `easy-hass-0.2.0-alpha.6.zip` aus den
[GitHub-Releases](https://github.com/prograp/easyHASS/releases) im
HA-Konfigurationsverzeichnis entpacken. Es enthält
`custom_components/easy_hass/`. Anschließend neu starten und die Integration
wie oben hinzufügen.

## Entwicklung

Node.js 22 oder neuer und Python 3:

```sh
npm ci
npm run build
npm run check
npm test
npm run test:dom
npm run test:build
npm run package
```

Der vollständige Frontend-Build ist eingecheckt; für die Installation über HACS
muss auf dem HA-Server nichts kompiliert werden. Das Installationspaket enthält
nur die Integration. Lokale Anmeldedaten, Testzustände und Design-Exporte gehören
nicht zum Repository.

- [Lokale, isolierte Home-Assistant-Testinstallation](docs/LOCAL_HA.md)
- [Räume, Geräte und Gruppen im Datenmodell](docs/HA-MODEL.md)
- [Fehler melden](https://github.com/prograp/easyHASS/issues)

## Lizenz

Copyright (C) 2026 PROGRAP GmbH.

Easy-Hass steht unter der **GNU General Public License, Version 3**
(`GPL-3.0-only`). Den vollständigen Lizenztext findest du in [LICENSE](LICENSE).
Eine identische Kopie unter `custom_components/easy_hass/LICENSE` wird bei der
Installation über HACS und im Installations-ZIP mitgeliefert.

Der vollständige Quellcode einschließlich der Build-Skripte ist in diesem
Repository verfügbar. Für eine veröffentlichte Version verwende den zugehörigen
Release-Tag; die Build-Anleitung steht oben unter „Entwicklung“.

Die mitgelieferten Heroicons (MIT) und die Schrift Inter (SIL Open Font License 1.1)
behalten ihre jeweiligen Lizenzen. Die Lizenz- und Quellenangaben liegen unter
`frontend/src/assets/`, im Frontend-Build sowie für die Heroicons-basierten
Integrationslogos unter `custom_components/easy_hass/brand/`.
