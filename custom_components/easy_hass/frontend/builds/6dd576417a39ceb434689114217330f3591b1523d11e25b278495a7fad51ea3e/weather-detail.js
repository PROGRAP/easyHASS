import { icon } from './icons.js';
import { weatherCondition } from './weather.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const numeric = value => value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const format = (value, digits = 1) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(value);
const valid = (value, min = -Infinity, max = Infinity) => { const n = numeric(value); return n !== null && n >= min && n <= max ? n : null; };

function dates(timeZone) {
  try { new Intl.DateTimeFormat('de-DE', { timeZone }).format(); }
  catch { timeZone = 'UTC'; }
  return {
    day: value => new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value)),
    weekday: value => new Intl.DateTimeFormat('de-DE', { timeZone, weekday:'short' }).format(new Date(value)).replace('.', ''),
    hour: value => new Intl.DateTimeFormat('de-DE', { timeZone, hour:'2-digit', hourCycle:'h23' }).formatToParts(new Date(value)).find(part => part.type === 'hour').value,
    full: value => new Intl.DateTimeFormat('de-DE', { timeZone, weekday:'long', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' }).format(new Date(value)),
  };
}

const heading = (id, title, aside = '') => `<div class="weather-section-heading"><h3 id="${id}">${title}</h3>${aside ? `<span>${aside}</span>` : ''}</div>`;
function pendingForecast(id, title, forecast) {
  if (forecast?.status === 'loading') return `<section class="weather-section" id="${id}" aria-busy="true">${heading(id+'-title',title)}<p class="weather-notice" role="status">Vorhersage wird geladen …</p></section>`;
  if (forecast?.status === 'error') return `<section class="weather-section" id="${id}">${heading(id+'-title',title)}<p class="weather-notice" role="status">Vorhersage konnte nicht geladen werden.</p><button class="weather-retry" data-weather-retry type="button">Erneut versuchen</button></section>`;
  return '';
}

