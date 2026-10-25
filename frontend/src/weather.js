// HA weather conditions: https://www.home-assistant.io/integrations/weather/#condition-mapping
const CONDITIONS = {
  sunny: { label: 'Sonnig', icon: 'weather-sunny' },
  'clear-night': { label: 'Mond', icon: 'weather-clear-night' },
  cloudy: { label: 'Bewölkt', icon: 'weather-partlycloudy' },
  partlycloudy: { label: 'Bewölkt', icon: 'weather-partlycloudy' },
  rainy: { label: 'Regen', icon: 'weather-rainy' },
  pouring: { label: 'Starkregen', icon: 'weather-rainy' },
  lightning: { label: 'Gewitter', icon: 'weather-lightning' },
  'lightning-rainy': { label: 'Gewitter mit Regen', icon: 'weather-storm' },
  windy: { label: 'Windig', icon: 'weather-windy' },
  'windy-variant': { label: 'Windig, bewölkt', icon: 'weather-windy' },
  fog: { label: 'Nebel', icon: 'weather' },
  hail: { label: 'Hagel', icon: 'weather' },
  snowy: { label: 'Schnee', icon: 'weather' },
  'snowy-rainy': { label: 'Schneeregen', icon: 'weather' },
  exceptional: { label: 'Außergewöhnlich', icon: 'weather' },
};

/** Use HA's sun state for cloudy nights, independently of the selected UI theme. */
export function weatherCondition(state, sunState) {
  if ((state === 'cloudy' || state === 'partlycloudy') && sunState === 'below_horizon') {
    return { label: 'Nächtlich bewölkt', icon: 'weather-partlycloudy-night' };
  }
  return Object.hasOwn(CONDITIONS, state) ? CONDITIONS[state] : { label: 'Status unbekannt', icon: 'weather' };
}
