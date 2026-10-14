const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  readReleaseNotes,
  bumpVersionText,
  cutChangelog,
  PLAY_RELEASE_NOTES_MAX,
} = require('../../src/release/notes');

const fence = (text) => '```text\n' + text + '\n```';

const appStoreText = [
  '### Version',
  '',
  '2.0.0',
  '',
  "What's New in This Version (2.0.0):",
  '',
  fence('Big news.\n\n• One thing'),
  '',
  'App Review notes (2.0.0):',
  '',
  fence('Add the widget.'),
].join('\n');

const playText = ['## Release Notes', '', '2.0.0:', '', fence('Play news.'), '', '1.9.0:', '', fence('Old.')].join('\n');

const sources = (appStore = appStoreText, play = playText) => ({
  appStore: appStore && { path: 'docs/APP_STORE.md', text: appStore },
  play: play && { path: 'docs/PLAY.md', text: play },
});

describe('readReleaseNotes', () => {
  it("reads What's New, review notes, and the Play notes for the version", () => {
    assert.deepEqual(readReleaseNotes(sources(), '2.0.0'), {
      whatsNew: 'Big news.\n\n• One thing',
      reviewNotes: 'Add the widget.',
      playNotes: 'Play news.',
    });
  });

  it('picks the matching Play block, not the first one', () => {
    const md = appStoreText.replace(/2\.0\.0/g, '1.9.0');
    assert.equal(readReleaseNotes(sources(md), '1.9.0').playNotes, 'Old.');
  });

  it('treats review notes as optional', () => {
    const md = appStoreText.split('App Review notes')[0];
    assert.equal(readReleaseNotes(sources(md), '2.0.0').reviewNotes, null);
  });

  it("fails without What's New or Play notes, naming the file", () => {
    assert.throws(() => readReleaseNotes(sources(), '2.1.0'), /APP_STORE\.md has no "What's New/);
    const noPlay = playText.replace('2.0.0:', '2.0.1:');
    assert.throws(() => readReleaseNotes(sources(appStoreText, noPlay), '2.0.0'), /PLAY\.md has no "2\.0\.0:"/);
  });

  it('only requires the stores being released', () => {
    assert.equal(readReleaseNotes(sources(null), '2.0.0').playNotes, 'Play news.');
    assert.equal(readReleaseNotes(sources(appStoreText, null), '2.0.0').playNotes, null);
  });

  it('enforces the Play 500-character limit', () => {
    const long = playText.replace('Play news.', 'x'.repeat(PLAY_RELEASE_NOTES_MAX + 1));
    assert.throws(() => readReleaseNotes(sources(appStoreText, long), '2.0.0'), /limit 500/);
  });
});

describe('compareVersions', () => {
  it('compares numerically per component', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
    assert.equal(compareVersions('1.2.9', '1.3.0'), -1);
  });
});

describe('bumpVersionText', () => {
  it('rewrites only the app version in app.json, keeping the formatting', () => {
    const text = '{\n  "expo": {\n    "name": "X",\n    "version": "1.3.0",\n    "cli": { "version": "20.0.0" }\n  }\n}\n';
    assert.equal(
      bumpVersionText(text, '1.3.0', '1.4.0', 'app.json'),
      text.replace('"version": "1.3.0",', '"version": "1.4.0",'),
    );
  });

  it('rewrites a version literal in app.config.ts', () => {
    const text = "const config = {\n  name: 'SyncTake',\n  version: '1.0.0',\n  runtimeVersion: '1.0.0',\n};\n";
    assert.equal(
      bumpVersionText(text, '1.0.0', '1.1.0', 'app.config.ts'),
      text.replace("  version: '1.0.0'", "  version: '1.1.0'"),
    );
  });

  it('refuses a file without the current version, or with it twice', () => {
    assert.throws(() => bumpVersionText('{ "version": "0.9.0" }', '1.0.0', '1.1.0', 'app.json'), /release\.versionFile/);
    const twice = '{ "a": { "version": "1.0.0" }, "b": { "version": "1.0.0" } }';
    assert.throws(() => bumpVersionText(twice, '1.0.0', '1.1.0', 'app.json'), /2 version "1\.0\.0" entries/);
  });
});

describe('cutChangelog', () => {
  const md = '# Changelog\n\n## [Unreleased]\n### Added\n- A thing\n\n## [1.3.0] — 2026-09-27\n- Old\n';

  it('moves the Unreleased entries under a dated version heading', () => {
    assert.equal(
      cutChangelog(md, '1.4.0', '2026-10-01'),
      '# Changelog\n\n## [Unreleased]\n\n## [1.4.0] — 2026-10-01\n### Added\n- A thing\n\n## [1.3.0] — 2026-09-27\n- Old\n',
    );
  });

  it('refuses an empty Unreleased or an existing version', () => {
    const empty = cutChangelog(md, '1.4.0', '2026-10-01');
    assert.throws(() => cutChangelog(empty, '1.5.0', '2026-10-02'), /empty/);
    assert.throws(() => cutChangelog(md, '1.3.0', '2026-10-01', 'CHANGELOG.md'), /CHANGELOG\.md already has/);
  });
});
