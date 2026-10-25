import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForecast, subscribeWeatherForecasts } from '../frontend/src/weather-data.js';

const date = hour => `2026-10-25T${String(hour).padStart(2, '0')}:00:00Z`;
const row = (hour, extra = {}) => ({ datetime: date(hour), temperature: hour, ...extra });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture(features = 3) {
  const calls = [], listeners = new Map(), snapshots = [], released = [];
  const connection = {
    connected: true,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => {
      assert.equal(listeners.get(type), callback);
      listeners.delete(type);
    },
    subscribeMessage: (callback, message, options) => {
      const pending = deferred();
      const call = { callback, message, options, ...pending };
      calls.push(call);
      return pending.promise;
    },
  };
  const hass = { connected: true, connection, states: { 'weather.home': { attributes: { supported_features: features } } } };
  const start = () => subscribeWeatherForecasts(hass, 'weather.home', state => snapshots.push(state));
  const finish = (index, fail = false) => calls[index].resolve(() => {
    released.push(index);
    if (fail) return Promise.reject(new Error('Socket closed'));
  });
  return { hass, connection, calls, listeners, snapshots, released, start, finish };
}

test('forecast normalization sorts actual dated rows and never mutates or fills source data', () => {
  const input = [row(13, { precipitation: 0 }), row(11, { temperature: undefined }), row(12)];
  const before = structuredClone(input);
  const output = normalizeForecast(input);
  assert.deepEqual(output.map(item => item.datetime), [11, 12, 13].map(hour => new Date(date(hour)).toISOString()));
  assert.equal(Object.hasOwn(output[0], 'temperature'), false);
  assert.equal(output[2].precipitation, 0);
  assert.deepEqual(input, before);
  assert.notEqual(output[0], input[1]);
  assert.equal(output.length, 3);
});

test('missing, non-finite and out-of-range readings stay absent while valid zero and negative temperatures survive', () => {
  const [output] = normalizeForecast([row(12, {
    temperature: '-4.5', templow: -8, apparent_temperature: 0, dew_point: '-10',
    precipitation: '0', precipitation_probability: 0, humidity: '100', cloud_coverage: 0,
    uv_index: 0, wind_speed: 0, wind_gust_speed: '2.5', pressure: '1004.2', wind_bearing: '249.1',
    condition: ' rainy ', is_daytime: false,
  })]);
  assert.deepEqual(output, {
    datetime: new Date(date(12)).toISOString(), condition: 'rainy', is_daytime: false,
    temperature: -4.5, templow: -8, apparent_temperature: 0, dew_point: -10,
    pressure: 1004.2, precipitation: 0, precipitation_probability: 0, humidity: 100,
    cloud_coverage: 0, uv_index: 0, wind_speed: 0, wind_gust_speed: 2.5, wind_bearing: 249.1,
  });
  for (const missing of [null, undefined, '', '  ', false, true, NaN, Infinity, -Infinity, 'NaN', 'Infinity', [], {}, '0x10']) {
    const [value] = normalizeForecast([row(12, { temperature: missing, precipitation: missing })]);
    assert.equal(Object.hasOwn(value, 'temperature'), false, String(missing));
    assert.equal(Object.hasOwn(value, 'precipitation'), false, String(missing));
  }
  const [invalid] = normalizeForecast([row(12, {
    humidity: 101, cloud_coverage: -1, precipitation_probability: 110, precipitation: -0.1,
    wind_speed: -1, wind_gust_speed: -2, pressure: -1, uv_index: -1, wind_bearing: 361,
  })]);
  assert.deepEqual(invalid, { datetime: new Date(date(12)).toISOString(), temperature: 12 });
  assert.equal(normalizeForecast([row(12, { wind_bearing: 'wsw' })])[0].wind_bearing, 'WSW');
});

test('invalid dates and malformed entries are discarded, including impossible calendar dates and local-only times', () => {
  const invalid = [null, undefined, {}, [], 12, '2026-10-25',
    ...['', 'wrong', '2026-02-30T12:00:00Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z',
      '2026-10-25T24:00:00Z', '2026-10-25T12:00:00', '2026-10-25'].map(datetime => ({ datetime }))];
  assert.deepEqual(normalizeForecast(invalid), []);
  assert.deepEqual(normalizeForecast(null), []);
  assert.deepEqual(normalizeForecast({ forecast: [row(12)] }), []);
  assert.equal(normalizeForecast([{ datetime: '2026-10-25T14:00:00+02:00' }])[0].datetime, '2026-10-25T12:00:00.000Z');
});

