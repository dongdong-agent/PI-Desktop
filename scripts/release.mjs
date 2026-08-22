#!/usr/bin/env node
/**
 * 一键发布脚本：构建安装包 → 提交版本号 → 创建 GitHub Release → 上传 setup.exe。
 * 用法（项目根目录）：
 *   node scripts/release.mjs [版本号]     # 版本号如 0.7.0；缺省读 package.json
 * 前置：
 *   - gh 已登录（或 GH_TOKEN 环境变量）
 *   - git 已推送 main
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

const versionArg = process.argv[2];
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = versionArg ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`无效版本号: ${version}`);
  process.exit(1);
}

console.log(`\n=== PI Agent 发布 v${version} ===\n`);

// 0) 检查 gh
try {
  run("gh --version", { stdio: "pipe" });
} catch {
  console.error("需要 gh CLI（https://cli.github.com）");
  process.exit(1);
}

// 1) 构建
console.log("[1/6] tauri build…");
run("npx tauri build");

// 2) 确认产物
const setup = path.join(root, "src-tauri/target/release/bundle/nsis", `PI Agent_${version}_x64-setup.exe`);
if (!existsSync(setup)) {
  console.error(`找不到安装包: ${setup}`);
  process.exit(1);
}

// 3) 提交版本号（若已是最新则跳过）
console.log("[2/6] git 提交版本号…");
try {
  run('git add package.json src-tauri/tauri.conf.json && git commit -m "v' + version + ' 版本号"', { stdio: "inherit" });
} catch {
  console.log("（无版本号改动或已提交）");
}
try {
  run('git push origin main');
} catch {
  console.warn("（推送失败，继续发布）");
}

// 4) 创建/复用 Release
console.log("[3/6] 创建 GitHub Release（draft）…");
let releaseJson;
try {
  releaseJson = run(`gh release create v${version} --draft --title "PI Agent v${version}" --notes "PI Agent v${version}" --json id,uploadUrl --jq .`, {
    encoding: "utf8",
  }).trim();
} catch {
  console.log("release 可能已存在，尝试复用…");
  releaseJson = run(`gh release view v${version} --json id,uploadUrl --jq .`, { encoding: "utf8" }).trim();
}

// 5) 上传 setup.exe（可能较慢，重试几次）
console.log("[4/6] 上传安装包（可能需 1-3 分钟）…");
const assetName = `PI-Agent_${version}_x64-setup.exe`;
run(`gh release upload v${version} --clobber --repo dongdong-agent/PI-Desktop "${setup.replace(/\//g, "\\\\")}"`);

// 6) 转正式 + 写 release notes
console.log("[5/6] 转正式…");
const notes = `## PI Agent 桌面端 v${version}

基于终端 PI（@earendil-works/pi-coding-agent）同内核的桌面编程助手。

### 安装
下载 \`${assetName}\`

### 更新日志
详见 GitHub 提交记录：https://github.com/dongdong-agent/PI-Desktop/commits/main`;
run(`gh release edit v${version} --draft=false --title "PI Agent v${version}" --notes "${notes.replace(/"/g, '\\"')}"`);

console.log("\n[6/6] ✅ 发布完成: https://github.com/dongdong-agent/PI-Desktop/releases/tag/v" + version);
