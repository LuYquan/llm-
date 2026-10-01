import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyBoundAuditEvidence } from './rust-advisory-audit.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const version = String(packageJson.version || '0.0.0');
const args = process.argv.slice(2);
const forceRebuild = !args.includes('--skip-build');
const checkStatus = forceRebuild ? 'passed' : 'not-run (--skip-build)';
const beta = args.includes('--beta');
const formalRelease = args.includes('--release');
if (beta && !forceRebuild) throw new Error('Beta 构建必须重新验证和编译，不能使用 --skip-build。');
if (formalRelease && (beta || !forceRebuild)) throw new Error('正式发行必须完整构建，不能同时使用 --beta 或 --skip-build。');
if (formalRelease) {
  // These checks currently fail while owner/dependency review is pending.
  // A test package cannot waive the publication gates.
  runRequired('正式发行许可证据门槛', 'npm run check:license');
  runRequired('正式发行 Rust 公告门槛', 'npm run check:advisories:strict');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').toUpperCase();
}

function runRequired(label, command, cwd = projectRoot) {
  console.log(`\n[check] ${label}`);
  execSync(command, { cwd, stdio: 'inherit', windowsHide: true });
}

function snapshotSources() {
  const files = {};
  const collect = (relative) => {
    const absolute = path.join(projectRoot, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (['target', 'node_modules', '.git', 'data', 'output'].includes(name)) continue;
        collect(path.join(relative, name));
      }
    } else files[relative.split(path.sep).join('/')] = sha256(absolute);
  };
  // Explicit source roots exclude previous Cargo staging trees and generated
  // schemas, even when those directories live below src-tauri/.
  for (const relative of ['src', 'src-tauri/src', 'src-tauri/tests', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'tests', 'scripts', 'docs', '.github', 'README.md', 'PRODUCT.md', 'DESIGN.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'index.html']) collect(relative);
  return { files, sha256: sha256Text(JSON.stringify(files)) };
}

const commit = (() => {
  try { return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
  catch { return 'unavailable'; }
})();
const buildId = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-${commit.slice(0, 8)}`;
const evidenceDir = path.join(projectRoot, 'output', 'builds', buildId);
const frontendDirectory = path.join(evidenceDir, 'frontend');
fs.mkdirSync(evidenceDir, { recursive: true });
const sourceBefore = snapshotSources();
fs.writeFileSync(path.join(evidenceDir, 'source-inputs.json'), `${JSON.stringify(sourceBefore, null, 2)}\n`);
const previousRelease = path.join(projectRoot, 'release', 'LLM串口.exe');
const previousReleaseHash = fs.existsSync(previousRelease) ? sha256(previousRelease) : null;

console.log('====================================================');
console.log(`🚀 开始构建《LLM串口》最新可执行程序 (v${version})`);
console.log('====================================================');

// 1. 编译前端与 Tauri 后端 (默认每次全量重新编译以确保包含最新代码修改)
if (forceRebuild) {
  const checkDir = path.relative(projectRoot, path.join(evidenceDir, 'checks')).split(path.sep).join('/');
  runRequired('发行前检查与留证', `node scripts/run-checks.mjs --log-dir ${checkDir}`);
  console.log('\n[1/5] 编译前端与构建 Tauri 桌面程序...');
  // Compile directly into this run's evidence directory. Tauri resolves the
  // relative frontend path from src-tauri, preserving existing dist/releases.
  const configFile = path.join(evidenceDir, 'tauri-override.json');
  fs.writeFileSync(configFile, JSON.stringify({ build: { frontendDist: path.relative(path.join(projectRoot, 'src-tauri'), frontendDirectory).split(path.sep).join('/') } }, null, 2));
  const configRelative = path.relative(projectRoot, configFile).split(path.sep).join('/');
  const buildCommand = `npm run tauri -- build --ci ${beta ? '--no-bundle' : ''} --config ${configRelative}`;
  const buildResult = spawnSync(buildCommand, { cwd: projectRoot, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LLM_SERIAL_BUILD_ID: buildId, LLM_SERIAL_FRONTEND_DIR: frontendDirectory } });
  const buildOutput = `${buildResult.stdout || ''}\n${buildResult.stderr || ''}`;
  fs.writeFileSync(path.join(evidenceDir, 'native-build.log'), buildOutput);
  console.log(buildOutput);
  if (buildResult.error || buildResult.status !== 0) throw new Error(`原生构建失败: ${buildResult.error || buildResult.status}`);
  if (snapshotSources().sha256 !== sourceBefore.sha256) throw new Error('构建期间源码变化，拒绝把该程序标记为已验证发行包。');
  if (previousReleaseHash && sha256(previousRelease) !== previousReleaseHash) throw new Error('旧发布程序哈希变化，停止打包。');
} else {
  console.log('\n[跳过编译] 检测到 --skip-build 参数，直接打包现有二进制。');
}

// 2. 定位生成的最新 release 可执行程序。允许调用方通过
// CARGO_TARGET_DIR 指向独立 staging 目录，避免验证构建触碰用户发布目录。
const configuredCargoTargetDir = process.env.CARGO_TARGET_DIR;
const cargoTargetRoot = configuredCargoTargetDir
  ? (path.isAbsolute(configuredCargoTargetDir)
    ? configuredCargoTargetDir
    : path.resolve(projectRoot, 'src-tauri', configuredCargoTargetDir))
  : path.join(projectRoot, 'src-tauri', 'target');
const cargoReleaseRoot = path.join(cargoTargetRoot, 'release');
const customTargetCandidates = [
  path.join(cargoReleaseRoot, 'llm-serial.exe'),
  path.join(cargoReleaseRoot, 'LLM串口.exe'),
];
const defaultTargetCandidates = [
  path.join(projectRoot, 'src-tauri/target/release/llm-serial.exe'),
  path.join(projectRoot, 'src-tauri/target/release/LLM串口.exe'),
];
// A custom staging target must fail closed; never fall back to an older EXE
// from the project's ordinary target directory.
const candidates = configuredCargoTargetDir ? customTargetCandidates : defaultTargetCandidates;

let releaseExe = candidates.find((p) => fs.existsSync(p));

if (!releaseExe) {
  console.error('\n❌ 错误: 未找到 release 二进制文件，请确认编译是否成功。');
  process.exit(1);
}

const exeStat = fs.statSync(releaseExe);
const buildMarker = `llm-serial-build:${buildId}`;
if (forceRebuild && !fs.readFileSync(releaseExe).includes(Buffer.from(buildMarker, 'utf8'))) {
  throw new Error('EXE 缺少本轮构建标识，拒绝把复用的旧程序作为新发行。');
}
const frontendIndex = path.join(frontendDirectory, 'index.html');
if (forceRebuild && !fs.readFileSync(frontendIndex, 'utf8').includes(`content="${buildId}"`)) {
  throw new Error('前端缺少本轮构建标识，停止打包。');
}
const exeSizeMB = (exeStat.size / (1024 * 1024)).toFixed(2);
console.log(`\n[3/5] 最新二进制就绪: ${releaseExe}`);
console.log(`      文件大小: ${exeSizeMB} MB, 修改时间: ${exeStat.mtime.toLocaleString()}`);

// 3. 每次构建写入独立目录；不覆盖 release/ 中已有的用户可用程序，
// 也不把运行时 data/、密钥或真实设备记录打进发布包。
// Keep versioned release artifacts outside Vite's `dist/` output directory;
// a later frontend build clears `dist/` before writing its assets.
const portableRoot = path.join(projectRoot, 'output', 'releases');
const portableDir = path.join(portableRoot, `llm-serial-v${version}-${buildId}`);
fs.mkdirSync(portableDir, { recursive: true });

// 4. 同步分发二进制与便携标记
const readmeContent = `============================================================
              LLM串口 - 可靠串口与波形工作台
                测试发行版 (v${version})
============================================================

【使用说明】
1. 双击 "LLM串口.exe" 即可启动本次构建。
2. 先解压到有写入权限的本地目录。保留 portable.flag；运行后会在同目录创建 data/ 保存配置、日志和记录。本包不包含已有用户数据。
3. 暂无设备时，点击“演示”验证波形、记录与回放。演示数据不代表设备测量。
4. AI 辅助在串口工作台内选择平衡车、飞控或自定义场景。模型计算可离线使用；设备实验需要完整约束、停止命令、设备确认和本次授权。演示数据源不提供真实对象调参。手动发送需核对字节。
5. 软件停止仅锁定发送并可排队配置的停止命令，不保证设备停机；不能替代硬件急停。
6. 本包未签名。硬件串口、拔插、设备 ACK、真实云端 AI 与纯净系统兼容性尚待验收。

【系统依赖】
- 目标系统: 64 位 Windows 10 / Windows 11（纯净系统尚待兼容性验收）
- 依赖: Microsoft Edge WebView2 Runtime；若本机未安装，请从 Microsoft 官方页面安装后启动。
- 提交问题时请提供版本、复现步骤和脱敏日志；不要发送 API Key。
`;

const targetExeB = path.join(portableDir, 'LLM串口.exe');
fs.copyFileSync(releaseExe, targetExeB);
fs.writeFileSync(path.join(portableDir, 'portable.flag'), 'llm-serial-portable', 'utf-8');
fs.writeFileSync(path.join(portableDir, 'README.txt'), readmeContent, 'utf-8');

// Existing release/ and dist/portable/ belong to previous deliveries. A test
// build only publishes into the unique output/releases directory above.
if (previousReleaseHash && sha256(previousRelease) !== previousReleaseHash) {
  throw new Error('旧发布程序哈希变化，拒绝完成本轮打包。');
}

let sourceDirty = false;
let sourceStatus = '';
try {
  sourceStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'src-tauri/src', 'src-tauri/tests', 'src-tauri/icons', 'src-tauri/capabilities', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'tests', 'scripts', 'docs', '.github', 'README.md', 'PRODUCT.md', 'DESIGN.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'index.html', '.gitignore', '.gitattributes'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  sourceDirty = Boolean(sourceStatus.trim());
} catch {
  sourceDirty = true;
}
const dependencyLockfiles = Object.fromEntries(
  ['package-lock.json', 'src-tauri/Cargo.lock']
    .filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)))
    .map((relativePath) => [relativePath, sha256(path.join(projectRoot, relativePath))]),
);
const advisorySummaryPath = path.join(evidenceDir, 'checks', 'rust-advisories', 'summary.json');
const rustAdvisoryAudit = fs.existsSync(advisorySummaryPath)
  ? verifyBoundAuditEvidence(path.dirname(advisorySummaryPath), dependencyLockfiles['src-tauri/Cargo.lock'])
  : { status: 'not-run', limits: ['Set LLM_SERIAL_AUDIT_TOOL and LLM_SERIAL_AUDIT_DB to bind a pinned scan to this build.'] };
const manifest = {
  formatVersion: 2,
  product: 'LLM 串口可靠串口与波形工作台',
  version,
  buildId,
  buildTime: new Date().toISOString(),
  gitCommit: commit,
  sourceDirty,
  sourceStatusSha256: sha256Text(sourceStatus),
  sourceInputsSha256: sourceBefore.sha256,
  sourceInputCount: Object.keys(sourceBefore.files).length,
  embeddedBuildMarker: forceRebuild ? buildMarker : null,
  frontendDirectory: forceRebuild ? path.relative(projectRoot, frontendDirectory).split(path.sep).join('/') : null,
  frontendIndexSha256: forceRebuild ? sha256(frontendIndex) : null,
  buildEvidence: path.relative(projectRoot, evidenceDir).split(path.sep).join('/'),
  previousReleasePreserved: !previousReleaseHash || sha256(previousRelease) === previousReleaseHash,
  dependencyLockfiles,
  buildScriptSha256: sha256(__filename),
  zipHelperSha256: sha256(path.join(__dirname, 'create-portable-zip.ps1')),
  cargoTargetDir: path.relative(projectRoot, cargoTargetRoot).split(path.sep).join('/'),
  executable: {
    file: 'LLM串口.exe',
    bytes: fs.statSync(targetExeB).size,
    sha256: sha256(targetExeB),
  },
  checks: {
    evidenceTools: checkStatus,
    transport: checkStatus,
    widgetAndReplay: checkStatus,
    tuning: checkStatus,
    rust: checkStatus,
    frontendBuild: checkStatus,
    nativeBuild: checkStatus,
    npmAudit: checkStatus,
  },
  rustAdvisoryAudit,
  licenseReview: 'pending-owner-decision-and-dependency-review',
  validationLimits: ['No hardware serial/unplug/ACK validation', 'No live cloud AI request validation', 'No clean Windows compatibility validation', 'Full native interactive acceptance pending', 'Tuning execution requires configured device protocol and explicit per-session authorization', ...(rustAdvisoryAudit.status === 'not-run' ? ['Rust dependency advisory audit not bound to this build'] : ['Rust advisory findings and scope are recorded separately; no blanket dependency approval']), 'Product and dependency licensing review pending'],
  userDataIncluded: false,
  signature: 'unsigned test distribution',
};
fs.writeFileSync(path.join(portableDir, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\n[4/5] 已写入独立构建目录:`);
console.log(`      📁 目录: ${portableDir}`);
console.log(`      📁 程序: ${targetExeB}`);

// 5. 生成便携 Zip 压缩包
const zipPath = path.join(portableRoot, `llm-serial-v${version}-${buildId}-windows-x64-portable.zip`);

try {
  if (fs.existsSync(zipPath)) throw new Error(`拒绝覆盖已有便携包: ${zipPath}`);
  if (process.platform === 'win32') {
    // Use .NET ZipArchive with explicit UTF-8 entry names so Chinese file
    // names survive in Windows portable ZIPs.
    execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'create-portable-zip.ps1'),
      '-SourceDirectory',
      portableDir,
      '-ZipPath',
      zipPath,
    ], {
      stdio: 'inherit',
      windowsHide: true,
    });
  } else {
    execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', portableDir, '.'], {
      stdio: 'inherit',
      windowsHide: true,
    });
  }
  if (!fs.existsSync(zipPath)) throw new Error('归档工具未生成输出文件');
  if (fs.statSync(zipPath).size === 0) throw new Error('ZIP 文件为空');
  fs.writeFileSync(`${zipPath}.sha256`, `${sha256(zipPath)}  ${path.basename(zipPath)}\n`, 'utf8');
  fs.writeFileSync(path.join(evidenceDir, 'artifact.json'), `${JSON.stringify({ portableDir, executable: targetExeB, zipPath, zipSha256: sha256(zipPath), manifest }, null, 2)}\n`);
  console.log(`\n[5/5] 便携压缩包已就位: ${zipPath}`);
} catch (e) {
  console.error(`\n❌ Zip 压缩失败，发布视为失败: ${e?.message || e}`);
  process.exit(1);
}

console.log('\n====================================================');
console.log('🎉 发布包已生成，并保留为独立、可核对的构建目录。');
console.log(`👉 可执行文件: ${targetExeB}`);
console.log('====================================================\n');
