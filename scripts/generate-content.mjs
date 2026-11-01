import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SOURCE_MAP_PATH = 'content/source-map.json';
const PROVENANCE_PATH = 'content/generated-provenance.json';
const TRANSACTION_PATH = '.content-generation.transaction.json';
const TRANSACTION_TEMP_PATH = `${TRANSACTION_PATH}.tmp`;
const GENERATION_LOCK_PATH = '.cv-generation.lock';
const SOURCE_PATH = 'content/sources/master-cv.md';
const PAGE_ALLOWLIST = [
  'content/pages/cv.md',
  'content/pages/home.md',
  'content/pages/services.md',
  'content/pages/projects.md',
  'content/pages/projects/asira.md',
  'content/pages/projects/nordhem.md',
  'content/pages/projects/stockholmsmassan.md'
];
const EXCLUDED_PATHS = new Set([
  'content/pages/profile.md',
  'content/pages/contact.md',
  'content/pages/demo-profile.md'
]);

const root = fs.realpathSync(process.cwd());
const normalizeText = value => value.replace(/\r\n?/g, '\n');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = relativePath => {
  const resolved = assertNoSymlinkPath(relativePath);
  return normalizeText(fs.readFileSync(resolved, 'utf8'));
};
const fail = message => {
  throw new Error(message);
};
const errorMessage = error => error instanceof Error ? error.message : String(error);

function lockCleanupError(originalError, cleanupErrors) {
  const cleanupDetails = cleanupErrors.map(errorMessage).join('; ');
  return new Error(
    `${errorMessage(originalError)}; lock cleanup also failed: ${cleanupDetails}. ` +
    `The ${GENERATION_LOCK_PATH} file may remain. To verify and remove it safely, inspect that exact file and its PID, confirm no content-generation process is active for this workspace (for example, inspect the process returned by Get-Process -Id <pid>), then remove only that exact file with Remove-Item -LiteralPath ${GENERATION_LOCK_PATH} and rerun.`,
    { cause: originalError }
  );
}

function resolveRepositoryPath(relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (!relative) return resolved;
    fail(`Repository path escapes canonical repository root: ${relativePath}`);
  }
  return resolved;
}

function assertCanonicalRoot() {
  let actualRoot;
  try {
    actualRoot = fs.realpathSync(root);
    if (fs.realpathSync(process.cwd()) !== root) fail('Canonical repository root changed during generation.');
  } catch (error) {
    fail(`Cannot revalidate canonical repository root: ${error.message}`);
  }
  if (actualRoot !== root) fail('Canonical repository root changed during generation.');
}

function assertNoSymlinkPath(relativePath) {
  assertCanonicalRoot();
  const resolved = resolveRepositoryPath(relativePath);
  const relative = path.relative(root, resolved);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      fail(`Cannot safely inspect repository path ${relativePath}: ${error.message}`);
    }
    if (stats.isSymbolicLink()) fail(`Symlink is not allowed in generated content path: ${relativePath}`);
    let realPath;
    try {
      realPath = fs.realpathSync(current);
    } catch (error) {
      fail(`Cannot safely resolve repository path ${relativePath}: ${error.message}`);
    }
    const realRelative = path.relative(root, realPath);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      fail(`Resolved repository path escapes canonical repository root: ${relativePath}`);
    }
  }
  return resolved;
}

function assertSafeGenerationPaths() {
  for (const relativePath of [
    SOURCE_MAP_PATH,
    SOURCE_PATH,
    ...PAGE_ALLOWLIST,
    PROVENANCE_PATH,
    TRANSACTION_PATH,
    TRANSACTION_TEMP_PATH,
    GENERATION_LOCK_PATH
  ]) {
    assertNoSymlinkPath(relativePath);
  }
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || path.posix.isAbsolute(relativePath) ||
      relativePath.split('/').some(part => part === '..' || part === '' || part === '.')) {
    fail(`Unsafe repository path: ${relativePath}`);
  }
  if (EXCLUDED_PATHS.has(relativePath)) fail(`Excluded page cannot be generated: ${relativePath}`);
}

