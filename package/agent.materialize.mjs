#!/usr/bin/env node
/**
 * 业务初始化脚本（平台物化必带文件，package/tool 资产缺它 = 物化失败）。
 *
 * 平台物化流程：git clone → 清单形状校验 → npm ci（有 package.json 时）
 *   → 执行本脚本（`node agent.materialize.mjs`，cwd = 资产根，env 仅 PATH/HOME/NPM_CONFIG_REGISTRY，超时 10 分钟）
 *   → 产物校验（agent-package.json 的 programs 每条路径必须真实存在）。
 * 平台不传参、不理解构建过程，只验收产物；本脚本的职责 = 完成本仓库的一切初始化
 * （转译/构建/codegen/资源下载等），跑完后 programs 声明的产物必须就位。
 *
 * 默认实现：esbuild 转译 src/** 的 .ts/.js → dist/（ESM / node24 / sourcemap，逐文件不 bundle、
 * 保持目录结构——native 模块、动态 require、__dirname 资源因此正常），与 `npm run build`（tsc）同产物布局。
 * esbuild 用本仓库自己的 devDependency（平台已先跑 npm ci）；简单项目原样可用，复杂项目自行改写本脚本。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = "src";
const OUT_DIR = "dist";

/** 递归收集 src 下全部 .ts/.js 文件 */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(rel));
    } else if (/\.(ts|js)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = collect(SRC_DIR);
if (files.length === 0) {
  console.error("初始化失败：src/ 下没有可转译的 .ts/.js 文件");
  process.exit(1);
}

rmSync(OUT_DIR, { recursive: true, force: true });
// --outbase=src 保持目录结构：src/programs/main.ts → dist/programs/main.js
execFileSync(
  join("node_modules", ".bin", "esbuild"),
  [
    ...files,
    `--outdir=${OUT_DIR}`,
    "--outbase=src",
    "--format=esm",
    "--platform=node",
    "--target=node24",
    "--sourcemap",
    "--log-level=error",
  ],
  { stdio: "inherit" },
);
