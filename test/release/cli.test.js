const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { parseCommandLine, rerunCommand, tagPlan } = require('../../src/release/cli');

describe('parseCommandLine (build mode)', () => {
  it('builds remotely by default', () => {
    const { command, options } = parseCommandLine(['3.2.0']);
    assert.equal(command, '3.2.0');
    assert.equal(options.local, false);
    assert.equal(options.platform, 'all');
  });

  it('builds locally with --local', () => {
    assert.equal(parseCommandLine(['3.2.0', '--local']).options.local, true);
  });

  it('keeps --platform, --rebuild, and --dry-run alongside either mode', () => {
    const { options } = parseCommandLine(['3.2.0', '--platform', 'android', '--rebuild', '--dry-run']);
    assert.deepEqual(
      { platform: options.platform, rebuild: options.rebuild, dryRun: options['dry-run'], local: options.local },
      { platform: 'android', rebuild: true, dryRun: true, local: false },
    );
  });

  it('rejects unknown flags', () => {
    assert.throws(() => parseCommandLine(['3.2.0', '--remote']), /Unknown option '--remote'/);
  });
});

describe('rerunCommand', () => {
  let script;
  beforeEach(() => {
    script = process.env.npm_lifecycle_event;
    delete process.env.npm_lifecycle_event;
  });
  afterEach(() => {
    if (script === undefined) delete process.env.npm_lifecycle_event;
    else process.env.npm_lifecycle_event = script;
  });

  it('has no mode flag for a remote release', () => {
    assert.equal(rerunCommand('3.2.0', { platform: 'all', local: false }), 'npx expo-kit release 3.2.0');
  });

  it('repeats --local and --platform', () => {
    assert.equal(rerunCommand('3.2.0', { platform: 'ios', local: true }), 'npx expo-kit release 3.2.0 --platform ios --local');
  });

  it('goes through the npm script the user ran', () => {
    process.env.npm_lifecycle_event = 'release';
    assert.equal(rerunCommand('3.2.0', { platform: 'all', local: true }), 'npm run release -- 3.2.0 --local');
  });
});

describe('tagPlan', () => {
  const A = 'abc1234' + '0'.repeat(33);
  const B = 'def5678' + '0'.repeat(33);
  const builds = (iosCommit, androidCommit) => ({
    ios: { buildNumber: '37', gitCommitHash: iosCommit },
    android: { buildNumber: '38', gitCommitHash: androidCommit },
  });
  const head = 'f'.repeat(40);

  it('tags the shared commit with the build numbers when both platforms match', () => {
    assert.deepEqual(tagPlan('3.2.0', builds(A, A), ['ios', 'android'], { head }), {
      tag: 'v3.2.0',
      commit: A,
      message: 'v3.2.0 (iOS 37, Android 38)',
      warning: null,
    });
  });

  it('tags a single platform', () => {
    const plan = tagPlan('3.2.0', { android: { buildNumber: '38', gitCommitHash: B } }, ['android'], { head });
    assert.deepEqual([plan.commit, plan.message, plan.warning], [B, 'v3.2.0 (Android 38)', null]);
  });

  it('falls back to HEAD when EAS has no commit for the build', () => {
    assert.equal(tagPlan('3.2.0', builds(null, null), ['ios', 'android'], { head }).commit, head);
  });

  it('lists each commit and warns when the platforms were built from different commits', () => {
    const plan = tagPlan('3.2.0', builds(A, B), ['ios', 'android'], { head, isAncestor: (a, b) => a === A && b === B });
    assert.equal(plan.message, 'v3.2.0 (iOS 37 @abc1234, Android 38 @def5678)');
    assert.match(plan.warning, /different commits \(iOS 37 from abc1234, Android 38 from def5678\)/);
  });

  it('points a mixed tag at the newer commit', () => {
    const androidNewer = tagPlan('3.2.0', builds(A, B), ['ios', 'android'], { head, isAncestor: (a, b) => a === A && b === B });
    assert.equal(androidNewer.commit, B);
    assert.match(androidNewer.warning, /tagging def5678 \(the newer one\)/);

    const iosNewer = tagPlan('3.2.0', builds(A, B), ['ios', 'android'], { head, isAncestor: (a, b) => a === B && b === A });
    assert.equal(iosNewer.commit, A);
    assert.match(iosNewer.warning, /tagging abc1234 \(the newer one\)/);
  });

  it("points a mixed tag at iOS's commit when the commits have diverged", () => {
    const plan = tagPlan('3.2.0', builds(A, B), ['ios', 'android'], { head, isAncestor: () => false });
    assert.equal(plan.commit, A);
    assert.match(plan.warning, /neither contains the other, so iOS's/);
  });
});