function extractSection(source, title, level) {
  const lines = source.split('\n');
  const headings = [];
  let fence;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fenceMatch && (fenceMatch[1][0] !== '`' || !fenceMatch[2].includes('`'))) {
      fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading && heading[1].length === level && heading[2] === title) headings.push(index);
  }
  if (headings.length === 0) fail(`Required source heading not found: ${'#'.repeat(level)} ${title}`);
  if (headings.length > 1) fail(`Ambiguous source section heading appears more than once: ${'#'.repeat(level)} ${title}`);
  const start = headings[0];
  let end = lines.length;
  let closingFence;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (closingFence) {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === closingFence.character && closing[1].length >= closingFence.length) {
        closingFence = undefined;
      }
      continue;
    }
    if (fenceMatch && (fenceMatch[1][0] !== '`' || !fenceMatch[2].includes('`'))) {
      closingFence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+/);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function validateSource(source, mapping) {
  if (!source.trim()) fail('Canonical CV source is empty.');
  for (const section of ['Roller', 'Översikt', 'Kompetensområden', 'Uppdragshistorik']) {
    extractSection(source, section, 2);
  }
  extractSection(source, 'Branscherfarenhet', 2);
  for (const page of mapping.generatedPages) {
    if (page.sourceSection && page.sourceSection !== 'Entire source' &&
        page.path.startsWith('content/pages/projects/')) {
      extractSection(source, page.sourceHeading ?? page.sourceSection.split('/').at(-1).trim(), 3);
    }
    for (const section of page.sourceSections ?? []) extractSection(source, section, 2);
    for (const project of page.selectedProjects ?? []) extractSection(source, project.section, 3);
  }
}

function validateMapping(mapping) {
  if (mapping.version !== 1 || mapping.source !== SOURCE_PATH) fail('Unsupported source-map version or source path.');
  if (!Array.isArray(mapping.generatedPages)) fail('source-map.json must define generatedPages.');
  const paths = mapping.generatedPages.map(page => page.path);
  if (JSON.stringify(paths) !== JSON.stringify(PAGE_ALLOWLIST)) {
    fail(`Generated page allowlist must exactly match: ${PAGE_ALLOWLIST.join(', ')}`);
  }
  for (const page of mapping.generatedPages) {
    assertSafeRelativePath(page.path);
    if (!['page', 'project'].includes(page.type) || !page.title || !page.description ||
        !page.locale || !page.status || !page.sourceSection && !page.sourceSections) {
      fail(`Incomplete mapping metadata for ${page.path}`);
    }
  }
  const bootstrapPaths = Object.keys(mapping.bootstrapOutputSha256 ?? {}).sort();
  if (JSON.stringify(bootstrapPaths) !== JSON.stringify([...PAGE_ALLOWLIST].sort())) {
    fail('Bootstrap hashes must cover the exact generated page allowlist.');
  }
  for (const hash of Object.values(mapping.bootstrapOutputSha256)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) fail('Invalid bootstrap output SHA-256 in source-map.json.');
  }
}

function yamlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return JSON.stringify(value);
  fail('Mapping metadata values must be strings or arrays of strings.');
}

function frontMatter(page, sourceHash) {
  const fields = {
    title: page.title,
    description: page.description,
    locale: page.locale,
    status: page.status,
    type: page.type
  };
  for (const field of ['summary', 'technologies', 'links']) {
    if (page[field] !== undefined) fields[field] = page[field];
  }
  fields.source = 'sources/master-cv.md';
  if (page.sourceSection) fields.sourceSection = page.sourceSection;
  fields.sourceSha256 = sourceHash;
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')}\n---\n`;
}

