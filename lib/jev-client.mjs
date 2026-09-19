// lib/jev-client.mjs — the only module that talks to api.typesafe.ai.
import { setTimeout as sleep } from 'node:timers/promises';

export class JevError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export function redact(text, key) {
  if (!key || text === null || text === undefined) return text;
  return String(text).split(key).join('***');
}

const RETRY_STATUSES = new Set([429, 529]);

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  return 'http';
}

export function createClient({
  apiKey,
  baseUrl = 'https://api.typesafe.ai',
  model = 'jev-latest',
  fetchImpl = globalThis.fetch,
  backoffMs = [300, 900],
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, pathname, body, { timeoutMs = 20000, retries = 2 } = {}) {
    if (!apiKey) {
      throw new JevError('no_key', 'No TypeSafe API key. Get one at https://console.typesafe.ai/keys and set TYPESAFE_API_KEY (run: node scripts/set-key.mjs).');
    }
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    const canRetry = () => {
      const wait = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      return attempt < retries && Date.now() + wait + 50 < deadline;
    };
    const backoff = async () => {
      const wait = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      attempt += 1;
      if (wait > 0) await sleep(wait);
    };

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JevError('timeout', `Jev request timed out after ${timeoutMs} ms`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let res;
      try {
        res = await fetchImpl(root + pathname, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') throw new JevError('timeout', `Jev request timed out after ${timeoutMs} ms`, { cause: err });
        if (canRetry()) { await backoff(); continue; }
        throw new JevError('network', redact(`Could not reach Jev: ${err?.message || err}`, apiKey), { cause: err });
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new JevError('bad_response', 'Jev returned a non-JSON body', { status: res.status, cause: err });
        }
      }
      if ((RETRY_STATUSES.has(res.status) || res.status >= 500) && canRetry()) { await backoff(); continue; }
      throw new JevError(codeForStatus(res.status), redact(`Jev API error ${res.status}: ${text.slice(0, 300)}`, apiKey), { status: res.status });
    }
  }

  return {
    async systemOne({ state, questions, model: modelOverride } = {}, opts) {
      const data = await request('POST', '/v1/systemone', { model: modelOverride || model, state, questions }, opts);
      if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
        throw new JevError('bad_response', 'Jev response has no answers object');
      }
      return data;
    },
    async listModels(opts = {}) {
      return request('GET', '/v1/models', undefined, { retries: 1, ...opts });
    },
  };
}
