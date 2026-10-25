// HA API and feature flags:
// https://github.com/home-assistant/frontend/blob/dev/src/data/weather.ts
// https://github.com/home-assistant/core/blob/dev/homeassistant/components/weather/websocket_api.py
const FORECAST_FEATURES = { hourly: 2, daily: 1 };
const NUMERIC_FIELDS = [
  'temperature', 'templow', 'apparent_temperature', 'dew_point', 'pressure',
  'precipitation', 'precipitation_probability', 'humidity', 'cloud_coverage',
  'uv_index', 'wind_speed', 'wind_gust_speed',
];
const PERCENT_FIELDS = new Set(['precipitation_probability', 'humidity', 'cloud_coverage']);
const NONNEGATIVE_FIELDS = new Set(['pressure', 'precipitation', 'uv_index', 'wind_speed', 'wind_gust_speed']);
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const COMPASS_POINTS = new Set(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);

function numeric(value) {
  if (typeof value === 'string') {
    value = value.trim();
    if (!NUMBER_PATTERN.test(value)) return undefined;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function forecastDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  // Date.parse accepts impossible dates such as February 30 by rolling forward.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Keep real, dated rows; omitted readings stay absent while a measured zero survives. */
export function normalizeForecast(rows) {
  if (!Array.isArray(rows)) return [];
  const normalized = rows.flatMap(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const datetime = forecastDate(row.datetime);
    if (!datetime) return [];
    const result = { datetime };
    if (typeof row.condition === 'string' && row.condition.trim()) result.condition = row.condition.trim();
    if (typeof row.is_daytime === 'boolean') result.is_daytime = row.is_daytime;
    for (const key of NUMERIC_FIELDS) {
      const value = numeric(row[key]);
      if (value === undefined || (PERCENT_FIELDS.has(key) && (value < 0 || value > 100))
        || (NONNEGATIVE_FIELDS.has(key) && value < 0)) continue;
      result[key] = value;
    }
    const bearing = numeric(row.wind_bearing);
    if (bearing !== undefined && bearing >= 0 && bearing <= 360) result.wind_bearing = bearing;
    else if (typeof row.wind_bearing === 'string' && COMPASS_POINTS.has(row.wind_bearing.trim().toUpperCase())) {
      result.wind_bearing = row.wind_bearing.trim().toUpperCase();
    }
    return [result];
  });
  // The last reading for one instant wins, even when offsets spell it differently.
  // This avoids duplicate hourly controls and double-counted precipitation.
  return [...new Map(normalized.map(row => [row.datetime, row])).values()]
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
}

function release(unsubscribe) {
  if (typeof unsubscribe === 'function') Promise.resolve().then(unsubscribe).catch(() => {});
}

/**
 * Subscribe independently to the entity's supported forecast types.
 * The synchronous return value disposes pending as well as established subscriptions.
 * This owner handles ready itself, so HA's automatic resubscription is disabled.
 * A replacement HA connection/entity should be disposed and started by the caller.
 */
export function subscribeWeatherForecasts(hass, entityId, onChange) {
  const connection = hass?.connection;
  let active = true, generation = 0, state;
  const subscriptions = new Set();
  const publish = () => onChange(state);
  const invalidate = () => {
    generation++;
    for (const unsubscribe of subscriptions) release(unsubscribe);
    subscriptions.clear();
  };
  const update = (type, status, forecast = []) => {
    state = { ...state, [type]: { status, forecast } };
    publish();
  };
  const start = (initial = false) => {
    if (!active) return;
    invalidate();
    const current = generation;
    const features = numeric(hass?.states?.[entityId]?.attributes?.supported_features);
    const supported = Number.isInteger(features) && features >= 0 ? features : 0;
    const unavailable = typeof connection?.subscribeMessage !== 'function'
      || connection.connected === false || (initial && hass?.connected === false);
    state = Object.fromEntries(Object.entries(FORECAST_FEATURES).map(([type, flag]) => [type, {
      status: (supported & flag) === 0 ? 'unsupported' : unavailable ? 'error' : 'loading', forecast: [],
    }]));
    publish();
    for (const type of Object.keys(FORECAST_FEATURES)) {
      if (state[type].status !== 'loading') continue;
      const receive = event => {
        if (!active || current !== generation) return;
        if (event?.type !== type || (event.forecast !== null && !Array.isArray(event.forecast))) {
          update(type, 'error');
          return;
        }
        update(type, 'ready', normalizeForecast(event.forecast));
      };
      Promise.resolve().then(() => {
        if (!active || current !== generation) return undefined;
        return connection.subscribeMessage(receive, {
          type: 'weather/subscribe_forecast', entity_id: entityId, forecast_type: type,
        }, { resubscribe: false });
      }).then(unsubscribe => {
        if (!active || current !== generation) release(unsubscribe);
        else if (typeof unsubscribe === 'function') subscriptions.add(unsubscribe);
      }).catch(error => {
        if (active && current === generation) update(type, error?.code === 'forecast_not_supported' ? 'unsupported' : 'error');
      });
    }
  };
  const ready = () => start();
  const disconnected = () => {
    if (!active) return;
    invalidate();
    state = Object.fromEntries(Object.entries(state).map(([type, value]) => [type, {
      status: value.status === 'unsupported' ? 'unsupported' : 'error', forecast: [],
    }]));
    publish();
  };
  connection?.addEventListener?.('ready', ready);
  connection?.addEventListener?.('disconnected', disconnected);
  start(true);
  return () => {
    if (!active) return;
    active = false;
    invalidate();
    connection?.removeEventListener?.('ready', ready);
    connection?.removeEventListener?.('disconnected', disconnected);
  };
}
