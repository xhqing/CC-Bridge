#!/usr/bin/env node
'use strict';

// postinstall 钩子：安装 / update 重新安装后，自动确保默认上游的配置文件就位。
// 第一次安装（npm install -g <tgz>）或 `cc-bridge update` 重新安装（内部同样是
// npm install -g <tgz>，会触发本钩子）后，若默认上游的 ~/.cc-bridge/<upstream>.env
// 不存在，则从随包发布的 <name>-bridge/<name>.env.example 复制一份（内容即模板的
// copy 版），用户填好 API key 即可直接 `cc-bridge start`；已存在则跳过，绝不覆盖
// 用户已有配置（API key / 自定义参数）。
// 默认上游经 core/adapter.js 的 getDefaultUpstream() 解析——用户已用
// `cc-bridge set default upstream <name>` 改过默认时跟随用户设置（且该上游的
// env 通常已存在、自然跳过），否则用内置 DEFAULT_UPSTREAM。

const fs = require('fs');
const { getDefaultUpstream } = require('../core/adapter');
const { ensureConfig, configPathFor } = require('../core/config');

const upstream = getDefaultUpstream();
const dest = configPathFor(upstream);
if (fs.existsSync(dest)) process.exit(0); // 已存在：尊重用户配置，跳过

try {
  ensureConfig(upstream);
  console.log(`[cc-bridge] created ${dest} from template — fill in your API key, then run 'cc-bridge start'`);
} catch (e) {
  // 安装钩子失败不应阻塞安装——打印警告即可，用户可手动 `cc-bridge <upstream> config` 生成。
  console.error(`[cc-bridge] warning: could not prepare ${dest}: ${e.message}`);
}
