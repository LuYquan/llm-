import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const logArg = args.indexOf('--log-dir');
const logDir = path.resolve(root, logArg >= 0 ? args[logArg + 1] : `output/checks/${Date.now()}-${process.pid}`);
fs.mkdirSync(logDir, { recursive: true });
const frontendOnly = args.includes('--frontend-only');
const commands = [
  ['transport', 'npm run test:transport'],
  ['widgetAndReplay', 'npm run test:widget'],
  ['tuning', 'npm run test:tuning'],
  ...frontendOnly ? [] : [
    ['rust', 'cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast'],
    ['npmAudit', 'npm audit --audit-level=high --json'],
  ],
];
const checks = {};
for (const [name, command] of commands) {
  console.log(`\n[check] ${name}: ${command}`);
  const log = fs.createWriteStream(path.join(logDir, `${name}.log`));
  const started = Date.now();
  const child = spawn(command, { cwd: root, shell: true, windowsHide: true });
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
