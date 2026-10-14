// Pure parsing of an app's release setup: the `release` section of expo-kit.config.js and the
// eas.json submit profile. No I/O, so every rule is unit-tested.

const DEFAULTS = {
  /** The branch releases are cut from; it must be clean and in sync with origin. */
  branch: 'main',
  /** The file holding the app's marketing version (JSON or an app.config.js/ts literal). */
  versionFile: 'app.json',
  /** A Keep a Changelog file whose `## [Unreleased]` section is cut per release; null skips it. */
  changelog: null,
  /** npm scripts that must pass before the version bump, e.g. ['typecheck', 'lint', 'test']. */
  gates: [],
  /** Where each store's per-version notes live (format in the README). */
  notes: {
    appStore: 'docs/APP_STORE_METADATA.md',
    play: 'docs/PLAY_STORE_METADATA.md',
  },
  /** The eas.json build AND submit profile to release with. */
  profile: 'production',
};

function rejectUnknownKeys(object, known, where) {
  const unknown = Object.keys(object).filter((key) => !(key in known));
  if (unknown.length) {
    throw new Error(`unknown ${where} key(s): ${unknown.join(', ')} (known: ${Object.keys(known).join(', ')})`);
  }
}

/** The `release` config section with defaults filled in. Unknown keys are errors, to catch typos. */
function resolveReleaseConfig(raw = {}) {
  rejectUnknownKeys(raw, DEFAULTS, 'release config');
  rejectUnknownKeys(raw.notes ?? {}, DEFAULTS.notes, 'release.notes');
  const config = { ...DEFAULTS, ...raw, notes: { ...DEFAULTS.notes, ...raw.notes } };
  if (!Array.isArray(config.gates)) throw new Error('release.gates must be an array of npm script names');
  return config;
}

/** The submit profile's store settings from eas.json, with EAS Submit's own defaults. */
function readSubmitProfile(easJsonText, profile) {
  const submit = JSON.parse(easJsonText).submit?.[profile];
  if (!submit) throw new Error(`eas.json has no submit.${profile} profile`);
  return {
    ascAppId: submit.ios?.ascAppId ?? null,
    playTrack: submit.android?.track ?? 'internal',
    playReleaseStatus: submit.android?.releaseStatus ?? 'completed',
  };
}

/** Throws if the submit profile can't support the release flow for `platforms`. */
function checkSubmitProfile(submit, platforms, profile) {
  if (platforms.includes('ios') && !submit.ascAppId) {
    throw new Error(
      `eas.json submit.${profile}.ios.ascAppId is not set ` +
        "(the app's Apple ID, under App Information in App Store Connect)",
    );
  }
  if (platforms.includes('android') && submit.playReleaseStatus !== 'draft') {
    throw new Error(
      `eas.json submit.${profile}.android.releaseStatus must be "draft": eas submit can't attach ` +
        'release notes, so the release adds them and then rolls the draft out itself',
    );
  }
}

module.exports = { DEFAULTS, resolveReleaseConfig, readSubmitProfile, checkSubmitProfile };