test('subscribes only supported forecast types with the official WS shape and publishes independent snapshots', async () => {
  const f = fixture(), dispose = f.start();
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(f.snapshots[0], { hourly: { status: 'loading', forecast: [] }, daily: { status: 'loading', forecast: [] } });
  await flush();
  assert.deepEqual(f.calls.map(call => [call.message, call.options]), ['hourly', 'daily'].map(forecast_type => [
    { type: 'weather/subscribe_forecast', entity_id: 'weather.home', forecast_type }, { resubscribe: false },
  ]));
  f.calls[0].callback({ type: 'hourly', forecast: [row(13), row(12)] });
  assert.equal(f.snapshots.at(-1).daily.status, 'loading');
  f.calls[1].callback({ type: 'daily', forecast: [row(12, { templow: 5 })] });
  assert.equal(f.snapshots.at(-1).hourly.forecast.length, 2);
  assert.equal(f.snapshots.at(-1).daily.forecast[0].templow, 5);
  assert.equal(f.snapshots[0].hourly.status, 'loading', 'old snapshots do not change');
  f.finish(0); f.finish(1); await flush();
  dispose(); await flush();
  assert.deepEqual(f.released, [0, 1]);
});

test('unsupported features never request forecasts or synthesize rows, including twice-daily-only entities', async () => {
  for (const features of [0, 4, undefined, null, -1, 1.5]) {
    const f = fixture(features);
    if (features === undefined) delete f.hass.states['weather.home'].attributes.supported_features;
    const dispose = f.start();
    await flush();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.snapshots[0], { hourly: { status: 'unsupported', forecast: [] }, daily: { status: 'unsupported', forecast: [] } });
    dispose();
  }
  for (const [features, type] of [[1, 'daily'], [2, 'hourly']]) {
    const f = fixture(features), dispose = f.start();
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].message.forecast_type, type);
    dispose(); f.finish(0); await flush();
  }
});

test('one failed subscription leaves the other usable and unsupported server responses remain distinct', async () => {
  const f = fixture(), dispose = f.start();
  await flush();
  f.calls[0].reject(new Error('Provider unavailable'));
  f.calls[1].callback({ type: 'daily', forecast: [row(12)] }); f.finish(1);
  await flush();
  assert.equal(f.snapshots.at(-1).hourly.status, 'error');
  assert.equal(f.snapshots.at(-1).daily.status, 'ready');
  assert.equal(f.snapshots.at(-1).daily.forecast.length, 1);
  f.listeners.get('ready')(); await flush();
  f.calls[2].reject({ code: 'forecast_not_supported' }); f.finish(3);
  await flush();
  assert.equal(f.snapshots.at(-1).hourly.status, 'unsupported');
  assert.equal(f.snapshots.at(-1).daily.status, 'loading');
  dispose(); await flush();
});

test('empty/null forecast pushes clear old rows and malformed events report error without poisoning the other type', async () => {
  const f = fixture(), dispose = f.start(); await flush();
  f.finish(0); f.finish(1); await flush();
  f.calls[0].callback({ type: 'hourly', forecast: [row(12)] });
  f.calls[1].callback({ type: 'daily', forecast: [row(12)] });
  for (const forecast of [[], null]) {
    f.calls[0].callback({ type: 'hourly', forecast });
    assert.deepEqual(f.snapshots.at(-1).hourly, { status: 'ready', forecast: [] });
  }
  for (const event of [null, {}, { type: 'daily', forecast: [] }, { type: 'hourly', forecast: {} }]) {
    f.calls[0].callback(event);
    assert.deepEqual(f.snapshots.at(-1).hourly, { status: 'error', forecast: [] });
    assert.equal(f.snapshots.at(-1).daily.status, 'ready');
  }
  f.calls[0].callback({ type: 'hourly', forecast: [row(13)] });
  assert.equal(f.snapshots.at(-1).hourly.status, 'ready', 'a later valid push recovers');
  dispose(); await flush();
});

