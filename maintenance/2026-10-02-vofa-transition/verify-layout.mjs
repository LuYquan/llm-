import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const recordRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(recordRoot, '../..');
const recordFile = path.join(recordRoot, 'final-verification.json');
const readJson = name => JSON.parse(fs.readFileSync(path.join(recordRoot, name), 'utf8'));
const resolveLocal = relative => {
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw new Error(`Outside workspace: ${relative}`);
  return full;
};
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex').toUpperCase();
}
const result = { status: 'running', checkedAt: new Date().toISOString(), preservedFiles: 0, preservedBytes: 0, localLinks: 0, errors: [] };
fs.writeFileSync(recordFile, JSON.stringify(result, null, 2) + '\n');
const manifest = readJson('preserved-files.json');
for (const row of manifest) {
  const file = resolveLocal(row.Archived);
  if (!fs.existsSync(file) || fs.statSync(file).size !== row.Bytes || await hashFile(file) !== row.Sha256) result.errors.push(`Preserved file mismatch: ${row.Archived}`);
  result.preservedFiles++;
  result.preservedBytes += row.Bytes;
}
const deleted = readJson('deleted-caches.json');
for (const row of deleted) if (fs.existsSync(resolveLocal(row.DeletedPath))) result.errors.push(`Cache still exists: ${row.DeletedPath}`);
result.deletedTargets = deleted.length;
result.deletedFiles = deleted.reduce((n, row) => n + row.Files, 0);
result.deletedLogicalBytes = deleted.reduce((n, row) => n + row.Bytes, 0);
for (const relative of ['package.json', 'src', 'src-tauri', 'scripts', 'tests', '.github/workflows', '启动软件.bat', '一键更新构建.bat']) {
  if (fs.existsSync(resolveLocal(relative))) result.errors.push(`Old active root entry remains: ${relative}`);
}
for (const relative of ['.git', '.agents', '.codegraph', 'reference/legacy-llm-serial/package.json', 'reference/legacy-llm-serial/.github/workflows/checks.yml']) {
  if (!fs.existsSync(resolveLocal(relative))) result.errors.push(`Required preserved entry missing: ${relative}`);
}
const documents = ['AGENTS.md','README.md','PRODUCT.md','DESIGN.md','CONTEXT.md','CONTRIBUTING.md','GEMINI.md','docs/README.md','docs/DEVELOPMENT_PREPARATION.md','docs/HANDOFF.md','reference/README.md','reference/REUSE_MAP.md','maintenance/2026-10-02-vofa-transition/REPORT.md'];
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const relative of documents) {
  const file = resolveLocal(relative);
  const content = decoder.decode(fs.readFileSync(file));
  if (content.includes('\uFFFD')) result.errors.push(`Replacement character in document: ${relative}`);
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const link = path.resolve(path.dirname(file), decodeURIComponent(target.split('#')[0]));
    if (!link.startsWith(root + path.sep) || !fs.existsSync(link)) result.errors.push(`Broken local link in ${relative}: ${target}`);
    result.localLinks++;
  }
}
result.documents = documents.length;
result.gitHeadBefore = readJson('git-before.json').Head;
const git = args => execFileSync('git', ['-c', `core.excludesFile=${path.join(recordRoot, 'empty-git-excludes')}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
result.gitHeadAfter = git(['rev-parse', 'HEAD']).trim();
result.gitHeadUnchanged = result.gitHeadAfter === result.gitHeadBefore;
// HEAD can advance after the user requests a commit; hashes above verify preserved files independently.
try { git(['diff', '--check']); result.diffCheckPassed = true; }
catch { result.diffCheckPassed = false; result.errors.push('Git diff whitespace check failed.'); }
const localOnly = ['.agents/', '.codegraph/codegraph.db', 'reference/legacy-llm-serial/release/data/config.json', 'reference/legacy-llm-serial/output/product-redesign-20260930/artifact-verification.json', 'reference/retained-build-artifacts/dist-staging/releases/llm-serial-v0.1.0-20260930T004509137Z-85484-32804e0e-windows-x64-portable.zip', 'maintenance/2026-10-02-vofa-transition/preserved-files.json'];
try {
  const ignored = git(['check-ignore', '--', ...localOnly]).trim().split(/\r?\n/);
  result.ignoreAssertionsPassed = localOnly.every(file => ignored.includes(file));
} catch { result.ignoreAssertionsPassed = false; }
if (!result.ignoreAssertionsPassed) result.errors.push('Local-only archive material is not fully ignored.');
result.archiveVerification = readJson('archive-verification.json').Status;
result.cleanupVerification = readJson('cleanup-verification.json').Status;
result.status = result.errors.length ? 'failed' : 'passed';
fs.writeFileSync(recordFile, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) process.exitCode = 1;