function pageBody(page, source) {
  if (page.path === 'content/pages/cv.md') return source.trimEnd();
  if (page.path === 'content/pages/home.md') {
    return page.sourceSections.map(section => extractSection(source, section, 2)).join('\n\n');
  }
  if (page.path === 'content/pages/services.md') return extractSection(source, page.sourceSection, 2);
  if (page.path === 'content/pages/projects.md') {
    const selected = page.selectedProjects.map(project => {
      const section = extractSection(source, project.section, 3);
      const heading = section.match(/^###\s+(.+)$/m)?.[1];
      if (!heading) fail(`Project section has no title: ${project.section}`);
      return `- [${heading}](${project.path})`;
    });
    return `## ${page.sourceSection}\n\n${selected.join('\n')}`;
  }
  const project = extractSection(source, page.sourceHeading ?? page.sourceSection.split('/').at(-1).trim(), 3);
  const links = `\n\n[Till alla uppdrag](/projects) · [Fullständigt CV](/cv)`;
  return `${project}${links}`;
}

function generate(mapping, source, sourceHash) {
  const renderableSource = source.replace(/[ \t]+$/gm, whitespace => whitespace.length >= 2 ? '\\' : '');
  const outputs = new Map();
  for (const page of mapping.generatedPages) {
    outputs.set(page.path, `${frontMatter(page, sourceHash)}\n${pageBody(page, renderableSource).trim()}\n`);
  }
  return outputs;
}

function hashOutputs(outputs) {
  return Object.fromEntries([...outputs].map(([relativePath, content]) => [relativePath, sha256(content)]));
}

function load() {
  const mappingText = readText(SOURCE_MAP_PATH);
  const mapping = JSON.parse(mappingText);
  validateMapping(mapping);
  const source = readText(mapping.source);
  validateSource(source, mapping);
  const sourceHash = sha256(source);
  const generatorHash = sha256(readText('scripts/generate-content.mjs'));
  const mappingHash = sha256(mappingText);
  const outputs = generate(mapping, source, sourceHash);
  const outputHashes = hashOutputs(outputs);
  const provenance = {
    version: 1,
    source: mapping.source,
    sourceSha256: sourceHash,
    sourceMap: SOURCE_MAP_PATH,
    sourceMapSha256: mappingHash,
    generator: 'scripts/generate-content.mjs',
    generatorSha256: generatorHash,
    generatedPages: PAGE_ALLOWLIST,
    outputSha256: outputHashes
  };
  provenance.provenanceSha256 = sha256(JSON.stringify(provenance));
  return { mapping, outputs, provenance, source };
}

function readProvenance() {
  const manifestPath = assertNoSymlinkPath(PROVENANCE_PATH);
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const provenance = JSON.parse(readText(PROVENANCE_PATH));
    const { provenanceSha256, ...unsigned } = provenance;
    if (!/^[a-f0-9]{64}$/.test(provenanceSha256 ?? '') ||
        provenanceSha256 !== sha256(JSON.stringify(unsigned))) {
      fail('Generated provenance was modified or has no valid integrity hash.');
    }
    return provenance;
  } catch (error) {
    fail(`Cannot trust existing generated provenance: ${error.message}`);
  }
}

function verifyBootstrap(mapping, outputs) {
  assertSafeGenerationPaths();
  for (const relativePath of PAGE_ALLOWLIST) {
    const target = assertNoSymlinkPath(relativePath);
    if (!fs.existsSync(target)) fail(`Bootstrap output missing: ${relativePath}`);
    const actual = sha256(fs.readFileSync(target));
    if (actual !== mapping.bootstrapOutputSha256[relativePath]) {
      fail(`Bootstrap output differs from recorded baseline; refusing overwrite: ${relativePath}`);
    }
  }
  if (!outputs.size) fail('No pages were generated.');
}

