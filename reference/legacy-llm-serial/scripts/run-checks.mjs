import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveEvidenceOutput } from './rust-advisory-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const logArg = args.indexOf('--log-dir');
const logInput = path.resolve(root, logArg >= 0 ? args[logArg + 1] : `output/checks/${Date.now()}-${process.pid}`);
const logDir = resolveEvidenceOutput(path.relative(root, logInput).split(path.sep).join('/'), root);
fs.mkdirSync(logDir, { recursive: true });
const frontendOnly = args.includes('--frontend-only');
const commands = [
  ['evidenceTools', 'npm run test:evidence'],
  ['transport', 'npm run test:transport'],
  ['widgetAndReplay', 'npm run test:widget'],
  ['tuning', 'npm run test:tuning'],
  ['writeQuiescence', 'npm run test:write-queue'],
  ...frontendOnly ? [] : [
    ['rust', 'cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast'],
    ['npmAudit', 'npm audit --audit-level=high --json'],
  ],
];
if (!frontendOnly && (process.env.LLM_SERIAL_AUDIT_TOOL || process.env.LLM_SERIAL_AUDIT_DB)) {
  const relativeLogs = path.relative(root, logDir).split(path.sep).join('/');
  if (!relativeLogs.startsWith('output/') || relativeLogs.split('/').includes('..')) throw new Error('Advisory evidence logs must stay under output/.');
  commands.push(['rustAdvisories', ['node', 'scripts/rust-advisory-audit.mjs', '--output', `${relativeLogs}/rust-advisories`]]);
}
const checks = {};
for (const [name, command] of commands) {
  console.log(`\n[check] ${name}: ${command}`);
  const log = fs.createWriteStream(path.join(logDir, `${name}.log`));
  const started = Date.now();
  const child = Array.isArray(command)
    ? spawn(command[0], command.slice(1), { cwd: root, shell: false, windowsHide: true })
    : spawn(command, { cwd: root, shell: true, windowsHide: true });
  child.stdout.on('data', chunk => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on('data', chunk => { process.stderr.write(chunk); log.write(chunk); });
  const exitCode = await new Promise(resolve => {
    child.on('error', error => { log.write(String(error)); resolve(-1); });
    child.on('close', code => resolve(code ?? -1));
  });
  await new Promise(resolve => log.end(resolve));
  checks[name] = { status: exitCode === 0 ? 'passed' : 'failed', exitCode, elapsedMs: Date.now() - started, log: `${name}.log` };
  fs.writeFileSync(path.join(logDir, 'checks.json'), `${JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2)}\n`);
  if (exitCode !== 0) {
    console.error(`检查失败，停止后续步骤。证据目录: ${logDir}`);
    process.exit(1);
  }
}
console.log(`\n检查完成。证据目录: ${logDir}`);
