# Easy-Hass installieren

**Version 0.2.0-alpha.3 · Stand 25. Oktober 2026**

**Alpha / Vorabversion:** Diese Ausgabe ist für frühe Tests gedacht und kann
Fehler oder noch unvollständiges Verhalten enthalten. Vor der Installation
die Home-Assistant-Konfiguration sichern.

Easy-Hass wurde in einer echten Home-Assistant-Testinstanz mit Version
**2026.10.2** eingerichtet und aktiviert. Die Integration verwendet die vorhandene
HA-Anmeldung und benötigt keine zusätzlichen Zugangsdaten. Die Kompatibilität
mit anderen HA-Versionen und nativen Companion-Apps ist noch nicht bestätigt.

Easy-Hass wird als zusätzliches Panel installiert. **Dein bisheriges
Standarddashboard bleibt unverändert.** Es ist keine Änderung an
`configuration.yaml`, Benutzer-Startseiten oder Dashboard-Einstellungen nötig.

## 1. Dateien installieren

### Über HACS als benutzerdefiniertes Repository

Voraussetzung: HACS ist eingerichtet und das Repository
[prograp/easyHASS](https://github.com/prograp/easyHASS) ist öffentlich erreichbar.
Diese Anleitung beschreibt ein benutzerdefiniertes Repository; eine Aufnahme
in den HACS-Standardkatalog wird damit nicht vorausgesetzt.

1. In Home Assistant **HACS** öffnen.
2. Über das Drei-Punkte-Menü **Benutzerdefinierte Repositories / Custom
   repositories** öffnen.
3. Als Repository `https://github.com/prograp/easyHASS` eintragen und den Typ
   **Integration** auswählen.
4. **Hinzufügen** wählen, anschließend **Easy-Hass** in HACS öffnen und
   **Herunterladen** wählen. Bei einem bereits geladenen Repository über das
   Drei-Punkte-Menü **Erneut herunterladen / Redownload** öffnen.
5. Im Download-Dialog **Andere Version benötigt? / Need a different version?**
   öffnen und die Vorabversion **v0.2.0-alpha.3** auswählen. Die Auswahl setzt
   voraus, dass dieser GitHub-Prerelease veröffentlicht wurde.
6. Mit dem Neustart und der Aktivierung in den folgenden Abschnitten fortfahren.

HACS übernimmt das Kopieren der Integrationsdateien. Ein manueller ZIP-Import
ist für diesen Weg nicht erforderlich. Die Schritte zum Hinzufügen entsprechen
der [offiziellen HACS-Anleitung für benutzerdefinierte Repositories](https://www.hacs.xyz/docs/faq/custom_repositories/).
Die [Versionsauswahl im Download-Dialog](https://www.hacs.xyz/docs/use/repositories/dashboard/#downloading-a-specific-version-of-a-repository)
erlaubt die gezielte Installation der Alpha.

Damit spätere Vorabversionen auch bei Update-Prüfungen berücksichtigt werden,
den zu Easy-Hass gehörenden **Pre-release-Schalter** der HACS-Integration in der
HA-Entitätenverwaltung aktivieren und einschalten. Diese Schalter sind
standardmäßig deaktiviert; sie steuern die Berücksichtigung von Vorabversionen
bei Updates. Siehe [HACS-Schalter für Vorabversionen](https://www.hacs.xyz/docs/use/entities/switch/).

### Alternativ: Installationspaket manuell kopieren

Das Frontend liegt vollständig unter `custom_components/easy_hass/frontend/`.
Zum Erstellen des Pakets im Repository werden Node.js 22 oder neuer und Python 3
benötigt. Eine npm-Installation ist für diesen Schritt nicht erforderlich.

```sh
npm run package
```

Das erzeugt `dist/easy-hass-0.2.0-alpha.3.zip`. Dieses ZIP direkt im
HA-Konfigurationsverzeichnis entpacken. Alternativ den vollständigen Ordner
`custom_components/easy_hass/` dorthin kopieren. Die Struktur muss so aussehen:

```text
<HA-Konfigurationsverzeichnis>/
└── custom_components/
    └── easy_hass/
        ├── __init__.py
        ├── config_flow.py
        ├── const.py
        ├── manifest.json
        ├── strings.json
        ├── translations/
        └── frontend/
            ├── build.json
            └── builds/
                └── <Build-Fingerprint>/
                    ├── easy-hass.js
                    ├── ha-model.js
                    ├── room-detail.js
                    ├── dom.js
                    ├── icons.js
                    ├── panel.css
                    ├── compatibility/
                    └── assets/
```

Bei Home Assistant OS ist das Konfigurationsverzeichnis gewöhnlich `/config`.
Bei anderen Installationsarten das dort konfigurierte HA-Verzeichnis verwenden.
Den Projektordner nicht als zusätzliche Unterebene kopieren. Auch `assets/`
muss enthalten sein; dort liegen die lokal ausgelieferten Schriften und Icons.

## 2. Home Assistant neu starten

Nach dem HACS-Download oder dem manuellen Kopieren Home Assistant neu starten,
damit die Custom Integration erkannt wird. Das Herunterladen allein aktiviert
das Panel noch nicht.

## 3. Easy-Hass aktivieren

1. Als Administrator die normale HA-Oberfläche öffnen.
2. **Einstellungen → Geräte & Dienste → Integration hinzufügen** wählen.
3. Nach **Easy-Hass** suchen und den Einrichtungsdialog bestätigen.
4. **Easy-Hass** in der Seitenleiste oder direkt `/easy-hass` öffnen.

Die Raumübersicht zeigt die vorhandene HA-Konfiguration. Es werden keine
Beispielräume, Fotos oder Geräte in die eigene Installation übernommen.
Easy-Hass setzt sich nicht als Startseite und ändert keine gespeicherten
Einstellungen der HA-Seitenleiste. Im geöffneten Easy-Hass-Panel wird die
normale HA-Navigation lediglich vorübergehend ausgeblendet. Zum ersten Prüfen
mit sichtbarem HA-Menü direkt `/easy-hass?easy_hass_navigation=show` öffnen.

## 4. Räume und Geräte in HA pflegen

Raumnamen, Reihenfolge und Bilder werden aus Home Assistant übernommen.
Unter **Mehr → Einstellungen → Räume** lassen sich Räume anlegen und bearbeiten.
Im Raumformular kannst du den Namen ändern sowie über **Bild ändern** oder
**Bild hinzufügen** eine JPG-, PNG- oder GIF-Datei bis 10 MB auswählen. Die
Vorschau ist zunächst lokal; **Speichern** übernimmt Namen und Bild in Home
Assistant. **Entfernen** nimmt das Bild nach dem Speichern vom Raum. Zurückgehen
ohne Speichern verwirft die Auswahl. Diese Änderungen benötigen ein Administratorkonto.
In der Raumliste kannst du einen Raum am linken Ziehgriff nach oben oder unten
verschieben. Die Reihenfolge wird beim Loslassen automatisch in Home Assistant
gespeichert und auch auf der Easy-Hass-Startseite verwendet. Der Pfeil rechts
öffnet weiterhin die Raum-Bearbeitung. Mit der Tastatur: Griff fokussieren,
Leertaste oder Enter zum Aufnehmen, Pfeiltasten zum Verschieben, erneut bestätigen;
Escape bricht ab.
Räume und ihre Fotos lassen sich weiterhin in der normalen HA-Raumverwaltung bearbeiten.
Geräte unter **Einstellungen → Geräte & Dienste** dem passenden Raum zuordnen.
Eine explizite Raumzuordnung der Entity hat Vorrang vor der des Geräts.

Neue und umbenannte Räume sowie geänderte Zuordnungen erscheinen automatisch
in Easy-Hass. Leere Räume bleiben sichtbar. Geräte ohne Raum stehen unter
„Ohne Raum“. Ausgeblendete oder deaktivierte Entities werden nicht als
bedienbare Geräte übernommen.

Temperatur und Luftfeuchtigkeit stammen aus den entsprechenden HA-Sensoren.
Wenn für den Raum bevorzugte Sensoren hinterlegt sind, verwendet Easy-Hass
diese. Fehlende Werte werden nicht erfunden. Raumfotos kommen aus dem in HA
hinterlegten Raumbild; ohne Foto erscheint ein neutrales Symbol.

Auf jeder Karte werden vorhandene Lichter und Rollläden als gemeinsame
Raumsteuerung angeboten. Kurzes Tippen schaltet, Halten für etwa 400 ms öffnet
bei geeigneten Geräten den Regler. Während des Haltens horizontal ziehen und
loslassen übernimmt den Wert. Ein Licht, das nur ein/aus unterstützt, erhält
keinen Helligkeitsregler; ein Rollladen ohne Positionssteuerung keinen
Positionsregler.

## Zurück zur normalen Oberfläche

Unter **Mehr → Expertenansicht** wird die normale HA-Oberfläche geöffnet und
deren Navigation wiederhergestellt. Administratoren gelangen zu den
Einstellungen, andere Benutzer zu einem zugänglichen Dashboard oder zum Profil.
Home Assistant entscheidet weiterhin über Berechtigungen.

- **HA-Menü im Panel anzeigen:** Unter Mehr den entsprechenden Link wählen oder
  `/easy-hass?easy_hass_navigation=show` öffnen.
- **Leere Raumübersicht:** In HA Räume anlegen und Geräte zuordnen. Es gibt keinen
  fest eingebauten Satz von Designräumen als Ersatz.
- **Fehlende Messwerte oder gesperrte Tasten:** Den Zustand und die unterstützten
  Funktionen der betreffenden Entity in Home Assistant prüfen. `unknown` und
  `unavailable` werden nicht als gültige Messwerte behandelt.
- **Verbindung unterbrochen:** Die Gerätebedienung ist bis zur Wiederverbindung
  gesperrt. Bei einem Ladefehler bietet das Panel „Erneut versuchen“ an.
- **Karte oder Energie fehlen:** Diese Menüpunkte benötigen die entsprechende
  vorhandene und zugängliche HA-Ansicht.
- **Frontend lädt nicht:** Direkt `/config` als Administrator oder ein vorhandenes
  Dashboard öffnen. Bei einer unbekannten HA-Seitenstruktur bleibt die originale
  Navigation sichtbar.

## Aktualisieren oder entfernen

Bei Installation über HACS das dort angebotene Update herunterladen,
Home Assistant neu starten und das Panel vollständig neu laden. Bei manueller
Installation stattdessen den vollständigen Integrationsordner durch die neue
Version ersetzen. Das bestehende Standarddashboard bleibt auch bei Updates
unverändert. Das Frontend verwendet für zusammengehörige Dateien einen
gemeinsamen Build-Fingerprint, damit aktualisierte Module, Stile und Assets
nicht mit einem älteren Cache-Stand vermischt werden.

Zum Deaktivieren oder Entfernen den Easy-Hass-Eintrag unter
**Einstellungen → Geräte & Dienste** verwenden. Dadurch werden keine vorhandenen
HA-Geräte, Räume, Dashboards oder Automationen gelöscht. Die lokale
Entwicklungstestinstallation ist davon getrennt; ihre Verwaltung beschreibt
[LOCAL_HA.md](LOCAL_HA.md). Wenn die Dateien über HACS installiert wurden,
anschließend dort den Download entfernen. Die Integrationsentfernung allein
setzt das Standarddashboard nicht neu.
