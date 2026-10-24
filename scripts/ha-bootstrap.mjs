/** Set up only the new local test instance through HA's actual HTTP/WS APIs. */
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root, baseUrl, request, storeAuth, LocalHA } from './ha-client.mjs';

const container = JSON.parse(execFileSync('docker', ['inspect', 'easy-hass-local'], { encoding: 'utf8' }))[0];
if (container.Config.Labels?.['ai.easy-hass.project'] !== root.replace(/\/$/, '') || !container.State.Running) {
  throw new Error('Refusing to bootstrap anything except this repository’s running local test container.');
}

// HA stops registering the onboarding API after setup is complete and restarted.
const onboardingResponse = await fetch(`${baseUrl}/api/onboarding`, { signal: AbortSignal.timeout(15000) });
if (!onboardingResponse.ok && onboardingResponse.status !== 404) throw new Error(`Onboarding status: ${onboardingResponse.status}`);
const steps = onboardingResponse.status === 404
  ? ['user', 'core_config', 'analytics', 'integration'].map(step => ({ step, done: true }))
  : await onboardingResponse.json();
if (!steps.find(({ step }) => step === 'user')?.done) {
  const credentials = {
    url: baseUrl, client_id: `${baseUrl}/`, username: 'easyhasslocal',
    password: randomBytes(24).toString('base64url'),
  };
  // Save before account creation so interrupted onboarding remains recoverable.
  await storeAuth(credentials);
  const user = await request('/api/onboarding/users', { body: {
    name: 'Easy-Hass Test', username: credentials.username, password: credentials.password,
    client_id: credentials.client_id, language: 'de',
  } });
  const tokens = await request('/auth/token', { method: 'POST', form: {
    grant_type: 'authorization_code', code: user.auth_code, client_id: credentials.client_id,
  } });
  await storeAuth({ ...credentials, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 });
}

const ha = await LocalHA.open();
try {
  for (const step of ['core_config', 'analytics', 'integration']) {
    if (!steps.find((item) => item.step === step)?.done) {
      await ha.api(`/api/onboarding/${step}`, step === 'integration' ? {
        client_id: ha.auth.client_id, redirect_uri: `${baseUrl}/?auth_callback=1`,
      } : {});
    }
  }
  const entries = await ha.call('config_entries/get');
  for (const domain of ['easy_hass_fixture', 'easy_hass']) {
    if (!entries.some((entry) => entry.domain === domain)) {
      const flow = await ha.api('/api/config/config_entries/flow', { handler: domain, show_advanced_options: false });
      if (flow.type === 'form') {
        const result = await ha.api(`/api/config/config_entries/flow/${flow.flow_id}`, {});
        if (result.type !== 'create_entry') throw new Error(`${domain} activation did not create an entry: ${result.type}`);
      } else if (flow.type !== 'create_entry') throw new Error(`${domain}: ${flow.type}`);
    }
  }
  // Let platform setup finish, then assign optional local photos to real HA areas.
  for (let retry = 0; retry < 50; retry++) {
    const current = await ha.call('config_entries/get');
    if (['easy_hass_fixture', 'easy_hass'].every((domain) => current.some((entry) => entry.domain === domain && entry.state === 'loaded'))) break;
    if (retry === 49) throw new Error('Test integrations did not load');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const areas = await ha.call('config/area_registry/list');
  for (const [key, name] of [['living', 'Wohnzimmer'], ['kitchen', 'Küche'], ['dining', 'Esstisch'], ['bedroom', 'Schlafzimmer'], ['hall', 'Flur']]) {
    const area = areas.find((item) => item.name === name);
    if (area && await stat(new URL(`../.local-ha/config/www/easy-hass-fixture/${key}.png`, import.meta.url)).catch(() => false)) {
      await ha.call('config/area_registry/update', { area_id: area.area_id, picture: `/local/easy-hass-fixture/${key}.png` });
    }
  }
  const fixtureRegistry = await ha.call('config/entity_registry/list');
  const fixtureDevices = await ha.call('config/device_registry/list');
  for (const entity of fixtureRegistry.filter(({ platform }) => platform === 'easy_hass_fixture')) {
    const device = fixtureDevices.find(({ id }) => id === entity.device_id);
    if (device?.name && entity.name !== device.name) {
      await ha.call('config/entity_registry/update', { entity_id: entity.entity_id, name: device.name });
    }
  }
  const finalEntries = await ha.call('config_entries/get');
  console.log(JSON.stringify({ url: `${baseUrl}/easy-hass`,
    areas: areas.map(({ name }) => name),
    fixtureEntities: fixtureRegistry.filter(({ platform }) => platform === 'easy_hass_fixture').map(({ entity_id }) => entity_id),
    integrations: finalEntries.filter(({ domain }) => domain.startsWith('easy_hass')).map(({ domain, state }) => ({ domain, state })),
    credentials: '.local-ha/auth.json (local, ignored, mode 0600)',
  }, null, 2));
} finally { ha.close(); }
