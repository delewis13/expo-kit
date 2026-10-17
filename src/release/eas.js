// EAS access for `expo-kit release`: the logged-in session (or EXPO_TOKEN in CI), the store
// credentials EAS Submit already uses (fetched per run, held in memory only, never written to
// disk or printed), the eas-cli build/submit/workflow commands, and the builds and workflow runs
// they create.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { fetchWithRetry } = require('./http');

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

// Every query here is read-only, so all of them can be retried.
async function graphql(query, variables) {
  const res = await fetchWithRetry(GRAPHQL_URL, {
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

/**
 * Starts the release workflow on EAS from `ref` (a full commit SHA) without uploading anything:
 * EAS checks the commit out from the linked GitHub repo. Resolves to `{ id, url }` of the run.
 */
async function startWorkflowRun(file, { cwd, ref, platform }) {
  const out = await easCli(
    ['workflow:run', file, '--ref', ref, '-F', `platform=${platform}`, '--no-wait', '--non-interactive', '--json'],
    { cwd, capture: true },
  );
  const { id, url } = JSON.parse(out);
  return { id, url };
}

const WORKFLOW_ACTIVE = new Set(['NEW', 'IN_PROGRESS', 'WAITING', 'ACTION_REQUIRED']);
const JOB_PENDING = new Set(['NEW', 'IN_PROGRESS', 'ACTION_REQUIRED']);

/** A workflow run with its jobs; a build job's `buildId` is set once EAS has created its build. */
async function getWorkflowRun(runId) {
  const data = await graphql(
    `query ReleaseWorkflowRun($runId: ID!) { workflowRuns { byId(workflowRunId: $runId) {
      id status gitCommitHash
      errors { title message }
      workflow { app { name ownerAccount { name } } }
      jobs { key type status turtleBuild { id platform } }
    } } }`,
    { runId },
  );
  const raw = data.workflowRuns.byId;
  const { app } = raw.workflow;
  return {
    id: raw.id,
    status: raw.status,
    gitCommitHash: raw.gitCommitHash,
    url: `https://expo.dev/accounts/${encodeURIComponent(app.ownerAccount.name)}/projects/${encodeURIComponent(app.name)}/workflows/${raw.id}`,
    errors: raw.errors.map((e) => e.message || e.title),
    jobs: raw.jobs.map((j) => ({
      key: j.key,
      type: j.type,
      status: j.status,
      buildId: j.turtleBuild?.id ?? null,
      platform: j.turtleBuild?.platform?.toLowerCase() ?? null,
    })),
  };
}

/**
 * Where a run stands for `platforms`: `ids` maps each platform whose build EAS has created to its
 * build id, `skipped` lists platforms whose build job (`build_<platform>`) won't run.
 */
function workflowBuilds(run, platforms) {
  const ids = {};
  const skipped = [];
  for (const platform of platforms) {
    const job =
      run.jobs.find((j) => j.type === 'BUILD' && j.platform === platform && j.buildId) ??
      run.jobs.find((j) => j.key === `build_${platform}`);
    if (job?.buildId) ids[platform] = job.buildId;
    else if (job && ['SKIPPED', 'CANCELED', 'FAILURE'].includes(job.status)) skipped.push(platform);
  }
  return { ids, skipped, done: !WORKFLOW_ACTIVE.has(run.status) };
}

/** The newest run (of `runs`, newest first) still going at `commit`, or null. */
const activeRunAt = (runs, commit) => runs.find((r) => r.gitCommitHash === commit && WORKFLOW_ACTIVE.has(r.status)) ?? null;

/**
 * A run of the workflow file `fileName` still going at `commit`, so a re-run (say after Ctrl+C
 * before its builds were created) follows it instead of starting a second one. Null when none.
 */
async function findActiveWorkflowRun({ projectId, fileName, commit }) {
  let data;
  try {
    data = await graphql(
      `query ReleaseWorkflowRuns($appId: ID!, $fileName: String!) { workflows {
        byAppIdAndFileName(appId: $appId, fileName: $fileName) {
          runs: runsPaginated(first: 20) { edges { node { id status gitCommitHash } } }
        }
      } }`,
      { appId: projectId, fileName },
    );
  } catch {
    return null; // the workflow has never run
  }
  const runs = data.workflows.byAppIdAndFileName.runs.edges.map((e) => e.node);
  return activeRunAt(runs, commit);
}

/** The GitHub repo the EAS project is connected to (`{ owner, name }`), or null. */
async function linkedGitHubRepo(projectId) {
  const data = await graphql(
    `query ReleaseGitHubRepo($appId: String!) { app { byId(appId: $appId) {
      githubRepository { metadata { githubRepoOwnerName githubRepoName } }
    } } }`,
    { appId: projectId },
  );
  const meta = data.app.byId.githubRepository?.metadata;
  return meta ? { owner: meta.githubRepoOwnerName, name: meta.githubRepoName } : null;
}

const BUILD_FIELDS = `
  id status appVersion appBuildVersion gitCommitHash
  error { message }
  submissions { status error { message } }`;

const WORKFLOW_JOB_FIELDS = `
  workflowJob { key workflowRun { jobs { key type status requiredJobKeys } } }`;

/**
 * Whether the workflow that made a build (`raw.workflowJob`) still has a submit job for it that
 * hasn't finished, so nothing should upload the build in the meantime.
 */
function workflowUploadPending(workflowJob) {
  if (!workflowJob) return false;
  return workflowJob.workflowRun.jobs.some(
    (j) => j.type === 'SUBMISSION' && j.requiredJobKeys.includes(workflowJob.key) && JOB_PENDING.has(j.status),
  );
}

function toBuild(raw) {
  const build = {
    id: raw.id,
    status: raw.status,
    appVersion: raw.appVersion,
    buildNumber: raw.appBuildVersion,
    gitCommitHash: raw.gitCommitHash,
    error: raw.error?.message ?? null,
    submissions: raw.submissions.map((s) => ({ status: s.status, error: s.error?.message ?? null })),
  };
  if ('workflowJob' in raw) build.workflowUploadPending = workflowUploadPending(raw.workflowJob);
  return build;
}

/** The newest build of `builds` (newest first) for `version`, made from `gitCommitHash` if given. */
function pickBuild(builds, { version, gitCommitHash }) {
  return (
    builds.find((b) => b.appVersion === version && (gitCommitHash === undefined || b.gitCommitHash === gitCommitHash)) ??
    null
  );
}

/**
 * The newest `profile` build of `version` for `platform` ('ios' | 'android'), or null. With
 * `gitCommitHash`, only a build of that exact commit counts, so an older build of the same version
 * is never reused.
 */
async function findLatestBuild({ projectId, platform, version, profile, gitCommitHash }) {
  const byCommit = gitCommitHash !== undefined;
  const data = await graphql(
    `query LatestBuild($appId: String!, $platform: AppPlatform!, $version: String!, $profile: String!${byCommit ? ', $commit: String!' : ''}) {
      app { byId(appId: $appId) {
        builds(filter: { platform: $platform, appVersion: $version, buildProfile: $profile${byCommit ? ', gitCommitHash: $commit' : ''} }, offset: 0, limit: ${byCommit ? 10 : 1}) {
          ${BUILD_FIELDS}
        }
      } }
    }`,
    { appId: projectId, platform: platform.toUpperCase(), version, profile, ...(byCommit && { commit: gitCommitHash }) },
  );
  return pickBuild(data.app.byId.builds.map(toBuild), { version, gitCommitHash });
}

/** A build; `{ workflow: true }` adds `workflowUploadPending` for builds made by a workflow. */
async function getBuild(buildId, { workflow = false } = {}) {
  const data = await graphql(
    `query Build($buildId: ID!) { builds { byId(buildId: $buildId) { ${BUILD_FIELDS}${workflow ? WORKFLOW_JOB_FIELDS : ''} } } }`,
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

module.exports = {
  fetchStoreCredentials,
  startBuilds,
  startWorkflowRun,
  getWorkflowRun,
  workflowBuilds,
  activeRunAt,
  findActiveWorkflowRun,
  linkedGitHubRepo,
  workflowUploadPending,
  pickBuild,
  findLatestBuild,
  getBuild,
  submitBuild,
};