function verifyPreviousOutputs(previous) {
  assertSafeGenerationPaths();
  if (!previous || previous.version !== 1 || !previous.outputSha256) {
    fail('Existing generated provenance is invalid; refusing overwrite.');
  }
  if (JSON.stringify(previous.generatedPages) !== JSON.stringify(PAGE_ALLOWLIST) ||
      JSON.stringify(Object.keys(previous.outputSha256)) !== JSON.stringify(PAGE_ALLOWLIST)) {
    fail('Existing generated provenance does not match the output allowlist; refusing overwrite.');
  }
  for (const relativePath of PAGE_ALLOWLIST) {
    const expected = previous.outputSha256[relativePath];
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) {
      fail(`Generated provenance has no valid hash for ${relativePath}; refusing overwrite.`);
    }
    const target = assertNoSymlinkPath(relativePath);
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== expected) {
      fail(`Generated output was manually changed; refusing overwrite: ${relativePath}`);
    }
  }
}

function checkOutputs(outputs, provenance) {
  assertSafeGenerationPaths();
  if (fs.existsSync(assertNoSymlinkPath(TRANSACTION_PATH))) {
    fail(`Pending content-generation transaction journal found (${TRANSACTION_PATH}); run npm run generate:write to recover it before checking.`);
  }
  if (!provenance) fail('Generated provenance is missing; run npm run generate:write.');
  if (JSON.stringify(provenance.generatedPages) !== JSON.stringify(PAGE_ALLOWLIST) ||
      JSON.stringify(Object.keys(provenance.outputSha256 ?? {})) !== JSON.stringify(PAGE_ALLOWLIST)) {
    fail('Generated provenance does not cover the exact output allowlist.');
  }
  for (const [relativePath, expectedContent] of outputs) {
    const target = assertNoSymlinkPath(relativePath);
    if (!fs.existsSync(target)) fail(`Generated output is missing: ${relativePath}`);
    const actual = fs.readFileSync(target);
    if (sha256(actual) !== provenance.outputSha256?.[relativePath] ||
        !actual.equals(Buffer.from(expectedContent, 'utf8'))) {
      fail(`Generated output is stale or modified: ${relativePath}`);
    }
  }
  const actual = readProvenance();
  if (JSON.stringify(actual) !== JSON.stringify(provenance)) fail('Generated provenance is stale.');
  assertInputsUnchanged(provenance);
  console.log(`Verified ${outputs.size} generated page(s), source/map/generator hashes and provenance.`);
}

function syncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const unsupportedDirectorySync =
      ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(error.code) ||
      // Windows reports EPERM when directory handles cannot be opened for syncing.
      (process.platform === 'win32' && error.code === 'EPERM');
    // Ignore only known unsupported directory-sync errors; other I/O errors must surface.
    if (!unsupportedDirectorySync) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function expectedTargetState(relativePath, expectedContent) {
  const target = assertNoSymlinkPath(relativePath);
  const exists = fs.existsSync(target);
  if (expectedContent === undefined) {
    if (exists) fail(`Repository target changed during generation: ${relativePath}`);
  } else if (!exists || !fs.readFileSync(target).equals(expectedContent)) {
    fail(`Repository target changed during generation: ${relativePath}`);
  }
  return target;
}

function stagedSiblingPath(relativePath) {
  const directory = path.posix.dirname(relativePath);
  const basename = path.posix.basename(relativePath);
  const name = `${basename}.content-generation-${process.pid}-${randomUUID()}.tmp`;
  return directory === '.' ? name : `${directory}/${name}`;
}

function validateStagedSiblingPath(temporaryRelativePath, relativePath) {
  assertSafeRelativePath(temporaryRelativePath);
  const expectedDirectory = path.posix.dirname(relativePath);
  const expectedBasename = path.posix.basename(relativePath);
  const prefix = `${expectedBasename}.content-generation-`;
  const temporaryBasename = path.posix.basename(temporaryRelativePath);
  if (path.posix.dirname(temporaryRelativePath) !== expectedDirectory ||
      !temporaryBasename.startsWith(prefix) ||
      !/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/
        .test(temporaryBasename.slice(prefix.length))) {
    fail(`Invalid staged content path for ${relativePath}; refusing to modify it.`);
  }
}

