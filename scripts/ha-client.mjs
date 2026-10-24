/** Local HA test client. Credentials stay in .local-ha/auth.json (never logged). */
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const authPath = new URL('../.local-ha/auth.json', import.meta.url);
export const baseUrl = 'http://127.0.0.1:8123';

export async function storeAuth(auth) {
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(authPath, 0o600);
}

export async function request(path, { token, body, method = body === undefined ? 'GET' : 'POST', form } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, signal: AbortSignal.timeout(30000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`HA ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

export async function loadAuth() {
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  if (auth.url !== baseUrl) throw new Error('Refusing credentials for a non-local HA instance.');
  if (!auth.access_token || Date.now() > auth.expires_at - 60000) {
    const result = await request('/auth/token', { method: 'POST', form: {
      grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: auth.client_id,
    } });
    Object.assign(auth, result, { expires_at: Date.now() + result.expires_in * 1000 });
    await storeAuth(auth);
  }
  return auth;
}

export class LocalHA {
  constructor(auth) {
    this.auth = auth;
    this.sequence = 0;
    this.pending = new Map();
    this.subscriptions = new Map();
  }

  static async open() {
    const client = new LocalHA(await loadAuth());
    client.socket = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/websocket`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HA websocket auth timeout')), 15000);
      client.socket.addEventListener('error', () => reject(new Error('HA websocket error')));
      client.socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === 'auth_required') client.socket.send(JSON.stringify({ type: 'auth', access_token: client.auth.access_token }));
        else if (message.type === 'auth_ok') { clearTimeout(timer); resolve(); }
        else if (message.type === 'auth_invalid') { clearTimeout(timer); reject(new Error('HA auth rejected')); }
        else if (message.type === 'event') client.subscriptions.get(message.id)?.(message.event);
        else if (message.type === 'result') {
          const pending = client.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer); client.pending.delete(message.id);
            message.success ? pending.resolve(message.result) : pending.reject(new Error(JSON.stringify(message.error)));
          }
        }
      });
    });
    return client;
  }

  call(type, params = {}, listener) {
    const id = ++this.sequence;
    if (listener) this.subscriptions.set(id, listener);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`HA command timeout: ${type}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, type, ...params }));
    });
  }

  api(path, body, method) { return request(path, { token: this.auth.access_token, body, method }); }
  close() { this.socket.close(); }
}
