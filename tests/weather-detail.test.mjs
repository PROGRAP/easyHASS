import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeatherContent } from '../frontend/src/weather-detail.js';
import { normalizeForecast } from '../frontend/src/weather-data.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const entity = (attributes = {}, state = 'partlycloudy') => ({ state, attributes: {
  temperature: 9.1, temperature_unit: '°C', wind_speed_unit: 'km/h', precipitation_unit: 'mm', ...attributes,
} });
const hass = time_zone => ({ connected: true, config: { time_zone }, states: {} });
const ready = rows => ({ status: 'ready', forecast: normalizeForecast(rows) });
const unsupported = () => ({ status: 'unsupported', forecast: [] });
const forecasts = (hourly = unsupported(), daily = unsupported()) => ({ hourly, daily });
const row = (hours, extra = {}) => ({ datetime: new Date(NOW + hours * 3600000).toISOString(), temperature: 9, ...extra });
const section = (html, id) => html.match(new RegExp(`<section[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? '';
const metric = (html, key) => {
  const match = html.match(new RegExp(`data-weather-metric="${key}"[\\s\\S]*?<div class="weather-metric-value">([\\s\\S]*?)<\\/div>(?:<p>([\\s\\S]*?)<\\/p>)?`));
  return match ? { value: match[1], detail: match[2] ?? '' } : null;
};

test('HA timezone determines hourly labels, today ranges and removal of past days independently of the host timezone', () => {
  const now = Date.parse('2026-10-25T23:30:00Z');
  const data = forecasts(ready([{ datetime: '2026-10-25T23:45:00Z', temperature: 8 }]), ready([
    { datetime: '2026-10-25T12:00:00Z', temperature: 11, templow: 1 },
    { datetime: '2026-10-26T12:00:00Z', temperature: 22, templow: 2 },
  ]));
  const tokyo = renderWeatherContent(entity(), data, hass('Asia/Tokyo'), now);
  assert.match(section(tokyo, 'weather-hourly'), />08 Uhr<\/time>/);
  assert.match(tokyo, /class="weather-range">H 22° · T 2°<\/p>/);
  assert.match(section(tokyo, 'weather-daily'), /weather-day-2026-10-26/);
  assert.doesNotMatch(section(tokyo, 'weather-daily'), /weather-day-2026-10-25/);
  const pacific = renderWeatherContent(entity(), data, hass('America/Los_Angeles'), now);
  assert.match(section(pacific, 'weather-hourly'), />16 Uhr<\/time>/);
  assert.match(pacific, /class="weather-range">H 11° · T 1°<\/p>/);
  assert.match(section(pacific, 'weather-daily'), /weather-day-2026-10-25/);
  assert.match(section(pacific, 'weather-daily'), /weather-day-2026-10-26/);
  const fallback = renderWeatherContent(entity(), data, hass('Invalid/Zone'), now);
  assert.match(section(fallback, 'weather-hourly'), />23 Uhr<\/time>/);
});

test('measured zero remains visible and absent readings are neither invented nor turned into zero', () => {
  const data = forecasts(ready([row(0, { temperature: 0 })]), ready([row(0, { temperature: 0, templow: 0, precipitation: 0 })]));
  const zero = renderWeatherContent(entity({ temperature: 0, wind_speed: 0, humidity: 0, dew_point: 0, uv_index: 0, cloud_coverage: 0, pressure: 0, pressure_unit: 'hPa' }), data, hass('UTC'), NOW);
  assert.match(zero, /weather-current-temperature">0°/);
  assert.match(zero, /weather-range">H 0° · T 0°/);
  assert.deepEqual(metric(zero, 'precipitation'), { value: '0 mm', detail: 'Heute' });
  assert.deepEqual(metric(zero, 'humidity'), { value: '0 %', detail: 'Taupunkt 0°' });
  assert.deepEqual(metric(zero, 'wind'), { value: '0 km/h', detail: '' });
  assert.deepEqual(metric(zero, 'uv'), { value: '0', detail: 'Niedrig' });
  assert.equal(metric(zero, 'clouds').value, '0 %');
  const absent = renderWeatherContent(entity({ temperature: null }), forecasts(ready([row(0, { temperature: undefined })])), hass('UTC'), NOW);
  assert.match(absent, /weather-current-temperature">—<\/div>/);
  assert.match(section(absent, 'weather-hourly'), /<span>—<\/span>/);
  for (const key of ['wind', 'precipitation', 'humidity', 'uv', 'clouds', 'pressure']) assert.equal(metric(absent, key), null, key);
  assert.doesNotMatch(absent, /weather-range/);
});

test('a 24-hour rain total requires 24 consecutive measured hours; incomplete data uses only a real daily amount', () => {
  const hours = Array.from({ length: 24 }, (_, i) => row(i, { precipitation: .5 }));
  const render = (hourly, daily = []) => renderWeatherContent(entity(), forecasts(ready(hourly), ready(daily)), hass('UTC'), NOW);
  assert.deepEqual(metric(render(hours), 'precipitation'), { value: '12 mm', detail: 'Nächste 24 Stunden' });
  for (const incomplete of [
    hours.slice(0, 23),
    hours.map((item, index) => index === 7 ? { ...item, precipitation: undefined } : item),
    hours.filter((_, index) => index !== 7).concat(row(24, { precipitation: .5 })),
  ]) {
    assert.equal(metric(render(incomplete), 'precipitation'), null);
    assert.deepEqual(metric(render(incomplete, [row(0, { precipitation: 3 })]), 'precipitation'), { value: '3 mm', detail: 'Heute' });
  }
  const tomorrowOnly = [row(24, { precipitation: 8 })];
  assert.equal(metric(render(hours.slice(0, 6), tomorrowOnly), 'precipitation'), null, 'tomorrow is never relabelled as today');
});

test('duplicate forecast instants cannot create duplicate controls or inflate the rain total', () => {
  const hours = Array.from({ length: 24 }, (_, i) => row(i, { precipitation: 1 }));
  const duplicate = { datetime: '2026-10-25T14:00:00+02:00', temperature: 7, precipitation: 2 };
  const normalized = normalizeForecast([...hours, duplicate]);
  assert.equal(normalized.length, 24);
  assert.equal(normalized[0].temperature, 7, 'the last reading replaces the same instant');
  const html = renderWeatherContent(entity(), forecasts(ready(normalized)), hass('UTC'), NOW);
  const ids = [...html.matchAll(/id="(weather-hour-\d+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 24);
  assert.equal(new Set(ids).size, 24);
  assert.deepEqual(metric(html, 'precipitation'), { value: '25 mm', detail: 'Nächste 24 Stunden' });
});

test('hourly forecasts stop at the real 48-hour horizon and sparse samples are not labelled as continuous hours', () => {
  const hours = [row(-2), row(0), row(3), row(47), row(48), row(72)];
  const html = renderWeatherContent(entity(), forecasts(ready(hours)), hass('UTC'), NOW);
  const hourly = section(html, 'weather-hourly');
  const ids = [...hourly.matchAll(/id="weather-hour-(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(ids, [0, 3, 47].map(hour => NOW + hour * 3600000));
  assert.doesNotMatch(hourly, /<span>\d+ Stunden?<\/span>/);
});

test('an hourly error leaves daily forecasts and current readings intact, while unsupported sections remain absent', () => {
  const daily = ready([row(0, { templow: 3 }), row(24, { templow: 4 })]);
  const html = renderWeatherContent(entity({ humidity: 70 }), forecasts({ status: 'error', forecast: [] }, daily), hass('UTC'), NOW);
  assert.match(section(html, 'weather-hourly'), /Vorhersage konnte nicht geladen werden/);
  assert.match(section(html, 'weather-hourly'), /data-weather-retry/);
  assert.match(section(html, 'weather-daily'), /2-Tage-Vorhersage/);
  assert.equal(metric(html, 'humidity').value, '70 %');
  assert.match(html, /weather-current-temperature">9,1°/);
  const unsupportedHtml = renderWeatherContent(entity(), forecasts(unsupported(), daily), hass('UTC'), NOW);
  assert.equal(section(unsupportedHtml, 'weather-hourly'), '');
  assert.match(section(unsupportedHtml, 'weather-daily'), /2-Tage-Vorhersage/);
  const loading = renderWeatherContent(entity(), forecasts({ status: 'loading', forecast: [] }, daily), hass('UTC'), NOW);
  assert.match(section(loading, 'weather-hourly'), /aria-busy="true"/);
  assert.match(section(loading, 'weather-daily'), /2-Tage-Vorhersage/);
});

test('provider text is escaped and HA Fahrenheit, mph and inch values are shown without conversion', () => {
  const source = 'Met <img src=x onerror="alert(1)"> & Partner';
  const html = renderWeatherContent(entity({ temperature: 68, temperature_unit: '°F', wind_speed: 10, wind_speed_unit: 'mph', humidity: 50, dew_point: 40, precipitation_unit: 'in', pressure: 29.92, pressure_unit: 'inHg', attribution: source }),
    forecasts(ready([row(0, { temperature: 70 })]), ready([row(0, { temperature: 72, templow: 50, precipitation: .5 })])), hass('UTC'), NOW);
  assert.match(html, /weather-current-temperature">68°<span class="weather-unit">F<\/span>/);
  assert.match(html, /weather-range">H 72° · T 50°/);
  assert.match(section(html, 'weather-hourly'), /70 °F/);
  assert.equal(metric(html, 'wind').value, '10 mph');
  assert.deepEqual(metric(html, 'precipitation'), { value: '0,5 in', detail: 'Heute' });
  assert.equal(metric(html, 'humidity').detail, 'Taupunkt 40°');
  assert.equal(metric(html, 'pressure').value, '29,92 inHg');
  assert.match(html, /Met &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; Partner/);
  assert.doesNotMatch(html, /<img|°C|km\/h/);
});

test('unknown, unavailable, missing and disconnected weather never display stale forecast or metric values', () => {
  const data = forecasts(ready([row(0)]), ready([row(0)]));
  for (const weather of [undefined, entity({ humidity: 70 }, 'unknown'), entity({ humidity: 70 }, 'unavailable')]) {
    const html = renderWeatherContent(weather, data, hass('UTC'), NOW);
    assert.match(html, /Wetterdaten sind gerade nicht verfügbar/);
    assert.doesNotMatch(html, /weather-current|weather-hourly|weather-daily|weather-metrics/);
  }
  const offline = renderWeatherContent(entity({ humidity: 70 }), data, { ...hass('UTC'), connected: false }, NOW);
  assert.match(offline, /Verbindung zu Home Assistant ist unterbrochen/);
  assert.doesNotMatch(offline, /weather-current|weather-hourly|weather-daily|weather-metrics/);
  const unfamiliar = renderWeatherContent(entity({}, 'new-provider-condition'), data, hass('UTC'), NOW);
  assert.match(unfamiliar, /Status unbekannt/);
  assert.match(unfamiliar, /weather-current-temperature">9,1°/);
});
