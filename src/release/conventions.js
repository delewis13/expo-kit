// The one app layout `expo-kit release` supports. There is no per-app config: every app is set up
// this way, and `releaseProblems` lists everything an app does differently. Pure, so every rule is
// unit-tested; project.js gathers the inputs from disk, git, and `expo config`.

const CONVENTIONS = {
  branch: 'main',
  profile: 'production',
  playTrack: 'production',
  appJson: 'app.json',
  changelog: 'docs/CHANGELOG.md',
  notes: { appStore: 'docs/APP_STORE_METADATA.md', play: 'docs/PLAY_STORE_METADATA.md' },
  gates: ['typecheck', 'lint', 'test'],
  scripts: { release: 'expo-kit release', 'release:status': 'expo-kit release status' },
  workflow: '.eas/workflows/release.yml',
  workflowTemplate: 'node_modules/@delewis13/expo-kit/templates/release.yml',
};

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The keys at the outermost indentation of a YAML fragment, each mapped to the lines indented under
 * it. Just enough YAML for the workflow rules (two levels of plain mappings), with no dependency.
 */
function yamlChildren(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return {};
  const indent = Math.min(...lines.map((l) => l.search(/\S/)));
  const children = {};
  let key = null;
  for (const line of lines) {
    if (line.search(/\S/) === indent) {
      key = /^\s*([\w-]+)\s*:/.exec(line)?.[1] ?? null;
      if (key) children[key] = '';
    } else if (key) {
      children[key] += `${line}\n`;
    }
  }
  return children;
}

const field = (block, key, value) =>
  new RegExp(`^\\s+${key}:\\s*['"]?${value}['"]?\\s*(#.*)?$`, 'm').test(block);

/** How the workflow file differs from what remote releases need (see templates/release.yml). */
function workflowProblems(text) {
  const c = CONVENTIONS;
  const fix = `compare it with ${c.workflowTemplate}`;
  if (text == null) return [`${c.workflow} is missing (remote builds run it): copy ${c.workflowTemplate} there`];
  if (/^\t/m.test(text)) return [`${c.workflow} is indented with tabs, which YAML doesn't allow`];
  const top = yamlChildren(text);
  if (top.on == null || top.jobs == null) return [`${c.workflow} needs "on" and "jobs" sections: ${fix}`];

  const problems = [];
  const on = yamlChildren(top.on);
  const triggers = Object.keys(on).filter((t) => t !== 'workflow_dispatch');
  if (triggers.length) {
    problems.push(`${c.workflow} must only run from eas workflow:run: remove the ${triggers.join(', ')} trigger(s)`);
  }
  const inputs = yamlChildren(yamlChildren(on.workflow_dispatch ?? '').inputs ?? '');
  if (inputs.platform == null) {
    problems.push(`${c.workflow} needs a "platform" workflow_dispatch input (all | ios | android): ${fix}`);
  }

  const jobs = yamlChildren(top.jobs);
  for (const platform of ['ios', 'android']) {
    const build = `build_${platform}`;
    const submit = `submit_${platform}`;
    const rules = {
      [build]: [
        ['type: build', (b) => field(b, 'type', 'build')],
        [`platform: ${platform}`, (b) => field(b, 'platform', platform)],
        [`profile: ${c.profile}`, (b) => field(b, 'profile', c.profile)],
        ['an "if" on inputs.platform', (b) => /^\s+if:.*\binputs\.platform\b/m.test(b)],
      ],
      [submit]: [
        ['type: submit', (b) => field(b, 'type', 'submit')],
        [
          `needs: [${build}]`,
          (b) => new RegExp(`^\\s+needs:\\s*\\[[^\\]]*\\b${build}\\b`, 'm').test(b) ||
            new RegExp(`^\\s+needs:\\s*\\n(\\s+-\\s*\\S+\\s*\\n)*\\s+-\\s*${build}\\s*$`, 'm').test(b),
        ],
        [
          `build_id: \${{ needs.${build}.outputs.build_id }}`,
          (b) => field(b, 'build_id', `\\$\\{\\{\\s*needs\\.${build}\\.outputs\\.build_id\\s*\\}\\}`),
        ],
        [`profile: ${c.profile}`, (b) => field(b, 'profile', c.profile)],
      ],
    };
    for (const [job, checks] of Object.entries(rules)) {
      if (jobs[job] == null) {
        problems.push(`${c.workflow} has no ${job} job: ${fix}`);
        continue;
      }
      const missing = checks.filter(([, ok]) => !ok(jobs[job])).map(([what]) => what);
      if (missing.length) problems.push(`${c.workflow} job ${job} needs ${missing.join(', ')}: ${fix}`);
    }
  }
  return problems;
}

