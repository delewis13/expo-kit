// Google Play Developer API client for `expo-kit release`. EAS Submit uploads the bundle to the
// submit profile's track as a DRAFT (eas.json `submit.<profile>.android.releaseStatus`), because
// eas submit cannot attach release notes. This promotes that draft to a full rollout with the
// release notes in one edit, which Play then sends for review.

const crypto = require('crypto');
const { fetchWithRetry } = require('./http');

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

async function accessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: serviceAccount.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), serviceAccount.private_key)
    .toString('base64url');
  // Minting a token changes nothing, so this POST is safe to retry.
  const res = await fetchWithRetry(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google OAuth failed: ${json.error_description ?? json.error}`);
  return json.access_token;
}

async function createClient(serviceAccount, packageName) {
  const token = await accessToken(serviceAccount);
  async function request(method, path, body) {
    const send = method === 'GET' ? fetchWithRetry : fetch;
    const res = await send(`${API}/${packageName}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`Google Play ${method} ${path} → ${res.status} ${json?.error?.message ?? text}`);
    }
    return json;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, body) => request('POST', p, body),
    put: (p, body) => request('PUT', p, body),
    delete: (p) => request('DELETE', p),
  };
}

/** Runs `fn(play, editId)` inside a Play edit: committed if `fn` returns true, discarded otherwise. */
async function withEdit(serviceAccount, packageName, fn) {
  const play = await createClient(serviceAccount, packageName);
  const { id: editId } = await play.post('/edits');
  let commit = false;
  try {
    commit = await fn(play, `/edits/${editId}`);
  } finally {
    if (commit) await play.post(`/edits/${editId}:commit`);
    else await play.delete(`/edits/${editId}`).catch(() => {});
  }
}

const hasVersionCode = (release, versionCode) =>
  (release.versionCodes ?? []).includes(String(versionCode));

/**
 * Promotes the `track` release holding `versionCode` to `completed` with `notes`. A release that
 * is already completed only gets its notes filled in if they are missing.
 */
async function releaseOnTrack({ serviceAccount, packageName, track, version, versionCode, notes, log }) {
  await withEdit(serviceAccount, packageName, async (play, edit) => {
    const { defaultLanguage } = await play.get(`${edit}/details`);
    const current = await play.get(`${edit}/tracks/${track}`);
    const release = (current.releases ?? []).find((r) => hasVersionCode(r, versionCode));
    if (!release) {
      throw new Error(`version code ${versionCode} is not on the Play ${track} track; was it uploaded by eas submit?`);
    }
    if (release.status === 'completed' && release.releaseNotes?.length) {
      log(`Play ${track} ${version} (${versionCode}) is already released with notes`);
      return false;
    }
    await play.put(`${edit}/tracks/${track}`, {
      track,
      releases: [
        {
          name: release.name ?? `${version} (${versionCode})`,
          versionCodes: [String(versionCode)],
          status: 'completed',
          releaseNotes: [{ language: defaultLanguage, text: notes }],
        },
      ],
    });
    log(`Play ${track} ${version} (${versionCode}) set to full rollout with ${defaultLanguage} notes`);
    return true;
  });
}

/** Opens and discards an edit: proves the key works before a long build. */
async function checkAccess({ serviceAccount, packageName }) {
  await withEdit(serviceAccount, packageName, async (play, edit) => {
    await play.get(`${edit}/details`);
    return false;
  });
}

/** The track's releases: `[{ name, versionCodes, status, hasNotes }]`. */
async function trackStatus({ serviceAccount, packageName, track }) {
  let releases = [];
  await withEdit(serviceAccount, packageName, async (play, edit) => {
    releases = (await play.get(`${edit}/tracks/${track}`)).releases ?? [];
    return false;
  });
  return releases.map((r) => ({
    name: r.name,
    versionCodes: r.versionCodes,
    status: r.status,
    hasNotes: Boolean(r.releaseNotes?.length),
  }));
}

module.exports = { releaseOnTrack, checkAccess, trackStatus };
