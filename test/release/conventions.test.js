const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { releaseProblems } = require('../../src/release/conventions');

const json = (value) => JSON.stringify(value, null, 2);

function conformingApp() {
  return {
    defaultBranch: 'main',
    expo: { version: '1.2.0', bundleId: 'com.x.app', packageName: 'com.x.app', projectId: 'p1' },
    files: {
      'app.json': json({ expo: { version: '1.2.0' } }),
      'eas.json': json({
        submit: { production: { ios: { ascAppId: '123' }, android: { track: 'production', releaseStatus: 'draft' } } },
      }),
      'package.json': json({
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
          release: 'expo-kit release',
          'release:status': 'expo-kit release status',
        },
      }),
      'docs/CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
      'docs/APP_STORE_METADATA.md': '# App Store\n',
      'docs/PLAY_STORE_METADATA.md': '# Play\n',
      'expo-kit.config.js': null,
    },
  };
}

/** A conforming app with `change` applied to it. */
function appWith(change) {
  const app = conformingApp();
  change(app);
  return app;
}

const patchJson = (app, file, patch) => {
  const value = JSON.parse(app.files[file]);
  patch(value);
  app.files[file] = json(value);
};

describe('releaseProblems', () => {
  it('finds nothing in a conforming app', () => {
    assert.deepEqual(releaseProblems(conformingApp()), []);
  });

  it('reports every problem at once', () => {
    const app = appWith((a) => {
      a.defaultBranch = 'master';
      a.files['docs/CHANGELOG.md'] = null;
      a.files['expo-kit.config.js'] = 'module.exports = {};';
    });
    assert.equal(releaseProblems(app).length, 3);
  });

  const cases = [
    ['a default branch other than main', (a) => (a.defaultBranch = 'master'), /default branch is master/],
    ['an unknown default branch', (a) => (a.defaultBranch = null), /default branch is unknown/],
    ['app.json without the version', (a) => (a.files['app.json'] = '{}'), /app\.json must hold the app version/],
    ['a missing app.json', (a) => (a.files['app.json'] = null), /app\.json must hold the app version/],
    [
      'an app.config that ignores the app.json version',
      (a) => (a.expo.version = '0.1.0'),
      /resolves version 0\.1\.0, but app\.json says 1\.2\.0/,
    ],
    ['an expo config that fails', (a) => (a.expo = { error: 'boom' }), /expo config` failed: boom/],
    ['no EAS project id', (a) => (a.expo.projectId = null), /projectId/],
    ['a changelog without Unreleased', (a) => (a.files['docs/CHANGELOG.md'] = '# Changelog\n'), /\[Unreleased\]/],
    ['a missing Play notes file', (a) => (a.files['docs/PLAY_STORE_METADATA.md'] = null), /PLAY_STORE_METADATA\.md is missing/],
    ['a missing gate script', (a) => patchJson(a, 'package.json', (p) => delete p.scripts.lint), /needs a "lint" script/],
    ['a watching vitest', (a) => patchJson(a, 'package.json', (p) => (p.scripts.test = 'vitest')), /"test" script must run once/],
    ['a --watch flag', (a) => patchJson(a, 'package.json', (p) => (p.scripts.test = 'jest --watch')), /must run once/],
    [
      'a hand-rolled release script',
      (a) => patchJson(a, 'package.json', (p) => (p.scripts.release = 'node scripts/release/index.mjs')),
      /"release" must be "expo-kit release"/,
    ],
    ['no submit profile', (a) => patchJson(a, 'eas.json', (e) => delete e.submit), /submit\.production is missing/],
    ['no ascAppId', (a) => patchJson(a, 'eas.json', (e) => delete e.submit.production.ios), /ascAppId/],
    [
      'a non-production Play track',
      (a) => patchJson(a, 'eas.json', (e) => (e.submit.production.android.track = 'alpha')),
      /track must be "production"/,
    ],
    [
      'a completed (non-draft) Play upload',
      (a) => patchJson(a, 'eas.json', (e) => (e.submit.production.android.releaseStatus = 'completed')),
      /releaseStatus must be "draft"/,
    ],
    ['a leftover expo-kit.config.js', (a) => (a.files['expo-kit.config.js'] = '{}'), /no longer used/],
  ];
  for (const [name, change, expected] of cases) {
    it(`flags ${name}`, () => {
      const problems = releaseProblems(appWith(change));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], expected);
    });
  }
});
