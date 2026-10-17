const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { git, checkCleanAndPushed, headCommit, isAncestor } = require('../../src/release/git');

/** A clone of a fresh bare origin, with one commit on main pushed. */
function makeRepo(dir) {
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'clone', '--quiet', origin, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'checkout', '--quiet', '-b', 'main');
  commit(work, 'app.json', '{}');
  git(work, 'push', '--quiet', 'origin', 'main');
  return work;
}

function commit(root, file, text) {
  fs.writeFileSync(path.join(root, file), text);
  git(root, 'add', file);
  git(root, 'commit', '--quiet', '-m', `edit ${file}`);
}

describe('checkCleanAndPushed (the git state remote builds always need)', () => {
  let dir;
  let repo;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-kit-git-'));
    repo = makeRepo(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes on a clean main at origin/main', () => {
    checkCleanAndPushed(repo, 'main');
  });

  it('fails on another branch', () => {
    git(repo, 'checkout', '--quiet', '-b', 'feature');
    assert.throws(() => checkCleanAndPushed(repo, 'main'), /releases are cut from main \(on feature\)/);
  });

  it('fails with uncommitted changes', () => {
    fs.writeFileSync(path.join(repo, 'app.json'), '{"changed":true}');
    assert.throws(() => checkCleanAndPushed(repo, 'main'), /uncommitted changes/);
  });

  it('fails with untracked files', () => {
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'x');
    assert.throws(() => checkCleanAndPushed(repo, 'main'), /uncommitted changes/);
  });

  it('fails with unpushed commits', () => {
    commit(repo, 'app.json', '{"v":2}');
    assert.throws(() => checkCleanAndPushed(repo, 'main'), /main is not in sync with origin\/main/);
  });

  it('fails when origin has commits this clone lacks (it fetches first)', () => {
    const other = path.join(dir, 'other');
    git(dir, 'clone', '--quiet', path.join(dir, 'origin.git'), other);
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'user.name', 'Test');
    commit(other, 'app.json', '{"v":3}');
    git(other, 'push', '--quiet', 'origin', 'main');
    assert.throws(() => checkCleanAndPushed(repo, 'main'), /not in sync/);
  });
});

describe('headCommit and isAncestor', () => {
  let dir;
  let repo;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-kit-git-'));
    repo = makeRepo(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gives the full SHA, never a branch name', () => {
    assert.match(headCommit(repo), /^[0-9a-f]{40}$/);
  });

  it('orders commits', () => {
    const first = headCommit(repo);
    commit(repo, 'app.json', '{"v":2}');
    const second = headCommit(repo);
    assert.equal(isAncestor(repo, first, second), true);
    assert.equal(isAncestor(repo, second, first), false);
    assert.equal(isAncestor(repo, first, 'f'.repeat(40)), false);
  });
});
