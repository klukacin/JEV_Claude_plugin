// test/helpers/mock-backend.mjs — a local stand-in for api.typesafe.ai.
import http from 'node:http';

export function defaultAnswers(id, question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria || {});
    const probabilities = {};
    keys.forEach((k, i) => { probabilities[k] = keys.length === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (keys.length - 1); });
    return { type: 'choice', choice: keys[0], probabilities, confidence: 0.9 };
  }
  const levels = question.criteria || [];
  const probabilities = {};
  const legend = {};
  levels.forEach((c, i) => { probabilities[String(i)] = i === 0 ? 1 : 0; legend[String(i)] = c; });
  return { type: 'score', score: 0, probabilities, legend, confidence: 0.95 };
}

export async function startMockBackend({ answers = null } = {}) {
  const requests = [];
  const queued = [];
  let answerSource = answers;

  const answerFor = (id, question, state) => {
    if (typeof answerSource === 'function') return answerSource(id, question, state) ?? defaultAnswers(id, question);
    if (answerSource && typeof answerSource === 'object' && answerSource[id]) return answerSource[id];
    return defaultAnswers(id, question);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { invalid: raw }; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const override = queued.shift();
      if (override) return send(override.status, override.body);
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { models: [{ name: 'jev-1.13.0', description: 'flagship' }, { name: 'jev-latest', description: 'alias' }] });
      }
      if (req.method === 'POST' && req.url === '/v1/systemone') {
        if (!body || !body.questions || typeof body.questions !== 'object') return send(422, { error: 'questions required' });
        if (JSON.stringify(body.state ?? '').includes('__FAIL__')) return send(422, { error: 'simulated validation failure' });
        const out = {};
        for (const [id, q] of Object.entries(body.questions)) out[id] = answerFor(id, q, body.state);
        return send(200, { model: body.model || 'jev-latest', answers: out, usage: { input_tokens: 10, output_tokens: 1 } });
      }
      return send(404, { error: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    setAnswers(next) { answerSource = next; },
    queue(status, body) { queued.push({ status, body }); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
