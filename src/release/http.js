// Retries for read-only requests. A release waits on EAS and the stores for up to an hour, so a
// dropped connection mid-wait must not end the run. Only use this for requests that are safe to
// repeat: a retried write could apply twice.

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DELAYS_MS = [5, 10, 20, 40, 60, 60, 60, 60].map((s) => s * 1000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(
  url,
  init,
  { fetchImpl = fetch, wait = sleep, delays = DELAYS_MS, log = console.log } = {},
) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    try {
      const res = await fetchImpl(url, init);
      if (!RETRY_STATUSES.has(res.status)) return res;
      failure = `HTTP ${res.status}`;
      if (attempt >= delays.length) return res;
    } catch (error) {
      if (attempt >= delays.length) throw error;
      failure = error.cause?.code ?? error.message;
    }
    const delay = delays[attempt];
    log(`[release] ${new URL(url).host} request failed (${failure}); retrying in ${delay / 1000}s`);
    await wait(delay);
  }
}

module.exports = { fetchWithRetry, RETRY_STATUSES };
