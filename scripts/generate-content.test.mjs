import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceMapPath = path.join(repositoryRoot, 'content', 'source-map.json');
const generatedPages = [
  'content/pages/cv.md',
  'content/pages/home.md',
  'content/pages/services.md',
  'content/pages/projects.md',
  'content/pages/projects/asira.md',
  'content/pages/projects/nordhem.md',
  'content/pages/projects/stockholmsmassan.md'
];
const excludedPages = [
  'content/pages/profile.md',
  'content/pages/contact.md',
  'content/pages/demo-profile.md'
];
const transactionPath = '.content-generation.transaction.json';
const generationLockPath = '.cv-generation.lock';
const normalize = text => text.replace(/\r\n?/g, '\n');
const hash = data => createHash('sha256').update(data).digest('hex');
const target = (root, relativePath) => path.join(root, ...relativePath.split('/'));

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-content-generator-'));
  t.after(() => removeFixture(root));
  fs.mkdirSync(path.join(root, 'content', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });

  const mapping = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
  const baseline = 'known pre-generator page\n';
  mapping.bootstrapOutputSha256 = Object.fromEntries(generatedPages.map(page => [page, hash(baseline)]));
  fs.writeFileSync(target(root, 'content/source-map.json'), `${JSON.stringify(mapping, null, 2)}\n`);
  fs.copyFileSync(path.join(repositoryRoot, 'content', 'sources', 'master-cv.md'), target(root, mapping.source));
  fs.copyFileSync(path.join(repositoryRoot, 'scripts', 'generate-content.mjs'), target(root, 'scripts/generate-content.mjs'));
  for (const page of generatedPages) {
    fs.mkdirSync(path.dirname(target(root, page)), { recursive: true });
    fs.writeFileSync(target(root, page), baseline);
  }
  for (const page of excludedPages) {
    fs.mkdirSync(path.dirname(target(root, page)), { recursive: true });
    fs.writeFileSync(target(root, page), `must remain untouched: ${page}\n`);
  }
  return root;
}

