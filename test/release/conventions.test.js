const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { releaseProblems, workflowProblems, parseGitHubRemote, githubLinkProblem } = require('../../src/release/conventions');

const json = (value) => JSON.stringify(value, null, 2);
const template = fs.readFileSync(path.join(__dirname, '../../templates/release.yml'), 'utf8');

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
      '.eas/workflows/release.yml': template,
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
    [
      'a missing release workflow',
      (a) => (a.files['.eas/workflows/release.yml'] = null),
      /\.eas\/workflows\/release\.yml is missing.*templates\/release\.yml/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    it(`flags ${name}`, () => {
      const problems = releaseProblems(appWith(change));
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], expected);
    });
  }
});

describe('releaseProblems for --local', () => {
  it("doesn't need the release workflow", () => {
    const app = appWith((a) => (a.files['.eas/workflows/release.yml'] = null));
    assert.deepEqual(releaseProblems(app, { workflow: false }), []);
  });
});

describe('workflowProblems', () => {
  it('accepts the template', () => {
    assert.deepEqual(workflowProblems(template), []);
  });

  it('accepts 4-space indentation, quoted values, comments, and block-list needs', () => {
    const text = template
      .replace(/^( +)/gm, (spaces) => spaces.repeat(2))
      .replace('profile: production\n\n  ', "profile: 'production' # store builds\n\n  ")
      .replace('needs: [build_android]', 'needs:\n        - build_android');
    assert.deepEqual(workflowProblems(text), []);
  });

  const edit = (from, to) => template.replace(from, to);
  const cases = [
    ['a missing file', null, /release\.yml is missing/],
    ['tab indentation', template.replace(/^  /gm, '\t'), /tabs/],
    ['no jobs section', 'name: x\non:\n  workflow_dispatch:\n', /needs "on" and "jobs" sections/],
    ['a push trigger', edit('on:\n', 'on:\n  push:\n    branches: [main]\n'), /remove the push trigger/],
    ['no platform input', edit(/ {4}inputs:[\s\S]*?submit\n/, ''), /"platform" workflow_dispatch input/],
    ['a missing build job', edit(/ {2}build_android:[\s\S]*?production\n\n/, ''), /no build_android job/],
    ['a build without the platform condition', edit("    if: ${{ inputs.platform != 'android' }}\n", ''), /build_ios needs an "if" on inputs\.platform/],
    ['a preview build profile', edit('      platform: ios\n      profile: production', '      platform: ios\n      profile: preview'), /build_ios needs profile: production/],
    ['a wrong build platform', edit('      platform: android\n', '      platform: ios\n'), /build_android needs platform: android/],
    ['a missing submit job', edit(/ {2}submit_ios:[\s\S]*?production\n\n/, ''), /no submit_ios job/],
    ['a submit without needs', edit('    needs: [build_ios]\n', ''), /submit_ios needs needs: \[build_ios\]/],
    [
      'a submit of the wrong build',
      edit('needs.build_android.outputs.build_id', 'needs.build_ios.outputs.build_id'),
      /submit_android needs build_id: \$\{\{ needs\.build_android\.outputs\.build_id \}\}/,
    ],
    ['a submit that is not a submit', edit(/(submit_android:[\s\S]*?)type: submit/, '$1type: custom'), /submit_android needs type: submit/],
  ];
  for (const [name, text, expected] of cases) {
    it(`flags ${name}`, () => {
      const problems = workflowProblems(text);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.match(problems[0], expected);
    });
  }
});

describe('parseGitHubRemote', () => {
  for (const url of [
    'git@github.com:delewis13/VideoClipNote.git',
    'https://github.com/delewis13/VideoClipNote.git',
    'https://github.com/delewis13/VideoClipNote',
    'ssh://git@github.com/delewis13/VideoClipNote.git',
  ]) {
    it(`reads ${url}`, () => {
      assert.deepEqual(parseGitHubRemote(url), { owner: 'delewis13', name: 'VideoClipNote' });
    });
  }

  it('rejects other hosts', () => {
    assert.equal(parseGitHubRemote('git@gitlab.com:a/b.git'), null);
    assert.equal(parseGitHubRemote(null), null);
  });
});

describe('githubLinkProblem', () => {
  const origin = 'git@github.com:delewis13/VideoClipNote.git';

  it('accepts the project linked to origin (any case)', () => {
    assert.equal(githubLinkProblem({ owner: 'Delewis13', name: 'videoclipnote' }, origin), null);
  });

  it('explains how to link an unlinked project', () => {
    assert.match(githubLinkProblem(null, origin), /isn't linked to GitHub.*Project settings → GitHub.*delewis13\/VideoClipNote.*--local/);
  });

  it('flags a project linked to another repo', () => {
    assert.match(githubLinkProblem({ owner: 'someone', name: 'fork' }, origin), /linked to GitHub repo someone\/fork, but origin is delewis13\/VideoClipNote/);
  });

  it('flags an origin that is not on GitHub', () => {
    assert.match(githubLinkProblem(null, 'git@gitlab.com:a/b.git'), /isn't a GitHub repo/);
  });
});
