// `expo-kit check`: everything about this app that doesn't follow the expo-kit conventions, all at
// once, including whether EAS holds the store keys the release uses and whether the EAS project is
// linked to the GitHub repo (remote builds need it; `expo-kit release --local` doesn't).

const { releaseProblems, githubLinkProblem } = require('./release/conventions');
const { findRoot, loadApp } = require('./release/project');
const { originUrl } = require('./release/git');
const eas = require('./release/eas');

async function credentialProblems(expo) {
  if (expo.error || !expo.projectId) return [];
  try {
    const creds = await eas.fetchStoreCredentials(expo);
    return [
      !creds.asc && 'EAS has no App Store Connect API key linked for submissions (eas credentials, iOS)',
      !creds.play && 'EAS has no Google service-account key linked for submissions (eas credentials, Android)',
    ].filter(Boolean);
  } catch (error) {
    return [`couldn't read the store keys from EAS: ${error.message}`];
  }
}

async function githubProblems(root, expo) {
  if (expo.error || !expo.projectId) return [];
  try {
    const problem = githubLinkProblem(await eas.linkedGitHubRepo(expo.projectId), originUrl(root));
    return problem ? [problem] : [];
  } catch (error) {
    return [`couldn't read the EAS project's GitHub link: ${error.message}`];
  }
}

async function main() {
  const app = loadApp(findRoot());
  const problems = [
    ...releaseProblems(app),
    ...(await credentialProblems(app.expo)),
    ...(await githubProblems(app.root, app.expo)),
  ];
  if (!problems.length) {
    console.log('✓ follows the expo-kit conventions');
    return;
  }
  console.log(`${problems.length} thing(s) to fix:\n  - ${problems.join('\n  - ')}`);
  process.exitCode = 1;
}

function run() {
  main().catch((error) => {
    console.error(`\n[check] FAILED: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { run };
