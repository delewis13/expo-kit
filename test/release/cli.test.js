const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { parseCommandLine, rerunCommand } = require('../../src/release/cli');

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
