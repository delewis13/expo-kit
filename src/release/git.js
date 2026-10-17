// The git side of `expo-kit release`: the state a release starts from, and the commit it builds.

const { execFileSync } = require('child_process');

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/**
 * Throws unless `root` is on `branch`, with a clean tree, at the same commit as origin's `branch`,
 * so the commit EAS builds is the one on origin. Fetches origin first.
 */
function checkCleanAndPushed(root, branch) {
  const current = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== branch) throw new Error(`releases are cut from ${branch} (on ${current})`);
  if (git(root, 'status', '--porcelain')) throw new Error('the working tree has uncommitted changes');
  git(root, 'fetch', '--quiet', 'origin', branch);
  if (git(root, 'rev-parse', 'HEAD') !== git(root, 'rev-parse', `origin/${branch}`)) {
    throw new Error(`${branch} is not in sync with origin/${branch}: pull or push first`);
  }
}

/** The full SHA of HEAD: remote builds pass it as --ref so the build and the tag share one commit. */
const headCommit = (root) => git(root, 'rev-parse', 'HEAD');

function originUrl(root) {
  try {
    return git(root, 'remote', 'get-url', 'origin');
  } catch {
    return null;
  }
}

/** Whether commit `a` is an ancestor of (or equal to) commit `b`; false when either is unknown. */
function isAncestor(root, a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = { git, checkCleanAndPushed, headCommit, originUrl, isAncestor };
