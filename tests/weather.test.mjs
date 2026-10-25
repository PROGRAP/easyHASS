import test from 'node:test';
import assert from 'node:assert/strict';
import { weatherCondition } from '../frontend/src/weather.js';

test('weather status pairs the German label with the matching weather icon', () => {
  const conditions = [
    ['sunny', 'Sonnig', 'weather-sunny'],
    ['clear-night', 'Mond', 'weather-clear-night'],
    ['cloudy', 'Bewölkt', 'weather-partlycloudy'],
    ['partlycloudy', 'Bewölkt', 'weather-partlycloudy'],
    ['rainy', 'Regen', 'weather-rainy'],
    ['pouring', 'Starkregen', 'weather-rainy'],
    ['lightning', 'Gewitter', 'weather-lightning'],
    ['lightning-rainy', 'Gewitter mit Regen', 'weather-storm'],
    ['windy', 'Windig', 'weather-windy'],
    ['windy-variant', 'Windig, bewölkt', 'weather-windy'],
  ];
  for (const [state, label, icon] of conditions) {
    assert.deepEqual(weatherCondition(state, 'above_horizon'), { label, icon }, state);
  }
});

test('cloudy states switch to the moon-and-cloud icon only when the sun is below the horizon', () => {
  for (const state of ['cloudy', 'partlycloudy']) {
    assert.deepEqual(weatherCondition(state, 'below_horizon'), {
      label: 'Nächtlich bewölkt', icon: 'weather-partlycloudy-night',
    }, state);
    for (const sunState of ['above_horizon', 'unknown', 'unavailable', undefined, null]) {
      assert.deepEqual(weatherCondition(state, sunState), {
        label: 'Bewölkt', icon: 'weather-partlycloudy',
      }, `${state} with sun state ${sunState}`);
    }
  }
});

test('an explicit clear-night condition keeps its moon regardless of the separate sun state', () => {
  for (const sunState of ['above_horizon', 'below_horizon', 'unknown', undefined]) {
    assert.deepEqual(weatherCondition('clear-night', sunState), {
      label: 'Mond', icon: 'weather-clear-night',
    });
  }
});

test('nightfall does not replace rain, lightning or wind with a cloudy-night status', () => {
  const conditions = [
    ['rainy', 'Regen', 'weather-rainy'],
    ['pouring', 'Starkregen', 'weather-rainy'],
    ['lightning', 'Gewitter', 'weather-lightning'],
    ['lightning-rainy', 'Gewitter mit Regen', 'weather-storm'],
    ['windy', 'Windig', 'weather-windy'],
    ['windy-variant', 'Windig, bewölkt', 'weather-windy'],
  ];
  for (const [state, label, icon] of conditions) {
    assert.deepEqual(weatherCondition(state, 'below_horizon'), { label, icon }, state);
  }
});

test('known conditions without a dedicated icon retain their status with the neutral weather icon', () => {
  for (const [state, label] of [
    ['fog', 'Nebel'], ['hail', 'Hagel'], ['snowy', 'Schnee'],
    ['snowy-rainy', 'Schneeregen'], ['exceptional', 'Außergewöhnlich'],
  ]) {
    for (const sunState of ['above_horizon', 'below_horizon']) {
      assert.deepEqual(weatherCondition(state, sunState), { label, icon: 'weather' }, state);
    }
  }
});

test('missing, unavailable and unrecognized weather states show a neutral unknown status', () => {
  for (const state of [undefined, null, '', 'unknown', 'unavailable', 'new-provider-condition', '__proto__', 'constructor']) {
    for (const sunState of ['above_horizon', 'below_horizon']) {
      assert.deepEqual(weatherCondition(state, sunState), {
        label: 'Status unbekannt', icon: 'weather',
      }, String(state));
    }
  }
});
