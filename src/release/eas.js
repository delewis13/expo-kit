// EAS access for `expo-kit release`: the logged-in session (or EXPO_TOKEN in CI), the store
// credentials EAS Submit already uses (fetched per run, held in memory only, never written to
// disk or printed), and the eas-cli build/submit commands.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GRAPHQL_URL = 'https://api.expo.dev/graphql';

function authHeaders() {
  if (process.env.EXPO_TOKEN) return { authorization: `Bearer ${process.env.EXPO_TOKEN}` };
  const statePath = path.join(os.homedir(), '.expo', 'state.json');
  const secret = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8')).auth?.sessionSecret
    : undefined;
  if (!secret) throw new Error('Not logged in to EAS: run `npx eas-cli login` or set EXPO_TOKEN');
  return { 'expo-session': secret };
}

async function graphql(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`EAS GraphQL failed: ${JSON.stringify(body.errors ?? body).slice(0, 500)}`);
  }
  return body.data;
}

const CREDENTIALS_QUERY = `
  query ReleaseCredentials($appId: String!, $packageName: String!) {
    app {
      byId(appId: $appId) {
        iosAppCredentials {
          appleAppIdentifier { bundleIdentifier }
          appStoreConnectApiKeyForSubmissions { keyIdentifier issuerIdentifier keyP8 }
        }
        androidAppCredentials(filter: { applicationIdentifier: $packageName }) {
          googleServiceAccountKeyForSubmissions { keyJson }
        }
      }
    }
  }`;

/**
 * The App Store Connect API key and Google service-account key linked to this app for EAS Submit.
 * Returns `{ asc: { keyId, issuerId, privateKey } | null, play: serviceAccountJson | null }`.
 */
async function fetchStoreCredentials({ projectId, bundleId, packageName }) {
  const data = await graphql(CREDENTIALS_QUERY, { appId: projectId, packageName: packageName ?? '' });
  const ascKey = data.app.byId.iosAppCredentials
    .filter((c) => c.appleAppIdentifier.bundleIdentifier === bundleId)
    .map((c) => c.appStoreConnectApiKeyForSubmissions)
    .find(Boolean);
  const playKey = data.app.byId.androidAppCredentials
    .map((c) => c.googleServiceAccountKeyForSubmissions)
    .find(Boolean);
  return {
    asc: ascKey
      ? { keyId: ascKey.keyIdentifier, issuerId: ascKey.issuerIdentifier, privateKey: ascKey.keyP8 }
      : null,
    play: playKey ? JSON.parse(playKey.keyJson) : null,
  };
}

/** Runs eas-cli; progress streams to the terminal, stdout is returned when `capture` is set. */
function easCli(args, { cwd, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'eas-cli', ...args], {
      cwd,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    let stdout = '';
    if (capture) child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`eas ${args[0]} exited with code ${code}`)),
    );
  });
}

/**
 * Queues builds with `--auto-submit` and returns at once: EAS finishes the builds and uploads
 * them (the same-named submit profile) with no local process attached. Resolves to
 * `{ ios?: buildId, android?: buildId }`.
 */
async function startBuilds(platforms, { cwd, profile }) {
  const platform = platforms.length === 2 ? 'all' : platforms[0];
  const out = await easCli(
    ['build', '--profile', profile, '--platform', platform, '--auto-submit', '--no-wait', '--non-interactive', '--json'],
    { cwd, capture: true },
  );
  const ids = {};
  for (const build of JSON.parse(out)) ids[build.platform.toLowerCase()] = build.id;
  return ids;
}

const BUILD_FIELDS = `
  id status appVersion appBuildVersion gitCommitHash
  error { message }
  submissions { status error { message } }`;

function toBuild(raw) {
  return {
    id: raw.id,
    status: raw.status,
    appVersion: raw.appVersion,
    buildNumber: raw.appBuildVersion,
    gitCommitHash: raw.gitCommitHash,
    error: raw.error?.message ?? null,
    submissions: raw.submissions.map((s) => ({ status: s.status, error: s.error?.message ?? null })),
  };
}

/** The newest `profile` build of `version` for `platform` ('ios' | 'android'), or null. */
async function findLatestBuild({ projectId, platform, version, profile }) {
  const data = await graphql(
    `query LatestBuild($appId: String!, $platform: AppPlatform!, $version: String!, $profile: String!) {
      app { byId(appId: $appId) {
        builds(filter: { platform: $platform, appVersion: $version, buildProfile: $profile }, offset: 0, limit: 1) {
          ${BUILD_FIELDS}
        }
      } }
    }`,
    { appId: projectId, platform: platform.toUpperCase(), version, profile },
  );
  const [build] = data.app.byId.builds;
  return build ? toBuild(build) : null;
}

async function getBuild(buildId) {
  const data = await graphql(
    `query Build($buildId: ID!) { builds { byId(buildId: $buildId) { ${BUILD_FIELDS} } } }`,
    { buildId },
  );
  return toBuild(data.builds.byId);
}

/** Uploads a finished build now (when its auto-submission is missing or failed). */
function submitBuild(platform, buildId, { cwd, profile }) {
  return easCli(
    ['submit', '--platform', platform, '--profile', profile, '--id', buildId, '--non-interactive', '--wait'],
    { cwd },
  );
}

module.exports = { fetchStoreCredentials, startBuilds, findLatestBuild, getBuild, submitBuild };
