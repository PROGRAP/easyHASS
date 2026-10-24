# Easy-Hass · Alpha

Eine reduzierte, raumorientierte Oberfläche für Home Assistant.

**Aktuelle Vorabversion: `0.2.0-alpha.1` · Noch keine stabile Veröffentlichung.**
Die Alpha wurde mit Home Assistant 2026.10.2 in einer getrennten Testinstallation
geprüft. Andere HA-Versionen, physische Geräte und native Companion-Apps sind
noch nicht vollständig abgedeckt.

Easy-Hass erscheint als zusätzlicher Menüpunkt unter `/easy-hass`.
**Das vorhandene Standarddashboard bleibt unverändert.** Die Integration nutzt
die vorhandene Home-Assistant-Anmeldung und die bestehenden Berechtigungen.

## Funktionen

- Räume mit Foto, Temperatur, Luftfeuchtigkeit und kompakten Licht-/Rollladenreglern.
- Raumkarten vergrößern sich zur Detailansicht; horizontal wischen wechselt den Raum.
- Einzelne Geräte nach Typ, Gerätegruppen ohne doppelte Darstellung ihrer Mitglieder.
- Kurz tippen schaltet; lang halten und ziehen dimmt Licht oder verändert die Rollladenposition.
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
   **`v0.2.0-alpha.1`** wählen; bei Bedarf „Need a different version?“ öffnen.
3. Home Assistant neu starten.
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → Easy-Hass**.
5. Den zusätzlichen Menüpunkt öffnen. Für die erste Prüfung mit sichtbarem
   HA-Menü `/easy-hass?easy_hass_navigation=show` verwenden.

HACS verwaltet die Dateien; der Einrichtungsdialog aktiviert anschließend das
Panel. Das Repository ist ein benutzerdefiniertes HACS-Repository und wird nicht
als Bestandteil des offiziellen Standardkatalogs angeboten.

[Ausführliche Installation, Updates und Entfernung](docs/INSTALLATION.md)

## Manuell installieren

Das ZIP `easy-hass-0.2.0-alpha.1.zip` aus den
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

Die mitgelieferten Heroicons und die Schrift Inter behalten ihre jeweiligen
Lizenz- und Quellenangaben unter `frontend/src/assets/` und im Frontend-Build.
