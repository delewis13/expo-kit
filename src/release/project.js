// Reads an app's release setup from disk: expo-kit.config.js, eas.json, the per-store notes, and
// the Expo config as `expo config` resolves it (so app.config.js/ts apps work like app.json ones).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveReleaseConfig, readSubmitProfile } = require('./config');
const { readReleaseNotes } = require('./notes');

const CONFIG_FILE = 'expo-kit.config.js';

/** The nearest directory at or above `start` that holds eas.json. */
function findRoot(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'eas.json'))) return dir;
    if (dir === path.dirname(dir)) throw new Error(`no eas.json in ${start} or any parent directory`);
  }
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** The `release` section of expo-kit.config.js, defaults filled in. The file is optional. */
function loadReleaseConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  const kitConfig = fs.existsSync(file) ? require(file) : {};
  return resolveReleaseConfig(kitConfig.release);
}

/** The fields the release needs from the resolved Expo config. */
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
    throw new Error(
      `\`npx expo config\` failed${detail ? `: ${detail}` : ''} ` +
        '(are node_modules up to date? EXPO_DEBUG=1 npx expo config shows why)',
    );
  }
  const expo = JSON.parse(out);
  return {
    version: expo.version,
    bundleId: expo.ios?.bundleIdentifier ?? null,
    packageName: expo.android?.package ?? null,
    projectId: expo.extra?.eas?.projectId ?? null,
  };
}

/** Everything a release reads up front. */
function loadProject(root) {
  const config = loadReleaseConfig(root);
  const submit = readSubmitProfile(read(root, 'eas.json'), config.profile);
  const expo = resolveExpoConfig(root);
  if (!expo.projectId) throw new Error('the Expo config has no extra.eas.projectId: run `npx eas-cli init`');
  return { root, config, submit, expo };
}

/** The store notes `expo-kit release <version>` would send, for the given platforms. */
function loadReleaseNotes(root, version, platforms = ['ios', 'android'], config = loadReleaseConfig(root)) {
  const source = (rel) => ({ path: rel, text: read(root, rel) });
  return readReleaseNotes(
    {
      appStore: platforms.includes('ios') ? source(config.notes.appStore) : undefined,
      play: platforms.includes('android') ? source(config.notes.play) : undefined,
    },
    version,
  );
}

module.exports = { findRoot, read, loadReleaseConfig, resolveExpoConfig, loadProject, loadReleaseNotes };