function createSymlinkOrSkip(t, targetPath, linkPath, type) {
  try {
    fs.symlinkSync(targetPath, linkPath, type);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Platform denied symlink creation (${error.code}).`);
      return false;
    }
    throw error;
  }
}

function run(root, mode, preload, envOverrides = {}) {
  const args = preload
    ? ['--require', preload, 'scripts/generate-content.mjs', mode]
    : ['scripts/generate-content.mjs', mode];
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: preload
      ? { ...process.env, CONTENT_SYNC_TRACE: target(root, '.sync-trace'), ...envOverrides }
      : process.env
  });
}

function createSyncTraceAdapter(root) {
  const preload = target(root, 'scripts/sync-trace.cjs');
  const adapter = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const logPath = process.env.CONTENT_SYNC_TRACE;",
    "const originalOpenSync = fs.openSync;",
    "const originalFsyncSync = fs.fsyncSync;",
    "const originalCloseSync = fs.closeSync;",
    "const originalLstatSync = fs.lstatSync;",
    "const originalUnlinkSync = fs.unlinkSync;",
    "const originalRmSync = fs.rmSync;",
    "const originalRenameSync = fs.renameSync;",
    "const originalAppendFileSync = fs.appendFileSync;",
    "const directoryDescriptors = new Map();",
    "const fileDescriptors = new Map();",
    "let journalRemoved = false;",
    "let journalRemovalFailureInjected = false;",
    "let generationLockRemoved = false;",
    "const relative = value => path.relative(process.cwd(), path.resolve(value)).split(path.sep).join('/') || '.';",
    "const record = value => originalAppendFileSync(logPath, `${value}\\n`);",
    "fs.openSync = function (file, ...args) {",
    "  let isDirectory = false;",
    "  try { isDirectory = originalLstatSync(file).isDirectory(); } catch {}",
    "  let descriptor;",
    "  try { descriptor = originalOpenSync.call(fs, file, ...args); }",
    "  catch (error) { if (isDirectory) record(`sync-open-error:${relative(file)}:${error.code}`); throw error; }",
    "  if (typeof file === 'string' || Buffer.isBuffer(file)) {",
    "    if (isDirectory) { record(`sync-open:${relative(file)}`); directoryDescriptors.set(descriptor, relative(file)); }",
    "    else fileDescriptors.set(descriptor, relative(file));",
    "  }",
    "  return descriptor;",
    "};",
    "fs.fsyncSync = function (descriptor, ...args) {",
    "  if (directoryDescriptors.has(descriptor)) record(`sync-fsync:${directoryDescriptors.get(descriptor)}`);",
    "  if (fileDescriptors.has(descriptor)) record(`file-fsync:${fileDescriptors.get(descriptor)}`);",
    "  if (process.env.CONTENT_FAIL_LOCK_FSYNC === '1' && fileDescriptors.get(descriptor) === '.cv-generation.lock') {",
    "    const error = new Error('simulated lock acquisition failure');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  if (process.env.CONTENT_FAIL_POST_JOURNAL_FSYNC === '1' && journalRemoved && directoryDescriptors.get(descriptor) === '.') {",
    "    const error = new Error('simulated root fsync failure after journal removal');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  if (process.env.CONTENT_FAIL_LOCK_RELEASE_SYNC === '1' && generationLockRemoved && directoryDescriptors.get(descriptor) === '.') {",
    "    const error = new Error('simulated lock release directory sync failure');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  return originalFsyncSync.call(fs, descriptor, ...args);",
    "};",
    "fs.closeSync = function (descriptor, ...args) {",
    "  directoryDescriptors.delete(descriptor);",
    "  fileDescriptors.delete(descriptor);",
    "  return originalCloseSync.call(fs, descriptor, ...args);",
    "};",
    "fs.rmSync = function (file, ...args) {",
    "  if (process.env.CONTENT_FAIL_JOURNAL_REMOVE === '1' && relative(file) === '.content-generation.transaction.json' && !journalRemovalFailureInjected) {",
    "    journalRemovalFailureInjected = true;",
    "    const error = new Error('simulated journal removal failure');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  const result = originalRmSync.call(fs, file, ...args);",
    "  record(`remove:${relative(file)}`);",
    "  if (relative(file) === '.content-generation.transaction.json') journalRemoved = true;",
    "  return result;",
    "};",
    "fs.unlinkSync = function (file, ...args) {",
    "  if (process.env.CONTENT_FAIL_LOCK_REMOVE === '1' && relative(file) === '.cv-generation.lock') {",
    "    const error = new Error('simulated lock removal failure');",
    "    error.code = 'EIO';",
    "    throw error;",
    "  }",
    "  const result = originalUnlinkSync.call(fs, file, ...args);",
    "  if (relative(file) === '.cv-generation.lock') generationLockRemoved = true;",
    "  return result;",
    "};",
    "fs.renameSync = function (from, to) {",
    "  const result = originalRenameSync.call(fs, from, to);",
    "  record(`rename:${relative(from)}->${relative(to)}`);",
    "  return result;",
    "};"
  ].join('\n');
  fs.writeFileSync(preload, adapter);
  return { preload, trace: target(root, '.sync-trace') };
}

async function startLockHolder(root) {
  const code = [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, token: require('node:crypto').randomUUID() }) + '\\n', { flag: 'wx' });",
    "process.stdout.write('READY\\n');",
    "process.stdin.resume();"
  ].join('\n');
  const child = spawn(process.execPath, ['-e', code, target(root, generationLockPath)], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.includes('READY')) resolve();
    });
    child.once('error', reject);
    child.once('exit', codeValue => reject(new Error(`Lock-holder exited before readiness: ${codeValue}`)));
  });
  return child;
}

function stopLockHolder(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

function withFixture(t, callback) {
  return callback(createFixture(t));
}

function injectWriteFault(root, action) {
  const scriptPath = target(root, 'scripts/generate-content.mjs');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const writeLine = "      atomicReplace(entry.path, Buffer.from(entry.nextContent, 'base64'), previousContent, entry.stagedPath);";
  assert.ok(script.includes(writeLine), 'write operation should be present for fault injection');
  fs.writeFileSync(scriptPath, script.replace(
    writeLine,
    `${writeLine}\n      if (entry.path === 'content/pages/cv.md') ${action}`
  ));
}

function injectCrashAfterStage(root) {
  const scriptPath = target(root, 'scripts/generate-content.mjs');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const renameLine = '    fs.renameSync(temporary, assertNoSymlinkPath(relativePath));';
  assert.ok(script.includes(renameLine), 'staged-file rename should be present for crash injection');
  fs.writeFileSync(scriptPath, script.replace(
    renameLine,
    "    if (relativePath === 'content/pages/cv.md') process.exit(86);\n" + renameLine
  ));
}

function injectExitAfterRecovery(root) {
  const scriptPath = target(root, 'scripts/generate-content.mjs');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const recoveryLine = /^(  rollbackJournal\(journal\);)\r?$/m;
  assert.match(script, recoveryLine, 'recovery rollback should be present for exit injection');
  fs.writeFileSync(scriptPath, script.replace(recoveryLine, '$1\n  process.exit(86);'));
}

function stagedTemporaryFiles(root, directory = root) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return stagedTemporaryFiles(root, entryPath);
    return /\.content-generation-.*\.tmp$/.test(entry.name)
      ? [path.relative(root, entryPath)]
      : [];
  });
}

test('validates the canonical source and rejects malformed source', t => withFixture(t, root => {
  const valid = run(root, '--validate-source');
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Validated canonical source/);

  const sourcePath = target(root, 'content/sources/master-cv.md');
  fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, 'utf8').replace('## Översikt', '## Sammanfattning'));
  const invalid = run(root, '--validate-source');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Required source heading not found/);
}));

test('ignores section-like headings inside backtick and tilde fenced code blocks', t => withFixture(t, root => {
  const sourcePath = target(root, 'content/sources/master-cv.md');
  let source = fs.readFileSync(sourcePath, 'utf8');
  source = source.replace(
    '## Översikt',
    '````markdown\n## Översikt\nfake backtick section\n````\n\n~~~markdown\n## Översikt\nfake tilde section\n~~~\n\n## Översikt'
  );
  fs.writeFileSync(sourcePath, source);

  const validation = run(root, '--validate-source');
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.equal(run(root, '--write').status, 0);
  const home = fs.readFileSync(target(root, 'content/pages/home.md'), 'utf8');
  assert.match(home, /## Översikt\nSenior konsult/);
}));

test('rejects duplicate section headings outside fenced code blocks', t => withFixture(t, root => {
  const sourcePath = target(root, 'content/sources/master-cv.md');
  fs.appendFileSync(sourcePath, '\n\n## Översikt\nDuplicate section.\n');

  const result = run(root, '--validate-source');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Ambiguous source section heading appears more than once/);
}));

test('writes deterministically, checks exact outputs and records all hashes', t => withFixture(t, root => {
  const excludedBefore = excludedPages.map(page => fs.readFileSync(target(root, page), 'utf8'));
  const bootstrap = run(root, '--write');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(fs.existsSync(target(root, generationLockPath)), false);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
  assert.equal(fs.existsSync(target(root, `${transactionPath}.tmp`)), false);

  const firstPages = generatedPages.map(page => fs.readFileSync(target(root, page)));
  const firstProvenance = fs.readFileSync(target(root, 'content/generated-provenance.json'));
  assert.equal(run(root, '--check').status, 0);
  assert.equal(run(root, '--write').status, 0);
  assert.deepEqual(generatedPages.map(page => fs.readFileSync(target(root, page))), firstPages);
  assert.deepEqual(fs.readFileSync(target(root, 'content/generated-provenance.json')), firstProvenance);

  const provenance = JSON.parse(firstProvenance);
  const { provenanceSha256, ...unsignedProvenance } = provenance;
  assert.equal(provenanceSha256, hash(JSON.stringify(unsignedProvenance)));
  const source = normalize(fs.readFileSync(target(root, provenance.source), 'utf8'));
  const mapping = normalize(fs.readFileSync(target(root, provenance.sourceMap), 'utf8'));
  const generator = normalize(fs.readFileSync(target(root, provenance.generator), 'utf8'));
  assert.equal(provenance.sourceSha256, hash(source));
  assert.equal(provenance.sourceMapSha256, hash(mapping));
  assert.equal(provenance.generatorSha256, hash(generator));
  assert.deepEqual(provenance.generatedPages, generatedPages);
  assert.deepEqual(Object.keys(provenance.outputSha256), generatedPages);
  for (const page of generatedPages) assert.equal(provenance.outputSha256[page], hash(fs.readFileSync(target(root, page))));

  assert.deepEqual(excludedPages.map(page => fs.readFileSync(target(root, page), 'utf8')), excludedBefore);
  const pageFiles = fs.readdirSync(target(root, 'content/pages'), { recursive: true })
    .filter(file => file.endsWith('.md'))
    .map(file => `content/pages/${file.replaceAll(path.sep, '/')}`)
    .sort();
  assert.deepEqual(pageFiles, [...generatedPages, ...excludedPages].sort());
  assert.equal(provenance.source, 'content/sources/master-cv.md');
  assert.equal(provenance.generatedPages.includes('content/pages/profile.md'), false);
}));

test('syncs every committed output and parent directory before removing the journal', t => withFixture(t, root => {
  const { preload, trace } = createSyncTraceAdapter(root);
  const result = run(root, '--write', preload);
  assert.equal(result.status, 0, result.stderr);

  const events = fs.readFileSync(trace, 'utf8').trim().split('\n');
  const journalRemoval = events.indexOf(`remove:${transactionPath}`);
  const outputs = [...generatedPages, 'content/generated-provenance.json'];
  assert.ok(journalRemoval >= 0);
  for (const relativePath of outputs) {
    const rename = events.findIndex(event => event.endsWith(`->${relativePath}`));
    const stagedPath = events[rename]?.slice('rename:'.length).split('->')[0];
    const fileSync = events.indexOf(`file-fsync:${stagedPath}`);
    const parent = path.posix.dirname(relativePath) === '.' ? '.' : path.posix.dirname(relativePath);
    const parentSync = events.indexOf(`sync-fsync:${parent}`, rename + 1);
    assert.ok(rename >= 0, `${relativePath} should be atomically replaced`);
    assert.ok(fileSync >= 0 && fileSync < rename && rename < journalRemoval,
      `${relativePath} should be synced before replacement and before journal removal`);
    assert.ok(parentSync > rename && parentSync < journalRemoval,
      `${parent} should be synced after its output and before journal removal`);
  }
  assert.ok(events.indexOf('sync-fsync:.', journalRemoval + 1) > journalRemoval,
    'the repository root should be synced after journal removal');
}));

test('does not roll back committed outputs when syncing journal removal fails', t => withFixture(t, root => {
  const { preload } = createSyncTraceAdapter(root);
  const result = run(root, '--write', preload, { CONTENT_FAIL_POST_JOURNAL_FSYNC: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outputs are committed.*journal cleanup\/durability is uncertain/i);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
  assert.equal(run(root, '--check').status, 0);
}));

test('keeps committed outputs when journal removal fails and recovers cleanup without rollback', t => withFixture(t, root => {
  const baseline = generatedPages.map(page => fs.readFileSync(target(root, page)));
  const { preload } = createSyncTraceAdapter(root);
  const failed = run(root, '--write', preload, { CONTENT_FAIL_JOURNAL_REMOVE: '1' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /outputs are committed.*journal cleanup\/durability is uncertain.*simulated journal removal failure/i);
  const journal = JSON.parse(fs.readFileSync(target(root, transactionPath), 'utf8'));
  assert.equal(journal.committed, true);
  assert.notDeepEqual(generatedPages.map(page => fs.readFileSync(target(root, page))), baseline);
  for (const entry of journal.entries) {
    assert.deepEqual(fs.readFileSync(target(root, entry.path)), Buffer.from(entry.nextContent, 'base64'));
  }

  const retry = run(root, '--write');
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Recovered committed content-generation transaction journal/);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
  assert.equal(run(root, '--check').status, 0);
}));

test('refuses concurrent generation while another process owns the filesystem lock', async t => withFixture(t, async root => {
  const holder = await startLockHolder(root);
  t.after(() => stopLockHolder(holder));
  const lockPath = target(root, generationLockPath);
  const originalLock = fs.readFileSync(lockPath, 'utf8');
  for (const mode of ['--check', '--write']) {
    const result = run(root, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /locked by PID .*Confirm no content-generation process is active.*manually remove the exact lock file/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), originalLock);
  }
}));

test('refuses a lock owned by the current live process', t => withFixture(t, root => {
  const lock = { pid: process.pid, token: randomUUID() };
  fs.writeFileSync(target(root, generationLockPath), `${JSON.stringify(lock)}\n`);
  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`locked by PID ${process.pid}.*manually remove the exact lock file`));
  assert.deepEqual(JSON.parse(fs.readFileSync(target(root, generationLockPath), 'utf8')), lock);
}));

test('leaves an exited process lock untouched until manual cleanup, then recovers the journal', async t => withFixture(t, async root => {
  const { preload } = createSyncTraceAdapter(root);
  const interrupted = run(root, '--write', preload, { CONTENT_FAIL_JOURNAL_REMOVE: '1' });
  assert.notEqual(interrupted.status, 0);
  assert.ok(fs.existsSync(target(root, transactionPath)));

  const holder = await startLockHolder(root);
  const lockPath = target(root, generationLockPath);
  const lockContents = fs.readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(lockContents);
  await stopLockHolder(holder);
  assert.throws(() => process.kill(lock.pid, 0), error => error.code === 'ESRCH');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents);

  const blocked = run(root, '--write');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, new RegExp(`locked by PID ${lock.pid}.*manually remove the exact lock file`));
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents);
  assert.ok(fs.existsSync(target(root, transactionPath)));

  fs.unlinkSync(lockPath);
  const retry = run(root, '--write');
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Recovered committed content-generation transaction journal/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
}));

test('removes its own lock after successful generation', t => withFixture(t, root => {
  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(target(root, generationLockPath)), false);
}));

test('preserves acquisition failure and reports actionable lock cleanup failure', t => withFixture(t, root => {
  const { preload } = createSyncTraceAdapter(root);
  const result = run(root, '--check', preload, {
    CONTENT_FAIL_LOCK_FSYNC: '1',
    CONTENT_FAIL_LOCK_REMOVE: '1'
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated lock acquisition failure/);
  assert.match(result.stderr, /lock cleanup also failed: simulated lock removal failure/);
  assert.match(result.stderr, /\.cv-generation\.lock file may remain/);
  assert.match(result.stderr, /inspect that exact file and its PID, confirm no content-generation process is active/);
  assert.match(result.stderr, /Remove-Item -LiteralPath \.cv-generation\.lock/);
  assert.ok(fs.existsSync(target(root, generationLockPath)));
}));

test('preserves generation failure and reports actionable lock release failure', t => withFixture(t, root => {
  injectWriteFault(root, "{ throw new Error('simulated mid-write failure'); }");
  const { preload } = createSyncTraceAdapter(root);
  const result = run(root, '--write', preload, { CONTENT_FAIL_LOCK_REMOVE: '1' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /simulated mid-write failure/);
  assert.match(result.stderr, /lock cleanup also failed: simulated lock removal failure/);
  assert.match(result.stderr, /\.cv-generation\.lock file may remain/);
  assert.match(result.stderr, /inspect that exact file and its PID, confirm no content-generation process is active/);
  assert.match(result.stderr, /Remove-Item -LiteralPath \.cv-generation\.lock/);
  assert.ok(fs.existsSync(target(root, generationLockPath)));
}));

test('reports lock release failure after successful generation without undoing outputs', t => withFixture(t, root => {
  const { preload } = createSyncTraceAdapter(root);
  const result = run(root, '--write', preload, { CONTENT_FAIL_LOCK_RELEASE_SYNC: '1' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Content generation completed, but releasing its lock failed/);
  assert.match(result.stderr, /simulated lock release directory sync failure/);
  assert.match(result.stderr, /\.cv-generation\.lock file may remain/);
  assert.match(result.stderr, /inspect that exact file and its PID, confirm no content-generation process is active/);
  assert.match(result.stderr, /Remove-Item -LiteralPath \.cv-generation\.lock/);
  assert.equal(fs.existsSync(target(root, generationLockPath)), false);
  assert.notEqual(fs.readFileSync(target(root, generatedPages[0]), 'utf8'), 'known pre-generator page\n');
}));

test('removes only the reserved journal temp when recovering without a journal', t => withFixture(t, root => {
  const journalTemporary = target(root, `${transactionPath}.tmp`);
  const unrelated = target(root, 'unrelated.tmp');
  fs.writeFileSync(journalTemporary, '{"incomplete":');
  fs.writeFileSync(unrelated, 'must remain untouched');

  const result = run(root, '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(journalTemporary), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'must remain untouched');
}));

test('fails closed for bootstrap mismatches and manual generated-output edits', t => withFixture(t, root => {
  fs.writeFileSync(target(root, 'content/pages/cv.md'), 'manually changed before bootstrap\n');
  const bootstrapConflict = run(root, '--write');
  assert.notEqual(bootstrapConflict.status, 0);
  assert.match(bootstrapConflict.stderr, /Bootstrap output differs from recorded baseline/);

  fs.writeFileSync(target(root, 'content/pages/cv.md'), 'known pre-generator page\n');
  assert.equal(run(root, '--write').status, 0);
  fs.appendFileSync(target(root, 'content/pages/home.md'), '\nmanual edit\n');

  const checkConflict = run(root, '--check');
  assert.notEqual(checkConflict.status, 0);
  assert.match(checkConflict.stderr, /Generated output is stale or modified/);
  const writeConflict = run(root, '--write');
  assert.notEqual(writeConflict.status, 0);
  assert.match(writeConflict.stderr, /Generated output was manually changed; refusing overwrite/);
}));

test('fails closed when generated provenance is manually edited', t => withFixture(t, root => {
  assert.equal(run(root, '--write').status, 0);
  const manifestPath = target(root, 'content/generated-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  provenance.sourceSha256 = '0'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(provenance, null, 2)}\n`);

  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Generated provenance was modified/);
}));

