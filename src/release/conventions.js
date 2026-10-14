// The one app layout `expo-kit release` supports. There is no per-app config: every app is set up
// this way, and `releaseProblems` lists everything an app does differently. Pure, so every rule is
// unit-tested; project.js gathers the inputs from disk, git, and `expo config`.

const CONVENTIONS = {
  branch: 'main',
  profile: 'production',
  playTrack: 'production',
  appJson: 'app.json',
  changelog: 'docs/CHANGELOG.md',
  notes: { appStore: 'docs/APP_STORE_METADATA.md', play: 'docs/PLAY_STORE_METADATA.md' },
  gates: ['typecheck', 'lint', 'test'],
  scripts: { release: 'expo-kit release', 'release:status': 'expo-kit release status' },
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Scripts that start a watcher instead of running once, which would hang the release. */
function watchesByDefault(script) {
  return /--watch\b/.test(script) || (/\bvitest\b/.test(script) && !/\bvitest\s+run\b/.test(script));
}

/**
 * Everything about the app that doesn't match CONVENTIONS, as human-readable fixes. Input:
 * `{ defaultBranch, files, expo }` where `files[path]` is the text or null when missing (for
 * app.json, eas.json, package.json, the changelog, the notes files, and the retired
 * expo-kit.config.js) and `expo` is the resolved Expo config or `{ error }`.
 */
function releaseProblems({ defaultBranch, files, expo }) {
  const c = CONVENTIONS;
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };

  need(
    defaultBranch === c.branch,
    `the repo's default branch is ${defaultBranch ?? 'unknown'}, not ${c.branch} (rename it on GitHub)`,
  );

  const appVersion = parseJson(files[c.appJson] ?? '')?.expo?.version;
  need(appVersion, `${c.appJson} must hold the app version as expo.version`);
  if (expo.error) {
    problems.push(`\`npx expo config\` failed: ${expo.error}`);
  } else {
    need(
      !appVersion || expo.version === appVersion,
      `the Expo config resolves version ${expo.version}, but ${c.appJson} says ${appVersion}: ` +
        `app.config.* must take the version from ${c.appJson} (export a function and use config.version)`,
    );
    need(expo.projectId, 'the Expo config has no extra.eas.projectId (run `npx eas-cli init`)');
    need(expo.bundleId, 'the Expo config has no ios.bundleIdentifier');
    need(expo.packageName, 'the Expo config has no android.package');
  }

  need(
    /^## \[Unreleased\][ \t]*$/m.test(files[c.changelog] ?? ''),
    `${c.changelog} must exist with a "## [Unreleased]" section`,
  );
  for (const notesFile of Object.values(c.notes)) need(files[notesFile] != null, `${notesFile} is missing`);

  const scripts = parseJson(files['package.json'] ?? '')?.scripts ?? {};
  for (const gate of c.gates) {
    need(scripts[gate], `package.json needs a "${gate}" script`);
    need(!scripts[gate] || !watchesByDefault(scripts[gate]), `the "${gate}" script must run once, not watch`);
  }
  for (const [name, command] of Object.entries(c.scripts)) {
    need(scripts[name] === command, `package.json "${name}" must be "${command}"`);
  }

  const submit = parseJson(files['eas.json'] ?? '')?.submit?.[c.profile];
  const at = `eas.json submit.${c.profile}`;
  need(submit, `${at} is missing`);
  if (submit) {
    need(submit.ios?.ascAppId, `${at}.ios.ascAppId must be the app's Apple ID (App Store Connect → App Information)`);
    need(submit.android?.track === c.playTrack, `${at}.android.track must be "${c.playTrack}"`);
    need(
      submit.android?.releaseStatus === 'draft',
      `${at}.android.releaseStatus must be "draft" (the release adds the notes, then rolls it out)`,
    );
  }

  need(files['expo-kit.config.js'] == null, 'expo-kit.config.js is no longer used: delete it');
  return problems;
}

module.exports = { CONVENTIONS, releaseProblems };
