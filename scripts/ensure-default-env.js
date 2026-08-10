#!/usr/bin/env node
'use strict';

// postinstall 钩子：安装 / update 重新安装后，自动确保默认上游的配置文件就位。
// 第一次安装（npm install -g <tgz>）或 `cc-bridge update` 重新安装（内部同样是
// npm install -g <tgz>，会触发本钩子）后，若 ~/.cc-bridge/<DEFAULT_UPSTREAM>.env
// 不存在，则从随包发布的 <name>-bridge/<name>.env.example 复制一份（内容即模板的
// copy 版），用户填好 API key 即可直接 `cc-bridge start`；已存在则跳过，绝不覆盖
// 用户已有配置（API key / 自定义参数）。
// 由 core/adapter.js 的 DEFAULT_UPSTREAM 驱动——默认上游变更时自动跟随，无需改本脚本。

const fs = require('fs');
const { DEFAULT_UPSTREAM } = require('../core/adapter');
const { ensureConfig, configPathFor } = require('../core/config');

const dest = configPathFor(DEFAULT_UPSTREAM);
if (fs.existsSync(dest)) process.exit(0); // 已存在：尊重用户配置，跳过

try {
  ensureConfig(DEFAULT_UPSTREAM);
  console.log(`[cc-bridge] created ${dest} from template — fill in your API key, then run 'cc-bridge start'`);
} catch (e) {
  // 安装钩子失败不应阻塞安装——打印警告即可，用户可手动 `cc-bridge <upstream> config` 生成。
  console.error(`[cc-bridge] warning: could not prepare ${dest}: ${e.message}`);
}