test('rejects a symlinked generated output without modifying its target', t => withFixture(t, root => {
  const generatedPath = target(root, 'content/pages/cv.md');
  const outsidePath = target(root, 'outside-cv.md');
  fs.writeFileSync(outsidePath, 'must remain untouched\n');
  fs.unlinkSync(generatedPath);
  if (!createSymlinkOrSkip(t, outsidePath, generatedPath, 'file')) return;

  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink is not allowed in generated content path/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'must remain untouched\n');
}));

test('rejects a symlinked generated-output parent directory', t => withFixture(t, root => {
  const projectsPath = target(root, 'content/pages/projects');
  const externalProjectsPath = target(root, 'outside-projects');
  fs.mkdirSync(externalProjectsPath);
  fs.rmSync(projectsPath, { recursive: true });
  if (!createSymlinkOrSkip(
    t,
    externalProjectsPath,
    projectsPath,
    process.platform === 'win32' ? 'junction' : 'dir'
  )) return;

  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink is not allowed in generated content path/);
  assert.deepEqual(fs.readdirSync(externalProjectsPath), []);
}));

test('rejects a symlinked transaction journal without modifying its target', t => withFixture(t, root => {
  const journalTarget = target(root, transactionPath);
  const outsidePath = target(root, 'outside-journal.json');
  fs.writeFileSync(outsidePath, 'must remain untouched\n');
  if (!createSymlinkOrSkip(t, outsidePath, journalTarget, 'file')) return;

  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink is not allowed in generated content path/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'must remain untouched\n');
}));