function removeStagedTemporary(temporaryRelativePath, relativePath) {
  validateStagedSiblingPath(temporaryRelativePath, relativePath);
  const temporary = assertNoSymlinkPath(temporaryRelativePath);
  let stats;
  try {
    stats = fs.lstatSync(temporary);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    fail(`Cannot safely inspect staged content path ${temporaryRelativePath}: ${error.message}`);
  }
  if (!stats.isFile()) fail(`Staged content path is not a regular file: ${temporaryRelativePath}`);
  assertNoSymlinkPath(temporaryRelativePath);
  fs.rmSync(temporary);
  syncDirectory(path.dirname(temporary));
}

function atomicReplace(relativePath, content, expectedCurrent, temporaryRelativePath, retryStagedPath = false) {
  validateStagedSiblingPath(temporaryRelativePath, relativePath);
  let temporary;
  let temporaryCreated = false;
  try {
    assertCanonicalRoot();
    const target = expectedTargetState(relativePath, expectedCurrent);
    const mode = expectedCurrent === undefined ? 0o644 : fs.statSync(target).mode & 0o777;
    if (retryStagedPath) removeStagedTemporary(temporaryRelativePath, relativePath);
    temporary = assertNoSymlinkPath(temporaryRelativePath);
    const descriptor = fs.openSync(temporary, 'wx', mode);
    temporaryCreated = true;
    try {
      assertNoSymlinkPath(temporaryRelativePath);
      fs.writeFileSync(descriptor, content);
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, mode);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    assertCanonicalRoot();
    expectedTargetState(relativePath, expectedCurrent);
    temporary = assertNoSymlinkPath(temporaryRelativePath);
    fs.renameSync(temporary, assertNoSymlinkPath(relativePath));
    syncDirectory(path.dirname(resolveRepositoryPath(relativePath)));
  } catch (error) {
    if (temporary && temporaryCreated) {
      try {
        removeStagedTemporary(temporaryRelativePath, relativePath);
      } catch {
        // Preserve the original failure; unsafe cleanup is deliberately skipped.
      }
    }
    throw error;
  }
}

function syncCommittedOutputDirectories(journal) {
  const directories = new Set();
  for (const entry of journal.entries) {
    const target = assertNoSymlinkPath(entry.path);
    directories.add(path.dirname(target));
  }
  for (const directory of directories) syncDirectory(directory);
}

function readGenerationLock() {
  const lockPath = assertNoSymlinkPath(GENERATION_LOCK_PATH);
  let stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    fail(`Cannot safely inspect content-generation lock: ${error.message}`);
  }
  if (!stats.isFile()) fail('Content-generation lock is not a regular file; refusing to proceed.');
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    fail(`Cannot safely read content-generation lock: ${error.message}`);
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1 ||
      typeof lock.token !== 'string' || !/^[0-9a-f-]{36}$/.test(lock.token)) {
    fail('Content-generation lock is invalid; refusing to proceed.');
  }
  return lock;
}

function acquireGenerationLock() {
  assertCanonicalRoot();
  const lockPath = assertNoSymlinkPath(GENERATION_LOCK_PATH);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lock = { pid: process.pid, token: randomUUID() };
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      assertCanonicalRoot();
      fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(root);
      assertCanonicalRoot();
      return lock;
    } catch (error) {
      const cleanupErrors = [];
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch (closeError) {
          cleanupErrors.push(closeError);
        }
      }
      if (error.code !== 'EEXIST') {
        try {
          if (readGenerationLock()?.token === lock.token) {
            fs.unlinkSync(assertNoSymlinkPath(GENERATION_LOCK_PATH));
            syncDirectory(root);
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length > 0) throw lockCleanupError(error, cleanupErrors);
        throw error;
      }
      if (cleanupErrors.length > 0) throw lockCleanupError(error, cleanupErrors);
      const currentLock = readGenerationLock();
      if (!currentLock) continue;
      fail(`Content generation is locked by PID ${currentLock.pid}. Confirm no content-generation process is active, manually remove the exact lock file ${GENERATION_LOCK_PATH}, then rerun.`);
    }
  }
  fail('Could not acquire the content-generation lock safely; refusing to proceed.');
}

