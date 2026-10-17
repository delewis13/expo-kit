const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { pickBuild, workflowBuilds, activeRunAt, workflowUploadPending, workflowUploaded } = require('../../src/release/eas');

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

  // What EAS actually returns: requiredJobKeys is empty even for jobs with `needs`.
  const easJob = (runStatus, jobs) => ({ key: 'build_android', workflowRun: { status: runStatus, jobs } });
  const buildAndroid = { key: 'build_android', type: 'BUILD', status: 'SUCCESS', requiredJobKeys: [] };

  it('finds the submit job by its conventional key when requiredJobKeys is empty', () => {
    const submit = (status) => ({ key: 'submit_android', type: 'SUBMISSION', status, requiredJobKeys: [] });
    const done = { key: 'submit_ios', type: 'SUBMISSION', status: 'SUCCESS', requiredJobKeys: [] };
    assert.equal(workflowUploadPending(easJob('IN_PROGRESS', [buildAndroid, done, submit('IN_PROGRESS')])), true);
    assert.equal(workflowUploadPending(easJob('SUCCESS', [buildAndroid, done, submit('SUCCESS')])), false);
  });

  it("is true while the run is going and EAS hasn't created the submit job yet", () => {
    assert.equal(workflowUploadPending(easJob('IN_PROGRESS', [buildAndroid])), true);
  });

  it('is false when the run is over without a submit job for the build', () => {
    assert.equal(workflowUploadPending(easJob('SUCCESS', [buildAndroid])), false);
    assert.equal(workflowUploadPending(easJob('FAILURE', [buildAndroid])), false);
  });
});

describe('workflowUploaded', () => {
  const easJob = (submitStatus) => ({
    key: 'build_android',
    workflowRun: {
      status: 'IN_PROGRESS',
      jobs: [
        { key: 'build_android', type: 'BUILD', status: 'SUCCESS', requiredJobKeys: [] },
        { key: 'submit_android', type: 'SUBMISSION', status: submitStatus, requiredJobKeys: [] },
      ],
    },
  });

  it("is true only once the build's submit job succeeded", () => {
    assert.equal(workflowUploaded(easJob('SUCCESS')), true);
    for (const status of ['NEW', 'IN_PROGRESS', 'FAILURE', 'CANCELED']) {
      assert.equal(workflowUploaded(easJob(status)), false, status);
    }
  });

  it('is false for a build no workflow made', () => {
    assert.equal(workflowUploaded(null), false);
  });
});