test('rejects a symlinked generation lock without modifying its target', t => withFixture(t, root => {
  const outsidePath = target(root, 'outside-lock');
  fs.writeFileSync(outsidePath, 'must remain untouched\n');
  if (!createSymlinkOrSkip(t, outsidePath, target(root, generationLockPath), 'file')) return;

  const result = run(root, '--write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink is not allowed in generated content path/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'must remain untouched\n');
}));

test('rejects a symlinked canonical source', t => withFixture(t, root => {
  const sourcePath = target(root, 'content/sources/master-cv.md');
  const outsidePath = target(root, 'outside-source.md');
  fs.writeFileSync(outsidePath, 'must not be read\n');
  fs.unlinkSync(sourcePath);
  if (!createSymlinkOrSkip(t, outsidePath, sourcePath, 'file')) return;

  const result = run(root, '--validate-source');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Symlink is not allowed in generated content path/);
}));

test('fails closed during recovery when an output has become a symlink', t => withFixture(t, root => {
  assert.equal(run(root, '--write').status, 0);
  const generatorPath = target(root, 'scripts/generate-content.mjs');
  const generator = fs.readFileSync(generatorPath, 'utf8');
  injectWriteFault(root, '{ process.exit(86); }');

  const interrupted = run(root, '--write');
  assert.equal(interrupted.status, 86);
  fs.writeFileSync(generatorPath, generator);
  fs.unlinkSync(target(root, generationLockPath));

  const generatedPath = target(root, 'content/pages/home.md');
  const outsidePath = target(root, 'outside-home.md');
  fs.writeFileSync(outsidePath, 'must remain untouched\n');
  fs.unlinkSync(generatedPath);
  if (!createSymlinkOrSkip(t, outsidePath, generatedPath, 'file')) return;

  const recovery = run(root, '--write');
  assert.notEqual(recovery.status, 0);
  assert.match(recovery.stderr, /Symlink is not allowed in generated content path/);
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'must remain untouched\n');
  assert.equal(fs.existsSync(target(root, transactionPath)), true);
}));

