// Reads an app from disk for `expo-kit release` and `expo-kit check`: the files the conventions
// cover, the repo's default branch on origin, and the Expo config as `expo config` resolves it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { CONVENTIONS, releaseProblems } = require('./conventions');
const { readReleaseNotes } = require('./notes');

/** The nearest directory at or above `start` that holds eas.json. */
function findRoot(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'eas.json'))) return dir;
    if (dir === path.dirname(dir)) throw new Error(`no eas.json in ${start} or any parent directory`);
  }
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readIfExists = (root, rel) => (fs.existsSync(path.join(root, rel)) ? read(root, rel) : null);

/** The branch origin's HEAD points at, asked of the remote so a stale local origin/HEAD can't lie. */
function defaultBranch(root) {
  try {
    const out = execFileSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The fields the release needs from the resolved Expo config, or `{ error }`. */
function resolveExpoConfig(root) {
  let out;
  try {
    out = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr ?? '').trim().split('\n').slice(-2).join(' ');
    return { error: `${detail || 'no output'} (are node_modules up to date? EXPO_DEBUG=1 npx expo config shows why)` };
  }
  const expo = JSON.parse(out);
  return {
    version: expo.version,
    bundleId: expo.ios?.bundleIdentifier ?? null,
    packageName: expo.android?.package ?? null,
    projectId: expo.extra?.eas?.projectId ?? null,
  };
}

/** Everything the conventions are checked against. */
function loadApp(root) {
  const c = CONVENTIONS;
  const paths = [
    c.appJson,
    'eas.json',
    'package.json',
    c.changelog,
    ...Object.values(c.notes),
    'expo-kit.config.js',
    c.workflow,
  ];
  return {
    root,
    defaultBranch: defaultBranch(root),
    files: Object.fromEntries(paths.map((rel) => [rel, readIfExists(root, rel)])),
    expo: resolveExpoConfig(root),
  };
}

/**
 * The app, after checking it follows every convention (all problems are reported at once).
 * `options` go to releaseProblems.
 */
function loadConformingApp(root, options) {
  const app = loadApp(root);
  const problems = releaseProblems(app, options);
  if (problems.length) {
    throw new Error(`this app doesn't follow the expo-kit conventions:\n  - ${problems.join('\n  - ')}`);
  }
  const submit = JSON.parse(app.files['eas.json']).submit[CONVENTIONS.profile];
  return { ...app, ascAppId: submit.ios.ascAppId };
}

/** The store notes `expo-kit release <version>` would send, for the given platforms. */
function loadReleaseNotes(root, version, platforms = ['ios', 'android']) {
  const source = (rel) => ({ path: rel, text: read(root, rel) });
  return readReleaseNotes(
    {
      appStore: platforms.includes('ios') ? source(CONVENTIONS.notes.appStore) : undefined,
      play: platforms.includes('android') ? source(CONVENTIONS.notes.play) : undefined,
    },
    version,
  );
}

module.exports = { findRoot, read, resolveExpoConfig, loadApp, loadConformingApp, loadReleaseNotes };