function releaseGenerationLock(lock) {
  const currentLock = readGenerationLock();
  if (!currentLock || currentLock.token !== lock.token) return;
  assertCanonicalRoot();
  fs.unlinkSync(assertNoSymlinkPath(GENERATION_LOCK_PATH));
  syncDirectory(root);
}

function withGenerationLock(action) {
  const lock = acquireGenerationLock();
  let actionFailed = false;
  let actionError;
  try {
    return action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
    throw error;
  } finally {
    try {
      releaseGenerationLock(lock);
    } catch (error) {
      const originalError = actionFailed
        ? actionError
        : new Error('Content generation completed, but releasing its lock failed.');
      throw lockCleanupError(originalError, [error]);
    }
  }
}

function persistJournal(journal) {
  assertSafeGenerationPaths();
  const temporary = resolveRepositoryPath(TRANSACTION_TEMP_PATH);
  const target = resolveRepositoryPath(TRANSACTION_PATH);
  assertCanonicalRoot();
  assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
  assertNoSymlinkPath(TRANSACTION_PATH);
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertCanonicalRoot();
  assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
  assertNoSymlinkPath(TRANSACTION_PATH);
  if (fs.existsSync(target)) fail(`Transaction journal appeared during generation: ${TRANSACTION_PATH}`);
  fs.renameSync(temporary, target);
  syncDirectory(root);
}