test('preserves manual edits made while a transaction is pending', t => withFixture(t, root => {
  assert.equal(run(root, '--write').status, 0);
  const generatorPath = target(root, 'scripts/generate-content.mjs');
  const generator = fs.readFileSync(generatorPath, 'utf8');
  injectWriteFault(root, '{ process.exit(86); }');

  const interrupted = run(root, '--write');
  assert.equal(interrupted.status, 86);
  fs.writeFileSync(generatorPath, generator);
  fs.unlinkSync(target(root, generationLockPath));

  const manuallyEditedPath = target(root, 'content/pages/home.md');
  fs.appendFileSync(manuallyEditedPath, '\nmanual edit during recovery\n');
  const manualEdit = fs.readFileSync(manuallyEditedPath);
  const recovery = run(root, '--write');
  assert.notEqual(recovery.status, 0);
  assert.match(recovery.stderr, /Generated output was manually changed during an interrupted transaction/);
  assert.deepEqual(fs.readFileSync(manuallyEditedPath), manualEdit);
  assert.equal(fs.existsSync(target(root, transactionPath)), true);
}));

test('rolls back a caught mid-write error and permits a clean retry', t => withFixture(t, root => {
  const initialWrite = run(root, '--write');
  assert.equal(initialWrite.status, 0, initialWrite.stderr);
  const before = [...generatedPages, 'content/generated-provenance.json']
    .map(page => fs.readFileSync(target(root, page)));
  const generatorPath = target(root, 'scripts/generate-content.mjs');
  const generator = fs.readFileSync(generatorPath, 'utf8');
  injectWriteFault(root, "{ throw new Error('simulated mid-write failure'); }");

  const failed = run(root, '--write');
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /simulated mid-write failure/);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
  assert.deepEqual([...generatedPages, 'content/generated-provenance.json']
    .map(page => fs.readFileSync(target(root, page))), before);

  fs.writeFileSync(generatorPath, generator);
  const retry = run(root, '--write');
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(run(root, '--check').status, 0);
}));

