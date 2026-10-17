const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fetchWithRetry } = require('../../src/release/http');

const URL_ = 'https://api.expo.dev/graphql';
const response = (status) => ({ status });
const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

function harness(outcomes) {
  const calls = [];
  const waits = [];
  const logs = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    const next = outcomes[calls.length - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  const options = {
    fetchImpl,
    wait: async (ms) => waits.push(ms),
    delays: [1, 2, 3],
    log: (m) => logs.push(m),
  };
  return { calls, waits, logs, options };
}

describe('fetchWithRetry', () => {
  it('returns the first response when the request succeeds', async () => {
    const h = harness([response(200)]);
    assert.equal((await fetchWithRetry(URL_, { method: 'GET' }, h.options)).status, 200);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.waits, []);
  });

  it('retries a dropped connection and returns the later success', async () => {
    const h = harness([networkError(), networkError(), response(200)]);
    assert.equal((await fetchWithRetry(URL_, {}, h.options)).status, 200);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.waits, [1, 2]);
    assert.match(h.logs[0], /api\.expo\.dev request failed \(ECONNRESET\); retrying/);
  });

  it('retries 429 and 5xx responses', async () => {
    const h = harness([response(503), response(429), response(200)]);
    assert.equal((await fetchWithRetry(URL_, {}, h.options)).status, 200);
    assert.equal(h.calls.length, 3);
  });

  it('does not retry other error responses', async () => {
    const h = harness([response(401)]);
    assert.equal((await fetchWithRetry(URL_, {}, h.options)).status, 401);
    assert.equal(h.calls.length, 1);
  });

  it('rethrows the network error once the retries run out', async () => {
    const h = harness([networkError(), networkError(), networkError(), networkError()]);
    await assert.rejects(fetchWithRetry(URL_, {}, h.options), /fetch failed/);
    assert.equal(h.calls.length, 4);
  });

  it('returns the last retryable response once the retries run out', async () => {
    const h = harness([response(502), response(502), response(502), response(502)]);
    assert.equal((await fetchWithRetry(URL_, {}, h.options)).status, 502);
    assert.equal(h.calls.length, 4);
  });

  it('passes the request through unchanged on every attempt', async () => {
    const init = { method: 'POST', body: '{}' };
    const h = harness([networkError(), response(200)]);
    await fetchWithRetry(URL_, init, h.options);
    assert.deepEqual(h.calls, [[URL_, init], [URL_, init]]);
  });
});