function markJournalCommitted(journal, onCommitted) {
  const temporary = assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
  const target = assertNoSymlinkPath(TRANSACTION_PATH);
  const committedJournal = { ...journal, committed: true };
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
    fs.writeFileSync(descriptor, `${JSON.stringify(committedJournal)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertCanonicalRoot();
  assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
  assertNoSymlinkPath(TRANSACTION_PATH);
  fs.renameSync(temporary, target);
  Object.assign(journal, committedJournal);
  onCommitted();
  syncDirectory(root);
}

function transactionEntries(outputs, provenance) {
  assertSafeGenerationPaths();
  const contents = new Map(outputs);
  contents.set(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
  return [...contents].map(([relativePath, content]) => {
    const target = assertNoSymlinkPath(relativePath);
    const exists = fs.existsSync(target);
    return {
      path: relativePath,
      existed: exists,
      previousContent: exists ? fs.readFileSync(target).toString('base64') : null,
      nextContent: Buffer.from(content, 'utf8').toString('base64'),
      stagedPath: stagedSiblingPath(relativePath)
    };
  });
}

function loadJournal() {
  assertSafeGenerationPaths();
  const journalPath = assertNoSymlinkPath(TRANSACTION_PATH);
  if (!fs.existsSync(journalPath)) return undefined;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    fail(`Cannot read pending content-generation transaction journal: ${error.message}`);
  }
  const allowedPaths = new Set([...PAGE_ALLOWLIST, PROVENANCE_PATH]);
  if (journal?.version !== 2 ||
      (journal.committed !== undefined && typeof journal.committed !== 'boolean') ||
      !Array.isArray(journal.entries) ||
      journal.entries.length !== allowedPaths.size ||
      journal.entries.some(entry => !allowedPaths.has(entry.path) ||
        typeof entry.existed !== 'boolean' ||
        (entry.existed ? typeof entry.previousContent !== 'string' : entry.previousContent !== null) ||
        typeof entry.nextContent !== 'string' ||
        typeof entry.stagedPath !== 'string' ||
        (() => {
          try {
            validateStagedSiblingPath(entry.stagedPath, entry.path);
            return false;
          } catch {
            return true;
          }
        })() ||
        (entry.existed && Buffer.from(entry.previousContent, 'base64').toString('base64') !== entry.previousContent) ||
        Buffer.from(entry.nextContent, 'base64').toString('base64') !== entry.nextContent) ||
      new Set(journal.entries.map(entry => entry.path)).size !== allowedPaths.size ||
      new Set(journal.entries.map(entry => entry.stagedPath)).size !== allowedPaths.size) {
    fail('Pending content-generation transaction journal is invalid; refusing recovery.');
  }
  return journal;
}

function rollbackJournal(journal) {
  assertSafeGenerationPaths();
  for (const entry of journal.entries) {
    const target = assertNoSymlinkPath(entry.path);
    const exists = fs.existsSync(target);
    const previousContent = entry.existed ? Buffer.from(entry.previousContent, 'base64') : undefined;
    const nextContent = Buffer.from(entry.nextContent, 'base64');
    if (entry.existed && !exists) {
      fail(`Generated output disappeared during an interrupted transaction; refusing recovery: ${entry.path}`);
    }
    if (exists) {
      const currentContent = fs.readFileSync(target);
      if ((!entry.existed || !currentContent.equals(previousContent)) && !currentContent.equals(nextContent)) {
        fail(`Generated output was manually changed during an interrupted transaction; refusing recovery: ${entry.path}`);
      }
    }
  }
  for (const entry of journal.entries) {
    assertSafeGenerationPaths();
    const target = assertNoSymlinkPath(entry.path);
    if (entry.existed) {
      const previousContent = Buffer.from(entry.previousContent, 'base64');
      const nextContent = Buffer.from(entry.nextContent, 'base64');
      if (!fs.readFileSync(target).equals(previousContent)) {
        atomicReplace(entry.path, previousContent, nextContent, entry.stagedPath, true);
      }
    } else if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(Buffer.from(entry.nextContent, 'base64'))) {
        fail(`Generated output was manually changed during an interrupted transaction; refusing recovery: ${entry.path}`);
      }
      assertCanonicalRoot();
      assertNoSymlinkPath(entry.path);
      fs.rmSync(target);
      syncDirectory(path.dirname(target));
    }
  }
  for (const entry of journal.entries) {
    removeStagedTemporary(entry.stagedPath, entry.path);
  }
  assertCanonicalRoot();
  syncDirectory(root);
  assertSafeGenerationPaths();
  fs.rmSync(assertNoSymlinkPath(TRANSACTION_PATH), { force: true });
  fs.rmSync(assertNoSymlinkPath(TRANSACTION_TEMP_PATH), { force: true });
  syncDirectory(root);
}

function cleanupCommittedJournal() {
  assertSafeGenerationPaths();
  for (const entry of loadJournal().entries) {
    removeStagedTemporary(entry.stagedPath, entry.path);
  }
  assertCanonicalRoot();
  fs.rmSync(assertNoSymlinkPath(TRANSACTION_PATH), { force: true });
  fs.rmSync(assertNoSymlinkPath(TRANSACTION_TEMP_PATH), { force: true });
  syncDirectory(root);
}

function recoverPendingTransaction() {
  assertSafeGenerationPaths();
  const journal = loadJournal();
  const temporary = assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
  let temporaryStats;
  try {
    temporaryStats = fs.lstatSync(temporary);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fail(`Cannot safely inspect transaction journal temporary path: ${error.message}`);
    }
  }
  if (temporaryStats) {
    assertCanonicalRoot();
    assertNoSymlinkPath(TRANSACTION_TEMP_PATH);
    if (!temporaryStats.isFile()) {
      fail(`Transaction journal temporary path is not a regular file: ${TRANSACTION_TEMP_PATH}`);
    }
    fs.rmSync(temporary);
    syncDirectory(root);
  }
  if (!journal) return;
  if (journal.committed) {
    try {
      cleanupCommittedJournal();
    } catch (error) {
      fail(`Generated outputs are committed, but transaction journal cleanup/durability is uncertain (${error.message}).`);
    }
    console.log('Recovered committed content-generation transaction journal.');
    return;
  }
  rollbackJournal(journal);
  console.log('Recovered and rolled back pending content-generation transaction.');
}

function writeOutputs(mapping, outputs, provenance, previous) {
  assertSafeGenerationPaths();
  if (previous) verifyPreviousOutputs(previous);
  else verifyBootstrap(mapping, outputs);
  const journal = { version: 2, entries: transactionEntries(outputs, provenance) };
  persistJournal(journal);
  try {
    for (const entry of journal.entries) {
      assertInputsUnchanged(provenance);
      const previousContent = entry.existed ? Buffer.from(entry.previousContent, 'base64') : undefined;
      atomicReplace(entry.path, Buffer.from(entry.nextContent, 'base64'), previousContent, entry.stagedPath);
    }
    assertInputsUnchanged(provenance);
    syncCommittedOutputDirectories(journal);
    assertSafeGenerationPaths();
  } catch (error) {
    try {
      rollbackJournal(journal);
    } catch (rollbackError) {
      fail(`Content write failed (${error.message}) and rollback was incomplete (${rollbackError.message}); the transaction journal was retained for recovery.`);
    }
    throw error;
  }
  let committed = false;
  try {
    markJournalCommitted(journal, () => { committed = true; });
  } catch (error) {
    if (!committed) {
      try {
        rollbackJournal(journal);
      } catch (rollbackError) {
        fail(`Content commit marking failed (${error.message}) and rollback was incomplete (${rollbackError.message}); the transaction journal was retained for recovery.`);
      }
      throw error;
    }
    fail(`Generated outputs are committed, but transaction journal cleanup/durability is uncertain (${error.message}).`);
  }
  try {
    fs.rmSync(assertNoSymlinkPath(TRANSACTION_PATH));
    syncDirectory(root);
  } catch (error) {
    fail(`Generated outputs are committed, but transaction journal cleanup/durability is uncertain (${error.message}).`);
  }
  console.log(`Wrote ${outputs.size} generated page(s) and ${PROVENANCE_PATH}.`);
}

function assertInputsUnchanged(provenance) {
  for (const [relativePath, expectedHash] of [
    [SOURCE_PATH, provenance.sourceSha256],
    [SOURCE_MAP_PATH, provenance.sourceMapSha256],
    [provenance.generator, provenance.generatorSha256]
  ]) {
    const target = assertNoSymlinkPath(relativePath);
    if (sha256(normalizeText(fs.readFileSync(target, 'utf8'))) !== expectedHash) {
      fail(`Workspace input changed during generation; refusing to continue: ${relativePath}`);
    }
  }
}

async function main() {
  const mode = process.argv[2];
  if (!['--validate-source', '--check', '--write'].includes(mode) || process.argv.length !== 3) {
    fail('Usage: node scripts/generate-content.mjs --validate-source|--check|--write');
  }
  assertSafeGenerationPaths();
  if (mode === '--validate-source') {
    const { mapping, outputs } = load();
    console.log(`Validated canonical source ${mapping.source} and ${outputs.size} mapped pages.`);
    return;
  }
  return withGenerationLock(() => {
    assertSafeGenerationPaths();
    if (mode === '--check' && fs.existsSync(assertNoSymlinkPath(TRANSACTION_PATH))) {
      fail(`Pending content-generation transaction journal found (${TRANSACTION_PATH}); run npm run generate:write to recover it before checking.`);
    }
    if (mode === '--write') recoverPendingTransaction();
    const { mapping, outputs, provenance } = load();
    const previous = readProvenance();
    if (mode === '--check') return checkOutputs(outputs, previous);
    writeOutputs(mapping, outputs, provenance, previous);
  });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