test('recovers an interrupted write on the next run and allows retry without conflict', t => withFixture(t, root => {
  assert.equal(run(root, '--write').status, 0);
  const generatorPath = target(root, 'scripts/generate-content.mjs');
  const generator = fs.readFileSync(generatorPath, 'utf8');
  injectWriteFault(root, '{ process.exit(86); }');

  const interrupted = run(root, '--write');
  assert.equal(interrupted.status, 86);
  assert.equal(fs.existsSync(target(root, transactionPath)), true);
  fs.unlinkSync(target(root, generationLockPath));
  const pendingCheck = run(root, '--check');
  assert.notEqual(pendingCheck.status, 0);
  assert.match(pendingCheck.stderr, /Pending content-generation transaction journal found/);

  fs.writeFileSync(generatorPath, generator);
  const recoveredRetry = run(root, '--write');
  assert.equal(recoveredRetry.status, 0, recoveredRetry.stderr);
  assert.match(recoveredRetry.stdout, /Recovered and rolled back pending/);
  assert.equal(fs.existsSync(target(root, transactionPath)), false);
  assert.equal(fs.existsSync(target(root, `${transactionPath}.tmp`)), false);
  assert.equal(run(root, '--check').status, 0);
}));

test('syncs restored and deleted output parents before removing the recovery journal', t => withFixture(t, root => {
  const initialWrite = run(root, '--write');
  assert.equal(initialWrite.status, 0, initialWrite.stderr);

  const outputPaths = [...generatedPages, 'content/generated-provenance.json'];
  const entries = outputPaths.map(relativePath => {
    const nextContent = fs.readFileSync(target(root, relativePath));
    const restoring = relativePath === 'content/pages/home.md';
    const deleting = relativePath === 'content/pages/projects/asira.md';
    const previousContent = restoring
      ? Buffer.from('known pre-generator page\n')
      : deleting ? undefined : nextContent;
    const directory = path.posix.dirname(relativePath);
    const basename = path.posix.basename(relativePath);
    const stagedPath = `${directory === '.' ? '' : `${directory}/`}${basename}.content-generation-1-${randomUUID()}.tmp`;
    return {
      path: relativePath,
      existed: !deleting,
      previousContent: previousContent?.toString('base64') ?? null,
      nextContent: nextContent.toString('base64'),
      stagedPath
    };
  });
  fs.writeFileSync(target(root, transactionPath), `${JSON.stringify({ version: 2, entries })}\n`);

  injectExitAfterRecovery(root);
  const { preload, trace } = createSyncTraceAdapter(root);
  const recovery = run(root, '--write', preload);
  assert.equal(recovery.status, 86, recovery.stderr);
  assert.deepEqual(fs.readFileSync(target(root, 'content/pages/home.md')), Buffer.from('known pre-generator page\n'));
  assert.equal(fs.existsSync(target(root, 'content/pages/projects/asira.md')), false);

  const events = fs.readFileSync(trace, 'utf8').trim().split('\n');
  const journalRemoval = events.indexOf(`remove:${transactionPath}`);
  const restoreRename = events.indexOf(`rename:${entries[1].stagedPath}->content/pages/home.md`);
  const restoreSync = events.indexOf('sync-open:content/pages', restoreRename + 1);
  const deletion = events.indexOf('remove:content/pages/projects/asira.md');
  const deletionSync = events.indexOf('sync-open:content/pages/projects', deletion + 1);
  const journalParentSync = events.indexOf('sync-open:.', journalRemoval + 1);
  const assertSyncAttemptAfter = (mutation, parent, successfulOpen, message) => {
    const open = events.indexOf(`sync-open:${parent}`, mutation + 1);
    if (open >= 0) {
      const fsync = events.indexOf(`sync-fsync:${parent}`, open + 1);
      assert.ok(fsync > open, message);
      return;
    }
    const unsupportedOpen = events.find(event => event.startsWith(`sync-open-error:${parent}:`));
    const errorCode = unsupportedOpen?.split(':').at(-1);
    assert.ok(
      ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(errorCode) ||
        (process.platform === 'win32' && errorCode === 'EPERM'),
      `${message}; directory sync can be skipped only for an explicitly unsupported platform error`
    );
    assert.ok(successfulOpen < 0, 'unsupported open should not also have succeeded');
  };
  assert.ok(restoreRename >= 0, 'recovery should atomically restore the prior file');
  assert.ok(restoreSync > restoreRename && restoreSync < journalRemoval,
    'the restored file parent must be synced before journal removal');
  assertSyncAttemptAfter(restoreRename, 'content/pages', restoreSync,
    'restoring an output must call fsync on its parent');
  assert.ok(deletion >= 0, 'recovery should remove the newly created target');
  assert.ok(deletionSync > deletion && deletionSync < journalRemoval,
    'the deleted file parent must be synced before journal removal');
  assertSyncAttemptAfter(deletion, 'content/pages/projects', deletionSync,
    'deleting an output must call fsync on its parent');
  assert.ok(journalParentSync > journalRemoval, 'the journal parent must be synced after journal removal');
  assertSyncAttemptAfter(journalRemoval, '.', journalParentSync,
    'removing the journal must call fsync on its parent');
}));

