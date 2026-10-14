// App Store Connect API client for `expo-kit release`: everything between "EAS uploaded the build"
// and "waiting for review" — the version record, What's New, review notes, attaching the build,
// automatic release, and the review submission. Every step reads the current state first, so a
// re-run after a failure (or after a partial manual edit in the console) picks up where it left off.

const crypto = require('crypto');

const API = 'https://api.appstoreconnect.apple.com/v1';

/** Versions App Store Connect still lets us edit and submit (READY_FOR_REVIEW = in an unsent draft). */
const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

const base64url = (input) => Buffer.from(input).toString('base64url');

function makeToken({ keyId, issuerId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

function createClient(credentials) {
  let token = null;
  let tokenAt = 0;
  async function request(method, pathAndQuery, body) {
    if (!token || Date.now() - tokenAt > 10 * 60 * 1000) {
      token = makeToken(credentials);
      tokenAt = Date.now();
    }
    const res = await fetch(`${API}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json();
    if (!res.ok) {
      const detail = (json.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ');
      const error = new Error(`App Store Connect ${method} ${pathAndQuery} → ${res.status} ${detail}`);
      error.status = res.status;
      throw error;
    }
    return json;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, body) => request('POST', p, body),
    patch: (p, body) => request('PATCH', p, body),
  };
}

const versionState = (v) => v.attributes.appVersionState ?? v.attributes.appStoreState;

async function listVersions(asc, appId) {
  const res = await asc.get(
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=10&fields[appStoreVersions]=versionString,appStoreState,appVersionState,releaseType`,
  );
  return res.data;
}

/** The editable App Store version record for `version`: reused, renamed, or created. */
async function ensureVersion(asc, appId, version, log) {
  const versions = await listVersions(asc, appId);
  const existing = versions.find((v) => v.attributes.versionString === version);
  if (existing) {
    log(`App Store version ${version} exists (${versionState(existing)})`);
    return existing;
  }
  const editable = versions.find((v) => EDITABLE_STATES.has(versionState(v)));
  if (editable) {
    log(`Renaming unsubmitted App Store version ${editable.attributes.versionString} → ${version}`);
    const res = await asc.patch(`/appStoreVersions/${editable.id}`, {
      data: { type: 'appStoreVersions', id: editable.id, attributes: { versionString: version } },
    });
    return res.data;
  }
  log(`Creating App Store version ${version}`);
  const res = await asc.post('/appStoreVersions', {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: version, releaseType: 'AFTER_APPROVAL' },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  });
  return res.data;
}

async function setWhatsNew(asc, versionId, whatsNew, log) {
  const res = await asc.get(`/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  if (res.data.length === 0) throw new Error('the App Store version has no localizations to update');
  for (const loc of res.data) {
    if (loc.attributes.whatsNew?.trim() === whatsNew) continue;
    await asc.patch(`/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew } },
    });
  }
  log(`What's New set (${res.data.map((l) => l.attributes.locale).join(', ')})`);
}

async function setReviewNotes(asc, versionId, notes, log) {
  const res = await asc.get(`/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (res.data) {
    await asc.patch(`/appStoreReviewDetails/${res.data.id}`, {
      data: { type: 'appStoreReviewDetails', id: res.data.id, attributes: { notes } },
    });
  } else {
    await asc.post('/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes: { notes },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    });
  }
  log('App Review notes set');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findBuild(asc, appId, version, buildNumber) {
  const res = await asc.get(
    `/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}` +
      `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
      '&filter[preReleaseVersion.platform]=IOS&fields[builds]=version,processingState,usesNonExemptEncryption',
  );
  return res.data[0] ?? null;
}

/** Polls until Apple has processed the uploaded build (usually 5–30 minutes after upload). */
async function waitForBuild(asc, appId, version, buildNumber, log, { timeoutMs = 90 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  for (;;) {
    const build = await findBuild(asc, appId, version, buildNumber);
    const state = build?.attributes.processingState ?? 'NOT_FOUND';
    if (state !== lastState) log(`Build ${version} (${buildNumber}): ${state}`);
    lastState = state;
    if (state === 'VALID') return build;
    if (state === 'FAILED' || state === 'INVALID') {
      throw new Error(`Apple rejected build ${version} (${buildNumber}) during processing: ${state}`);
    }
    if (Date.now() > deadline) throw new Error(`build ${version} (${buildNumber}) still ${state}; re-run later`);
    await sleep(30 * 1000);
  }
}

async function attachBuild(asc, versionId, build, log) {
  if (build.attributes.usesNonExemptEncryption == null) {
    await asc.patch(`/builds/${build.id}`, {
      data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
    });
  }
  await asc.patch(`/appStoreVersions/${versionId}/relationships/build`, {
    data: { type: 'builds', id: build.id },
  });
  await asc.patch(`/appStoreVersions/${versionId}`, {
    data: { type: 'appStoreVersions', id: versionId, attributes: { releaseType: 'AFTER_APPROVAL' } },
  });
  log(`Build ${build.attributes.version} attached, set to release automatically once approved`);
}

async function submitForReview(asc, appId, versionId, log) {
  const open = await asc.get(
    `/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`,
  );
  let submission = open.data[0];
  if (!submission) {
    submission = (
      await asc.post('/reviewSubmissions', {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      })
    ).data;
  }
  try {
    await asc.post('/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    });
  } catch (error) {
    // Already in this draft submission from an earlier, interrupted run.
    if (error.status !== 409) throw error;
  }
  await asc.patch(`/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  log('Submitted for App Review');
}

/**
 * Takes an uploaded build all the way to "Waiting for Review". A version already past the
 * editable states (submitted, in review, approved, live) is left alone.
 */
async function releaseVersion({ credentials, appId, version, buildNumber, whatsNew, reviewNotes, log }) {
  const asc = createClient(credentials);
  const record = await ensureVersion(asc, appId, version, log);
  const state = versionState(record);
  if (!EDITABLE_STATES.has(state)) {
    log(`App Store version ${version} is already ${state}; nothing to submit`);
    return { state };
  }
  await setWhatsNew(asc, record.id, whatsNew, log);
  if (reviewNotes) await setReviewNotes(asc, record.id, reviewNotes, log);
  const build = await waitForBuild(asc, appId, version, buildNumber, log);
  await attachBuild(asc, record.id, build, log);
  await submitForReview(asc, appId, record.id, log);
  return { state: 'WAITING_FOR_REVIEW' };
}

/** `[{ version, state, releaseType }]`, newest first. */
async function versionStatus({ credentials, appId }) {
  const versions = await listVersions(createClient(credentials), appId);
  return versions.map((v) => ({
    version: v.attributes.versionString,
    state: versionState(v),
    releaseType: v.attributes.releaseType,
  }));
}

module.exports = { releaseVersion, versionStatus };
