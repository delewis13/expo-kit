const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pickBuild, workflowBuilds, activeRunAt, workflowUploadPending } = require('../../src/release/eas');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('pickBuild', () => {
  const builds = [
    { id: 'new-other-commit', appVersion: '3.2.0', gitCommitHash: B, status: 'FINISHED' },
    { id: 'older-this-commit', appVersion: '3.2.0', gitCommitHash: A, status: 'FINISHED' },
    { id: 'other-version', appVersion: '3.1.0', gitCommitHash: A, status: 'FINISHED' },
  ];

  it('takes the newest build of the version when no commit is required (--local)', () => {
    assert.equal(pickBuild(builds, { version: '3.2.0' }).id, 'new-other-commit');
  });

  it('only takes a build of the required commit', () => {
    assert.equal(pickBuild(builds, { version: '3.2.0', gitCommitHash: A }).id, 'older-this-commit');
  });

  it('never takes a build of the version at another commit', () => {
    assert.equal(pickBuild(builds, { version: '3.2.0', gitCommitHash: 'c'.repeat(40) }), null);
  });

  it('never takes another version at the commit', () => {
    assert.equal(pickBuild(builds, { version: '3.3.0', gitCommitHash: A }), null);
  });

  it('returns a failed build of the commit, so the release can say to --rebuild', () => {
    const failed = [{ id: 'f', appVersion: '3.2.0', gitCommitHash: A, status: 'ERRORED' }];
    assert.equal(pickBuild(failed, { version: '3.2.0', gitCommitHash: A }).status, 'ERRORED');
  });
});

describe('workflowBuilds', () => {
  const job = (key, status, buildId = null, platform = null) => ({ key, type: key.startsWith('submit') ? 'SUBMISSION' : 'BUILD', status, buildId, platform });
  const run = (status, jobs) => ({ status, jobs });

  it('has no ids before the build jobs create builds', () => {
    const state = workflowBuilds(run('IN_PROGRESS', [job('build_ios', 'NEW'), job('build_android', 'NEW')]), ['ios', 'android']);
    assert.deepEqual(state, { ids: {}, skipped: [], done: false });
  });

  it('maps each platform to the build its job created', () => {
    const state = workflowBuilds(
      run('IN_PROGRESS', [
        job('build_ios', 'IN_PROGRESS', 'ios-build', 'ios'),
        job('build_android', 'IN_PROGRESS', 'android-build', 'android'),
        job('submit_ios', 'NEW'),
      ]),
      ['ios', 'android'],
    );
    assert.deepEqual(state.ids, { ios: 'ios-build', android: 'android-build' });
  });

  it('goes by the build platform, not the job key, once a build exists', () => {
    const state = workflowBuilds(run('IN_PROGRESS', [job('ios', 'IN_PROGRESS', 'x', 'ios')]), ['ios']);
    assert.deepEqual(state.ids, { ios: 'x' });
  });

  it('reports a platform whose build job was skipped or failed before building', () => {
    const state = workflowBuilds(
      run('IN_PROGRESS', [job('build_ios', 'IN_PROGRESS', 'i', 'ios'), job('build_android', 'SKIPPED')]),
      ['ios', 'android'],
    );
    assert.deepEqual(state.skipped, ['android']);
  });

  it('only looks at the platforms asked for', () => {
    const state = workflowBuilds(run('IN_PROGRESS', [job('build_ios', 'SKIPPED'), job('build_android', 'NEW')]), ['android']);
    assert.deepEqual(state, { ids: {}, skipped: [], done: false });
  });

  it('knows when the run is over', () => {
    assert.equal(workflowBuilds(run('FAILURE', []), ['ios']).done, true);
    assert.equal(workflowBuilds(run('WAITING', []), ['ios']).done, false);
  });
});

describe('activeRunAt', () => {
  const runs = [
    { id: 'other-commit', status: 'IN_PROGRESS', gitCommitHash: B },
    { id: 'finished', status: 'SUCCESS', gitCommitHash: A },
    { id: 'going', status: 'NEW', gitCommitHash: A },
  ];

  it('finds a run still going at the commit', () => {
    assert.equal(activeRunAt(runs, A).id, 'going');
  });

  it('ignores finished runs and other commits', () => {
    assert.equal(activeRunAt(runs.slice(0, 2), A), null);
  });
});

describe('workflowUploadPending', () => {
  const workflowJob = (submitStatus) => ({
    key: 'build_ios',
    workflowRun: {
      jobs: [
        { key: 'build_ios', type: 'BUILD', status: 'SUCCESS', requiredJobKeys: [] },
        { key: 'submit_ios', type: 'SUBMISSION', status: submitStatus, requiredJobKeys: ['build_ios'] },
        { key: 'submit_android', type: 'SUBMISSION', status: 'NEW', requiredJobKeys: ['build_android'] },
      ],
    },
  });

  it('is false for a build no workflow made', () => {
    assert.equal(workflowUploadPending(null), false);
  });

  it("is true while the build's submit job hasn't run", () => {
    assert.equal(workflowUploadPending(workflowJob('NEW')), true);
    assert.equal(workflowUploadPending(workflowJob('IN_PROGRESS')), true);
  });

  it('is false once the submit job is over, whatever the outcome', () => {
    for (const status of ['SUCCESS', 'FAILURE', 'CANCELED', 'SKIPPED']) {
      assert.equal(workflowUploadPending(workflowJob(status)), false, status);
    }
  });
});