test('removes journal-listed staged files after a crash before rename', t => withFixture(t, root => {
  const initialWrite = run(root, '--write');
  assert.equal(initialWrite.status, 0, initialWrite.stderr);
  const generatorPath = target(root, 'scripts/generate-content.mjs');
  const generator = fs.readFileSync(generatorPath, 'utf8');
  injectCrashAfterStage(root);

  const interrupted = run(root, '--write');
  assert.equal(interrupted.status, 86);
  const journal = JSON.parse(fs.readFileSync(target(root, transactionPath), 'utf8'));
  assert.equal(journal.version, 2);
  assert.equal(journal.entries.length, generatedPages.length + 1);
  for (const entry of journal.entries) {
    assert.match(entry.stagedPath, /\.content-generation-\d+-[0-9a-f-]+\.tmp$/);
  }
  assert.ok(stagedTemporaryFiles(root).length > 0, 'crash should leave a staged sibling temp file');

  fs.writeFileSync(generatorPath, generator);
  fs.unlinkSync(target(root, generationLockPath));
  const recovery = run(root, '--write');
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.match(recovery.stdout, /Recovered and rolled back pending/);
  assert.deepEqual(stagedTemporaryFiles(root), []);
}));

test('refuses source-map changes outside the fixed public-page allowlist', t => withFixture(t, root => {
  const mapPath = target(root, 'content/source-map.json');
  const mapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  mapping.generatedPages[0].path = 'content/pages/profile.md';
  fs.writeFileSync(mapPath, `${JSON.stringify(mapping, null, 2)}\n`);
  const result = run(root, '--validate-source');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Generated page allowlist must exactly match/);
}));
