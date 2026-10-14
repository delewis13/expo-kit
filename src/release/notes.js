// Pure text transforms for `expo-kit release`: reading the per-version store notes out of the
// metadata files, bumping the app version, and cutting the changelog section. No I/O, so every
// rule is unit-tested.

/** Store limits, per the consoles: App Store "What's New" and Play "Release notes" per language. */
const APP_STORE_WHATS_NEW_MAX = 4000;
const APP_STORE_REVIEW_NOTES_MAX = 4000;
const PLAY_RELEASE_NOTES_MAX = 500;

const SEMVER = /^\d+\.\d+\.\d+$/;

function assertSemver(version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not an X.Y.Z version`);
}

/** -1 / 0 / 1, numeric per component (so 1.10.0 > 1.9.0). */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The ```text fenced block that follows a line reading exactly `label`, or null. */
function fencedBlockAfter(md, label) {
  const re = new RegExp(`^${escapeRegExp(label)}[ \\t]*\\n+\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``, 'm');
  const match = re.exec(md);
  return match ? match[1].trim() : null;
}

function checkLength(text, max, what) {
  if (text.length > max) throw new Error(`${what} is ${text.length} characters (limit ${max})`);
}

/**
 * The release-specific copy for `version`. Each source is `{ path, text }`, or omitted when that
 * store isn't part of the release. What's New and the Play notes are required; App Review notes
 * are optional (App Store Connect keeps the previous version's when absent).
 */
function readReleaseNotes({ appStore, play }, version) {
  assertSemver(version);
  const notes = { whatsNew: null, reviewNotes: null, playNotes: null };
  if (appStore) {
    notes.whatsNew = fencedBlockAfter(appStore.text, `What's New in This Version (${version}):`);
    if (!notes.whatsNew) {
      throw new Error(`${appStore.path} has no "What's New in This Version (${version}):" text block`);
    }
    notes.reviewNotes = fencedBlockAfter(appStore.text, `App Review notes (${version}):`);
    checkLength(notes.whatsNew, APP_STORE_WHATS_NEW_MAX, "App Store What's New");
    if (notes.reviewNotes) checkLength(notes.reviewNotes, APP_STORE_REVIEW_NOTES_MAX, 'App Review notes');
  }
  if (play) {
    notes.playNotes = fencedBlockAfter(play.text, `${version}:`);
    if (!notes.playNotes) throw new Error(`${play.path} has no "${version}:" release-notes text block`);
    checkLength(notes.playNotes, PLAY_RELEASE_NOTES_MAX, 'Play release notes');
  }
  return notes;
}

/**
 * `text` with its single `version: "<current>"` entry set to `next`, formatting untouched. Works
 * on JSON (app.json, package.json) and on JS/TS object literals (app.config.ts).
 */
function bumpVersionText(text, current, next, file) {
  assertSemver(next);
  const re = new RegExp(`((?<![\\w$])["']?version["']?\\s*:\\s*)(["'])${escapeRegExp(current)}\\2`, 'g');
  const count = (text.match(re) ?? []).length;
  if (count === 0) {
    throw new Error(
      `${file} has no version "${current}" (what the Expo config resolves to): ` +
        'set release.versionFile to the file the app version comes from',
    );
  }
  if (count > 1) throw new Error(`${file} has ${count} version "${current}" entries; can't tell which to bump`);
  return text.replace(re, `$1$2${next}$2`);
}

/**
 * Moves everything under `## [Unreleased]` into a new `## [version] — date` section, leaving an
 * empty Unreleased heading. Refuses an empty Unreleased (nothing to release) or a version that
 * already has a section.
 */
function cutChangelog(md, version, date, file = 'the changelog') {
  assertSemver(version);
  if (new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(md)) {
    throw new Error(`${file} already has a [${version}] section`);
  }
  const heading = /^## \[Unreleased\][ \t]*\n/m.exec(md);
  if (!heading) throw new Error(`${file} has no "## [Unreleased]" heading`);
  const bodyStart = heading.index + heading[0].length;
  const nextSection = md.slice(bodyStart).search(/^## \[/m);
  const body = nextSection === -1 ? md.slice(bodyStart) : md.slice(bodyStart, bodyStart + nextSection);
  if (!body.trim()) throw new Error(`${file} [Unreleased] is empty: nothing to release`);
  return `${md.slice(0, bodyStart)}\n## [${version}] — ${date}\n${md.slice(bodyStart)}`;
}

module.exports = {
  APP_STORE_WHATS_NEW_MAX,
  PLAY_RELEASE_NOTES_MAX,
  assertSemver,
  compareVersions,
  readReleaseNotes,
  bumpVersionText,
  cutChangelog,
};
