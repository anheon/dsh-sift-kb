import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { GITHUB_OUTPUT, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN } = process.env;
const registry = 'https://registry.npmjs.org';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const isReleaseFile = (path) => !/^(\.github|tests?|docs|probe)\//.test(path)
  && !/\.(md|mdx)$/i.test(path)
  && !/^(\.gitattributes|\.gitignore)$/.test(path);

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function resolveCommit(ref) {
  try {
    return git('rev-parse', '--verify', `${ref}^{commit}`);
  } catch {
    return '';
  }
}

function isAncestor(base, head) {
  try {
    git('merge-base', '--is-ancestor', base, head);
    return true;
  } catch (error) {
    if (error.status !== 1) throw error;
    return false;
  }
}

function output(values) {
  appendFileSync(GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

async function plan() {
  const verifyOnly = ['pull_request', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME);
  output({ package_name: pkg.name });
  if (verifyOnly) {
    output({ mode: 'verify', version: pkg.version });
    return;
  }

  const response = await fetch(`${registry}/${encodeURIComponent(pkg.name)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const registryPackage = await response.json();
  const latest = registryPackage['dist-tags']?.latest;
  if (!versionPattern.test(latest)) throw new Error(`Expected a stable npm latest version, got ${latest}`);
  const published = registryPackage.versions[latest];
  const tagCommit = resolveCommit(`refs/tags/v${latest}`);
  // This version shipped before the repository used release tags.
  const historicalSift = pkg.name === 'dsh-sift-kb' && latest === '1.3.6'
    ? '7fad4de23c0d903a032cdb0bfe623796939605d2'
    : '';
  const publishedCommit = published.dshReleaseCommit;
  if (publishedCommit && (!commitPattern.test(publishedCommit) || (tagCommit && tagCommit !== publishedCommit))) {
    throw new Error(`npm v${latest} conflicts with the release commit recorded in Git`);
  }
  const baseline = publishedCommit || tagCommit || historicalSift;
  if (!baseline || !resolveCommit(baseline)) throw new Error(`Missing release baseline for npm v${latest}`);
  if (!isAncestor(baseline, GITHUB_SHA)) {
    if (!isAncestor(GITHUB_SHA, baseline)) throw new Error(`Release baseline ${baseline} is outside this history`);
    output({ mode: 'skip' });
    console.log('This run predates the latest npm release.');
    return;
  }

  if (publishedCommit) {
    const release = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/v${latest}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (release.status !== 404 && !release.ok) {
      throw new Error(`GitHub Release lookup returned HTTP ${release.status}`);
    }
    if (release.status === 404 || (await release.json()).draft) {
      output({ mode: 'recover', version: latest, commit: baseline, integrity: published.dist.integrity });
      console.log(`Finishing GitHub Release v${latest} from the verified npm publication.`);
      return;
    }
  }

  const paths = git('diff', '--name-only', '-z', '--no-renames', baseline, GITHUB_SHA, '--')
    .split('\0').filter(Boolean).filter(isReleaseFile);
  if (paths.length === 0) {
    output({ mode: 'skip' });
    console.log(`No release changes since ${pkg.name}@${latest}.`);
    return;
  }

  const messages = git('--literal-pathspecs', 'log', '--format=%B', `${baseline}..${GITHUB_SHA}`, '--', ...paths);
  const [major, minor, patch] = latest.split('.').map(Number);
  let version = `${major}.${minor}.${patch + 1}`;
  if (/^BREAKING[ -]CHANGE:\s*\S|^[\w-]+(?:\([^\n)]+\))?!:/m.test(messages)) {
    version = `${major + 1}.0.0`;
  } else if (/^feat(?:\([^\n)]+\))?:/m.test(messages)) {
    version = `${major}.${minor + 1}.0`;
  }
  if (registryPackage.versions[version] || resolveCommit(`refs/tags/v${version}`)) {
    throw new Error(`The calculated release version v${version} is already in use`);
  }
  output({ mode: 'publish', version, commit: GITHUB_SHA });
  console.log(`${pkg.name}@${latest} → ${version}\n${paths.join('\n')}`);
}

function verifyPack() {
  const [pack] = JSON.parse(readFileSync('release-pack.json', 'utf8'));
  const bundle = pkg.dsh?.bundle;
  const patches = Array.isArray(bundle?.patch) ? bundle.patch : [bundle?.patch];
  if (!pkg.main || patches.some((path) => typeof path !== 'string') || !patches.length) {
    throw new Error('The package must declare its main entry and DSH bundle patch');
  }
  const files = new Set(pack.files.map((file) => file.path));
  for (const path of ['package.json', pkg.main, ...patches]) {
    if (!files.has(path.replace(/^\.\//, ''))) throw new Error(`Missing from npm tarball: ${path}`);
  }
  if (pack.name !== pkg.name || pack.version !== pkg.version) throw new Error('Unexpected npm tarball version');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(pack.filename)).digest('base64')}`;
  if (pack.integrity !== integrity) throw new Error('npm pack integrity mismatch');
  renameSync(pack.filename, 'release.tgz');
  output({ integrity, artifact_name: `dsh-package-${process.env.GITHUB_RUN_ATTEMPT}` });
}

if (process.argv[2] === 'plan') await plan();
else if (process.argv[2] === 'verify-pack') verifyPack();
else throw new Error('Expected plan or verify-pack');
