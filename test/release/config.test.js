const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULTS, resolveReleaseConfig, readSubmitProfile, checkSubmitProfile } = require('../../src/release/config');

describe('resolveReleaseConfig', () => {
  it('fills in defaults, merging notes paths one by one', () => {
    const config = resolveReleaseConfig({ branch: 'master', notes: { play: 'store/play.md' } });
    assert.equal(config.branch, 'master');
    assert.equal(config.versionFile, 'app.json');
    assert.deepEqual(config.notes, { appStore: DEFAULTS.notes.appStore, play: 'store/play.md' });
    assert.deepEqual(resolveReleaseConfig(undefined), DEFAULTS);
  });

  it('rejects unknown keys and non-array gates', () => {
    assert.throws(() => resolveReleaseConfig({ brnach: 'main' }), /unknown release config key\(s\): brnach/);
    assert.throws(() => resolveReleaseConfig({ notes: { ios: 'x.md' } }), /unknown release\.notes key/);
    assert.throws(() => resolveReleaseConfig({ gates: 'test' }), /array/);
  });
});

describe('readSubmitProfile', () => {
  it('reads the store settings', () => {
    const eas = JSON.stringify({
      submit: { production: { ios: { ascAppId: '123' }, android: { track: 'production', releaseStatus: 'draft' } } },
    });
    assert.deepEqual(readSubmitProfile(eas, 'production'), {
      ascAppId: '123',
      playTrack: 'production',
      playReleaseStatus: 'draft',
    });
  });

  it("applies EAS Submit's defaults and requires the profile", () => {
    assert.deepEqual(readSubmitProfile('{ "submit": { "production": {} } }', 'production'), {
      ascAppId: null,
      playTrack: 'internal',
      playReleaseStatus: 'completed',
    });
    assert.throws(() => readSubmitProfile('{}', 'production'), /no submit\.production profile/);
  });
});

describe('checkSubmitProfile', () => {
  const ok = { ascAppId: '123', playTrack: 'production', playReleaseStatus: 'draft' };

  it('needs an ascAppId for iOS and a draft upload for Android', () => {
    checkSubmitProfile(ok, ['ios', 'android'], 'production');
    assert.throws(() => checkSubmitProfile({ ...ok, ascAppId: null }, ['ios'], 'production'), /ascAppId/);
    assert.throws(
      () => checkSubmitProfile({ ...ok, playReleaseStatus: 'completed' }, ['android'], 'production'),
      /releaseStatus must be "draft"/,
    );
  });

  it('only checks the platforms being released', () => {
    checkSubmitProfile({ ...ok, ascAppId: null }, ['android'], 'production');
    checkSubmitProfile({ ...ok, playReleaseStatus: 'completed' }, ['ios'], 'production');
  });
});