/** Pure presentation of HA values. No location, sample weather or unit conversion is invented. */
export function renderWeatherContent(entity, forecasts, hass, now = Date.now()) {
  if (!entity || ['unavailable','unknown'].includes(entity.state) || hass?.connected === false) {
    const message = hass?.connected === false ? 'Die Verbindung zu Home Assistant ist unterbrochen.' : 'Die Wetterdaten sind gerade nicht verfügbar.';
    return `<p class="weather-notice weather-unavailable" role="status">${message}</p>`;
  }
  const a = entity.attributes || {}, date = dates(hass?.config?.time_zone || 'UTC');
  const todayKey = date.day(now);
  const temperatureUnit = a.temperature_unit || hass?.config?.unit_system?.temperature || '°C';
  const degrees = ['°C','°F'].includes(temperatureUnit);
  const temperature = (value, digits = 1) => `${format(value,digits)}${degrees ? '°' : ' '+escape(temperatureUnit)}`;
  const current = numeric(a.temperature), condition = weatherCondition(entity.state, hass?.states?.['sun.sun']?.state);
  const hourly = forecasts?.hourly?.status === 'ready' ? forecasts.hourly.forecast
    .filter(row => Date.parse(row.datetime) >= now - 3600000 && Date.parse(row.datetime) < now + 48*3600000).slice(0,48) : [];
  const daily = forecasts?.daily?.status === 'ready' ? forecasts.daily.forecast
    .filter(row => date.day(row.datetime) >= todayKey).filter((row,index,rows) => rows.findIndex(other => date.day(other.datetime) === date.day(row.datetime)) === index).slice(0,10) : [];
  const today = daily.find(row => date.day(row.datetime) === todayKey);
  const high = numeric(today?.temperature), low = numeric(today?.templow);
  const dailyRange = [high === null ? '' : `H ${temperature(high)}`, low === null ? '' : `T ${temperature(low)}`].filter(Boolean).join(' · ');
  let html = `<section class="weather-current" aria-label="Aktuelles Wetter">
    <div class="weather-current-top"><div class="weather-current-temperature">${current === null ? '—' : temperature(current)}${degrees && current !== null ? `<span class="weather-unit">${escape(temperatureUnit.slice(1))}</span>` : ''}</div><span class="weather-current-icon" aria-label="${escape(condition.label)}">${icon(condition.icon)}</span></div>
    <p class="weather-condition">${escape(condition.label)}</p>${dailyRange ? `<p class="weather-range">${dailyRange}</p>` : ''}</section>`;

  if (hourly.length) {
    const continuous = hourly.every((row,index) => !index || Date.parse(row.datetime)-Date.parse(hourly[index-1].datetime) === 3600000);
    html += `<section class="weather-section" id="weather-hourly" aria-labelledby="weather-hourly-title">${heading('weather-hourly-title','Stündlich',continuous ? hourly.length+(hourly.length === 1 ? ' Stunde' : ' Stunden') : '')}
      <div class="weather-hours" tabindex="0" role="region" aria-label="Stundenprognose, seitlich scrollbar">${hourly.map((row,index) => {
        const label = date.day(row.datetime) !== date.day(hourly[index-1]?.datetime || now) ? `${date.weekday(row.datetime)} · ${date.hour(row.datetime)}` : `${date.hour(row.datetime)} Uhr`;
        const state = weatherCondition(row.condition, row.is_daytime === false ? 'below_horizon' : undefined);
        const value = numeric(row.temperature);
        return `<div class="weather-hour" id="weather-hour-${Date.parse(row.datetime)}" aria-label="${escape(date.full(row.datetime)+', '+state.label+(value === null ? '' : ', '+format(value)+' '+temperatureUnit))}"><time datetime="${escape(row.datetime)}">${label}</time>${icon(state.icon)}<span>${value === null ? '—' : temperature(value,0)}</span></div>`;
      }).join('')}</div></section>`;
  } else html += pendingForecast('weather-hourly','Stündlich',forecasts?.hourly);

  if (daily.length) {
    const allLow = daily.map(row => numeric(row.templow)).filter(value => value !== null);
    const allHigh = daily.map(row => numeric(row.temperature)).filter(value => value !== null);
    const minimum = Math.min(...allLow,...allHigh), maximum = Math.max(...allLow,...allHigh);
    const span = maximum - minimum || 1;
    html += `<section class="weather-section" id="weather-daily" aria-labelledby="weather-daily-title">${heading('weather-daily-title',daily.length > 1 ? daily.length+'-Tage-Vorhersage' : 'Tagesvorhersage')}
      <div class="weather-days">${daily.map(row => {
        const lo = numeric(row.templow), hi = numeric(row.temperature);
        const state = weatherCondition(row.condition);
        const range = lo !== null && hi !== null && hi >= lo;
        const left = range ? (lo-minimum)/span*100 : 0, width = range ? (hi-lo)/span*100 : 0;
        return `<div class="weather-day" id="weather-day-${date.day(row.datetime)}"><span class="weather-day-name">${date.day(row.datetime) === todayKey ? 'Heute' : date.weekday(row.datetime)}</span><span class="weather-day-icon" aria-label="${escape(state.label)}">${icon(state.icon)}</span><span class="weather-low">${lo === null ? '' : temperature(lo)}</span><span class="weather-temperature-track" aria-hidden="true">${range ? `<span style="left:${left}%;width:${width}%;min-width:4px"></span>` : ''}</span><span class="weather-high">${hi === null ? '' : temperature(hi)}</span></div>`;
      }).join('')}</div></section>`;
  } else html += pendingForecast('weather-daily','Tagesvorhersage',forecasts?.daily);

  const metrics = [];
  const add = (key, title, glyph, value, detail = '') => metrics.push(`<div class="weather-metric" data-weather-metric="${key}"><div class="weather-metric-label">${icon(glyph)}<span>${title}</span></div><div class="weather-metric-value">${value}</div>${detail ? `<p>${detail}</p>` : ''}</div>`);
  const wind = valid(a.wind_speed,0), bearing = valid(a.wind_bearing,0,360);
  const windDirection = bearing !== null ? `${['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(bearing/22.5)%16]} · ${format(bearing,0)}°` : typeof a.wind_bearing === 'string' ? escape(a.wind_bearing) : '';
  if (wind !== null) add('wind','Wind','weather-windy',`${format(wind,0)} ${escape(a.wind_speed_unit || '')}`,windDirection);
  const next24 = hourly.filter(row => Date.parse(row.datetime) >= now && Date.parse(row.datetime) < now+86400000);
  const complete24 = next24.length === 24 && next24.every((row,index) => valid(row.precipitation,0) !== null && (!index || Date.parse(row.datetime)-Date.parse(next24[index-1].datetime) === 3600000));
  const rain = complete24 ? next24.reduce((total,row) => total+Number(row.precipitation),0) : valid(today?.precipitation,0);
  if (rain !== null) add('precipitation','Niederschlag','weather-rainy',`${format(rain)} ${escape(a.precipitation_unit || '')}`,complete24 ? 'Nächste 24 Stunden' : 'Heute');
  const humidity = valid(a.humidity,0,100), dew = numeric(a.dew_point);
  if (humidity !== null) add('humidity','Luftfeuchte','humidity',`${format(humidity,0)} %`,dew === null ? '' : `Taupunkt ${temperature(dew)}`);
  else if (dew !== null) add('dew-point','Taupunkt','temperature',temperature(dew));
  const uv = valid(a.uv_index,0);
  if (uv !== null) add('uv','UV-Index','weather-sunny',format(uv),uv < 3 ? 'Niedrig' : uv < 6 ? 'Mäßig' : uv < 8 ? 'Hoch' : uv < 11 ? 'Sehr hoch' : 'Extrem');
  const clouds = valid(a.cloud_coverage,0,100), pressure = valid(a.pressure,0);
  if (clouds !== null) add('clouds','Bewölkung','weather',`${format(clouds,0)} %`);
  if (pressure !== null) add('pressure','Luftdruck','pressure',`${format(pressure,a.pressure_unit === 'inHg' ? 2 : 0)} ${escape(a.pressure_unit || '')}`);
  if (metrics.length) html += `<section class="weather-section" id="weather-metrics" aria-labelledby="weather-metrics-title">${heading('weather-metrics-title','Wetter im Detail')}<div class="weather-metrics">${metrics.join('')}</div></section>`;
  if (typeof a.attribution === 'string' && a.attribution.trim()) html += `<p class="weather-attribution">${escape(a.attribution)}</p>`;
  return html;
}