/** `{ owner, name }` for a GitHub remote URL (https, ssh, or scp-style), or null. */
function parseGitHubRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return match ? { owner: match[1], name: match[2] } : null;
}

/**
 * Why `eas workflow:run --ref` can't build this repo, or null. `linked` is the GitHub repo the EAS
 * project is connected to (`{ owner, name }` or null), `originUrl` the local origin remote.
 */
function githubLinkProblem(linked, originUrl) {
  const origin = parseGitHubRemote(originUrl);
  if (!origin) return `origin (${originUrl ?? 'none'}) isn't a GitHub repo, which remote builds need (or release with --local)`;
  const slug = `${origin.owner}/${origin.name}`;
  if (!linked) {
    return (
      `the EAS project isn't linked to GitHub, which remote builds need: on expo.dev open the project → ` +
      `Project settings → GitHub, install the Expo GitHub app, and connect ${slug} (or release with --local)`
    );
  }
  if (`${linked.owner}/${linked.name}`.toLowerCase() !== slug.toLowerCase()) {
    return `the EAS project is linked to GitHub repo ${linked.owner}/${linked.name}, but origin is ${slug}`;
  }
  return null;
}

/** Scripts that start a watcher instead of running once, which would hang the release. */
function watchesByDefault(script) {
  return /--watch\b/.test(script) || (/\bvitest\b/.test(script) && !/\bvitest\s+run\b/.test(script));
}

/**
 * Everything about the app that doesn't match CONVENTIONS, as human-readable fixes. Input:
 * `{ defaultBranch, files, expo }` where `files[path]` is the text or null when missing (for
 * app.json, eas.json, package.json, the changelog, the notes files, and the retired
 * expo-kit.config.js, and the workflow file) and `expo` is the resolved Expo config or `{ error }`.
 * The workflow file only matters to remote builds, so `{ workflow: false }` (--local) skips it.
 */
function releaseProblems({ defaultBranch, files, expo }, { workflow = true } = {}) {
  const c = CONVENTIONS;
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };

  need(
    defaultBranch === c.branch,
    `the repo's default branch is ${defaultBranch ?? 'unknown'}, not ${c.branch} (rename it on GitHub)`,
  );

  const appVersion = parseJson(files[c.appJson] ?? '')?.expo?.version;
  need(appVersion, `${c.appJson} must hold the app version as expo.version`);
  if (expo.error) {
    problems.push(`\`npx expo config\` failed: ${expo.error}`);
  } else {
    need(
      !appVersion || expo.version === appVersion,
      `the Expo config resolves version ${expo.version}, but ${c.appJson} says ${appVersion}: ` +
        `app.config.* must take the version from ${c.appJson} (export a function and use config.version)`,
    );
    need(expo.projectId, 'the Expo config has no extra.eas.projectId (run `npx eas-cli init`)');
    need(expo.bundleId, 'the Expo config has no ios.bundleIdentifier');
    need(expo.packageName, 'the Expo config has no android.package');
  }

  need(
    /^## \[Unreleased\][ \t]*$/m.test(files[c.changelog] ?? ''),
    `${c.changelog} must exist with a "## [Unreleased]" section`,
  );
  for (const notesFile of Object.values(c.notes)) need(files[notesFile] != null, `${notesFile} is missing`);

  const scripts = parseJson(files['package.json'] ?? '')?.scripts ?? {};
  for (const gate of c.gates) {
    need(scripts[gate], `package.json needs a "${gate}" script`);
    need(!scripts[gate] || !watchesByDefault(scripts[gate]), `the "${gate}" script must run once, not watch`);
  }
  for (const [name, command] of Object.entries(c.scripts)) {
    need(scripts[name] === command, `package.json "${name}" must be "${command}"`);
  }

  const submit = parseJson(files['eas.json'] ?? '')?.submit?.[c.profile];
  const at = `eas.json submit.${c.profile}`;
  need(submit, `${at} is missing`);
  if (submit) {
    need(submit.ios?.ascAppId, `${at}.ios.ascAppId must be the app's Apple ID (App Store Connect → App Information)`);
    need(submit.android?.track === c.playTrack, `${at}.android.track must be "${c.playTrack}"`);
    need(
      submit.android?.releaseStatus === 'draft',
      `${at}.android.releaseStatus must be "draft" (the release adds the notes, then rolls it out)`,
    );
  }

  need(files['expo-kit.config.js'] == null, 'expo-kit.config.js is no longer used: delete it');
  if (workflow) problems.push(...workflowProblems(files[c.workflow]));
  return problems;
}

module.exports = { CONVENTIONS, releaseProblems, workflowProblems, parseGitHubRemote, githubLinkProblem };