test('immediate disposal cancels setup and delayed unsubscriptions are released exactly once', async () => {
  const immediate = fixture(), stopImmediate = immediate.start();
  stopImmediate(); stopImmediate(); await flush();
  assert.equal(immediate.calls.length, 0);
  assert.equal(immediate.listeners.size, 0);
  const f = fixture(), dispose = f.start(); await flush();
  const before = f.snapshots.length;
  dispose(); dispose();
  f.calls[0].callback({ type: 'hourly', forecast: [row(12)] });
  f.finish(0, true); f.calls[1].reject(new Error('Late failure')); await flush();
  assert.equal(f.snapshots.length, before);
  assert.deepEqual(f.released, [0]);
  assert.equal(f.listeners.size, 0);
});

test('ready replaces the generation, silences old events/errors and releases late old handles', async () => {
  const f = fixture(), dispose = f.start(); await flush();
  f.finish(0); await flush();
  f.calls[0].callback({ type: 'hourly', forecast: [row(12)] });
  f.listeners.get('ready')(); await flush();
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.released, [0]);
  f.calls[2].callback({ type: 'hourly', forecast: [row(14)] });
  f.calls[3].callback({ type: 'daily', forecast: [row(15)] });
  f.finish(2); f.finish(3); await flush();
  const before = f.snapshots.length;
  f.calls[0].callback({ type: 'hourly', forecast: [row(10)] });
  f.calls[1].callback({ type: 'daily', forecast: [row(10)] });
  f.finish(1); await flush();
  assert.equal(f.snapshots.length, before);
  assert.deepEqual(f.released, [0, 1]);
  assert.equal(f.snapshots.at(-1).hourly.forecast[0].temperature, 14);
  dispose(); await flush();
  assert.deepEqual(f.released, [0, 1, 2, 3]);
});

test('disconnect clears stale readings and ready retries failed subscriptions with refreshed supported features', async () => {
  const f = fixture(), dispose = f.start(); await flush();
  f.calls[0].callback({ type: 'hourly', forecast: [row(12)] }); f.finish(0);
  f.calls[1].reject(new Error('Temporary failure')); await flush();
  f.connection.connected = false;
  f.listeners.get('disconnected')();
  assert.deepEqual(f.snapshots.at(-1), { hourly: { status: 'error', forecast: [] }, daily: { status: 'error', forecast: [] } });
  f.hass.states['weather.home'].attributes.supported_features = 1;
  f.connection.connected = true;
  f.listeners.get('ready')(); await flush();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].message.forecast_type, 'daily');
  assert.equal(f.snapshots.at(-1).hourly.status, 'unsupported');
  f.calls[2].callback({ type: 'daily', forecast: [row(14)] }); f.finish(2); await flush();
  assert.equal(f.snapshots.at(-1).daily.status, 'ready');
  dispose(); await flush();
});

test('a rejected setup from the previous connection generation cannot overwrite a fresh forecast', async () => {
  const f = fixture(), dispose = f.start(); await flush();
  f.listeners.get('ready')(); await flush();
  f.calls[2].callback({ type: 'hourly', forecast: [row(14)] });
  f.calls[3].callback({ type: 'daily', forecast: [row(15)] });
  f.finish(2); f.finish(3); await flush();
  const before = f.snapshots.length;
  f.calls[0].reject(new Error('Old socket closed'));
  f.calls[1].reject({ code: 'forecast_not_supported' });
  await flush();
  assert.equal(f.snapshots.length, before);
  assert.equal(f.snapshots.at(-1).hourly.status, 'ready');
  assert.equal(f.snapshots.at(-1).daily.status, 'ready');
  dispose(); await flush();
});

test('missing or offline connections report only supported types as errors without issuing requests', async () => {
  for (const kind of ['missing', 'offline']) {
    const f = fixture(2);
    if (kind === 'missing') delete f.hass.connection;
    else f.hass.connected = false;
    const dispose = f.start(); await flush();
    assert.deepEqual(f.snapshots[0], { hourly: { status: 'error', forecast: [] }, daily: { status: 'unsupported', forecast: [] } });
    assert.equal(f.calls.length, 0);
    dispose();
  }
});
