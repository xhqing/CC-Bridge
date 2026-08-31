'use strict';

// 上游注册表 + adapter 加载器。
// 每个上游（GLM / Kimi / Qwen …）在顶层 <name>-bridge/ 目录下放一个 adapter.js，
// 实现统一接口（见 glm-bridge/adapter.js）。新增上游时：在此注册表加一行，
// 并建对应的 <name>-bridge/adapter.js。
//
// adapter 接口：
//   name             上游标识（目录名 <name>-bridge、配置文件 <name>.env 均由它派生）
//   displayName      展示名（日志 / health 用）
//   defaultTarget    默认 TARGET_MODEL（配置未填时兜底）
//   defaultSpoof     默认 SPOOF_MODEL
//   modelMaxTokens   { modelId: maxOutputTokens } 表，用于钳 max_tokens
//   modelContextWindow { modelId: contextWindow } 表（官方文档值），用于 modelUsage
//                   注入兜底——未显式配 CONTEXT_WINDOW 时按 target 注入真实窗口
//   adaptRequestBody(obj, ctx)  改写 Anthropic 请求体（上游专属适配），ctx = { target }。
//                   思考字段（thinking / output_config.effort）不在此改写——/effort 档位
//                   原样透传、由上游端点按官方映射解读（2026-08-22 T11 下线钉死）

const fs = require('fs');
const path = require('path');
const os = require('os');

const REGISTRY = {
  glm: { dir: 'glm-bridge', implemented: true },
  kimi: { dir: 'kimi-bridge', implemented: false },
  qwen: { dir: 'qwen-bridge', implemented: false },
  mimo: { dir: 'mimo-bridge', implemented: true },
  ds: { dir: 'ds-bridge', implemented: true },
};

// 内置默认上游（代码级兜底）。用户可通过 `cc-bridge set default upstream <name>`
// 覆盖为个人默认（持久化在 ~/.cc-bridge/default-upstream），运行时各取用点统一
// 经 getDefaultUpstream() 解析：用户设置 > 内置默认。
const DEFAULT_UPSTREAM = 'ds';

// 用户级默认上游的持久化文件（与 <upstream>.env / .pid / .log 同目录）。
const defaultUpstreamPath = () => path.join(os.homedir(), '.cc-bridge', 'default-upstream');

// 读取用户设置的默认上游；未设置 / 文件损坏（含未知上游名）时回退内置默认。
// 文件内容只取首个非空行、去首尾空白， tolerate 编辑器末尾换行。
function getDefaultUpstream() {
  let saved = null;
  try {
    const raw = fs.readFileSync(defaultUpstreamPath(), 'utf-8');
    const first = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (first) saved = first;
  } catch { /* 文件不存在等：回退内置默认 */ }
  return isKnown(saved) ? saved : DEFAULT_UPSTREAM;
}

// 写入用户级默认上游。校验：必须是已实现的上游（预留未实现的不允许设为默认，
// 否则 `cc-bridge start` 会在运行时才报错）。写入内容为单行上游名 + 换行。
function setDefaultUpstream(name) {
  if (!isKnown(name)) {
    throw new Error(`unknown upstream '${name}'. Known upstreams: ${listUpstreams().join(', ')}.`);
  }
  if (!isImplemented(name)) {
    throw new Error(`upstream '${name}' is reserved but not implemented yet.`);
  }
  const file = defaultUpstreamPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${name}\n`);
  return file;
}

// 清除用户级默认上游，回退内置默认（文件不存在时静默成功）。
function clearDefaultUpstream() {
  try { fs.unlinkSync(defaultUpstreamPath()); } catch { /* 不存在即视为已清除 */ }
}

function listUpstreams() {
  return Object.keys(REGISTRY);
}

function isKnown(name) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

function isImplemented(name) {
  const entry = REGISTRY[name];
  return !!entry && entry.implemented;
}

// 加载某上游的 adapter。未注册或未实现时抛错（错误信息提示如何扩展）。
function loadAdapter(name) {
  const entry = REGISTRY[name];
  if (!entry) {
    throw new Error(`unknown upstream '${name}'. Known upstreams: ${listUpstreams().join(', ')}.`);
  }
  if (!entry.implemented) {
    throw new Error(
      `upstream '${name}' is reserved but not implemented yet. ` +
      `Create ${entry.dir}/adapter.js to add it (see glm-bridge/adapter.js for the interface).`,
    );
  }
  // adapter 在顶层 <dir>/adapter.js，本文件在 core/，故 ../<dir>/adapter。
  return require(`../${entry.dir}/adapter`);
}

module.exports = {
  REGISTRY, DEFAULT_UPSTREAM, defaultUpstreamPath,
  getDefaultUpstream, setDefaultUpstream, clearDefaultUpstream,
  listUpstreams, isKnown, isImplemented, loadAdapter,
};
