#!/usr/bin/env node
'use strict';

// cc-bridge — CLI entry point. Dispatches subcommands to core/* modules.
// Usage: cc-bridge [upstream] <command> [args]. Upstream defaults to 'ds'.

const { loadConfig, validate, editConfig, showConfig, importConfig, configPathFor } = require('../core/config');
const { startServer } = require('../core/server');
const { startDaemon, stopDaemon, restartDaemon, statusDaemon, tailLog } = require('../core/daemon');
const { showStats } = require('../core/stats');
const { startGui } = require('../core/gui');
const { runWithClaude } = require('../core/claude');
const { probeHealth } = require('../core/util');
const { DEFAULT_UPSTREAM, getDefaultUpstream, setDefaultUpstream, clearDefaultUpstream, listUpstreams, isKnown, isImplemented, loadAdapter } = require('../core/adapter');
const { runUpdate, runRollback } = require('../core/update');

// 当前生效的默认上游：用户设置（~/.cc-bridge/default-upstream）> 内置 DEFAULT_UPSTREAM。
// help 文案与上游省略时的解析都用它。
const DEFAULT = getDefaultUpstream();

const HELP = `cc-bridge — Claude Code upstream bridge (GLM / DeepSeek / MiMo / Kimi / Qwen …)

Usage:
  cc-bridge [upstream] <command> [args]

  upstream defaults to '${DEFAULT}' if omitted (built-in '${DEFAULT_UPSTREAM}' unless changed via 'set').
  known upstreams: ${listUpstreams().join(', ')}
  implemented  : ${listUpstreams().filter((u) => isImplemented(u)).join(', ')}  (others reserved)

Commands:
  cc-bridge start                 start service in background (detached)
  cc-bridge daemon                alias for 'start' (background)
  cc-bridge claude [args...]      start bridge + launch claude pointed at it
  cc-bridge stop                  stop background service
  cc-bridge restart               restart background service (stop + start)
  cc-bridge status                show running status
  cc-bridge stats                 terminal usage stats for ALL upstreams (aggregated)
  cc-bridge <upstream> stats      terminal stats for one upstream
  cc-bridge dashboard             open the local usage dashboard in your browser (time-window
                                  filter, trend chart, by upstream / key & model detail)
  cc-bridge stats --text          alias of plain 'stats' (terminal; kept for compatibility)
  cc-bridge stats --gui           alias of 'dashboard' (opens the browser dashboard)
  cc-bridge logs                  tail the bridge log (Ctrl-C to exit)
  cc-bridge health                probe /health
  cc-bridge config                edit config in $EDITOR
  cc-bridge config show           print config (API_KEY masked)
  cc-bridge config path           print config file path
  cc-bridge config --import <p>   import an existing .env into ~/.cc-bridge/<upstream>.env
  cc-bridge set default upstream [name]   show / set the default upstream (saved at ~/.cc-bridge/default-upstream)
  cc-bridge set default upstream --reset  restore the built-in default ('${DEFAULT_UPSTREAM}')
  cc-bridge update | --update     self-update to the latest GitHub Release
  cc-bridge rollback [version] | --rollback [version]  rollback to a specific or previous version
  cc-bridge version | -v | --version   print version
  cc-bridge help | -h | --help    this help

Examples:
  cc-bridge start                 # default upstream (${DEFAULT})
  cc-bridge ${DEFAULT} daemon       # explicit upstream
  cc-bridge ${DEFAULT} config show
  cc-bridge set default upstream glm  # make glm the default upstream
  cc-bridge rollback              # rollback to previous version
  cc-bridge rollback 2.3.0        # rollback to specific version

Options:
  --config <path>                 use this config file instead of ~/.cc-bridge/<upstream>.env
`;

function fail(msg) {
  console.error(`[bridge] ${msg}`);
  process.exit(1);
}

// Pull a global `--config <path>` (or `--config=<path>`) out of argv, leaving
// the rest intact. Returns { configPath, rest }.
function parseGlobalConfig(argv) {
  let configPath = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') { configPath = argv[++i]; continue; }
    if (argv[i].startsWith('--config=')) { configPath = argv[i].slice('--config='.length); continue; }
    rest.push(argv[i]);
  }
  return { configPath, rest };
}

// Split the post-options argv into { upstream, cmd, sub, explicit }. If the first
// token is a known upstream name (ds/glm/kimi/mimo/qwen), treat it as the upstream
// selector; otherwise default upstream (user-set > built-in) and treat the first
// token as the command. explicit = 是否显式写了上游名（stats 等命令区分聚合/单上游）。
function parseUpstream(rest) {
  if (rest.length && isKnown(rest[0])) {
    return { upstream: rest[0], cmd: rest[1], sub: rest.slice(2), explicit: true };
  }
  return { upstream: getDefaultUpstream(), cmd: rest[0], sub: rest.slice(1), explicit: false };
}

// Load adapter + config for commands that actually start the bridge.
function loadOrThrow(upstream, configPath) {
  let adapter;
  try {
    adapter = loadAdapter(upstream);
  } catch (e) {
    fail(e.message);
  }
  const cfg = loadConfig({ upstream, configPath });
  const missing = validate(cfg);
  if (missing.length) {
    fail(`missing required config: ${missing.join(', ')}. Run 'cc-bridge ${upstream} config' to edit ${cfg.configPath}.`);
  }
  return { cfg, adapter };
}

async function main() {
  const argv = process.argv.slice(2);
  const { configPath: cfgPath, rest } = parseGlobalConfig(argv);
  const { upstream, cmd, sub, explicit } = parseUpstream(rest);

  if (!cmd) {
    console.log(HELP);
    process.exit(0);
  }

  switch (cmd) {
    case 'start':
    case 'daemon':                       // 'daemon' is an alias of 'start' (both run in background)
    {
      const { cfg, adapter } = loadOrThrow(upstream, cfgPath);
      startDaemon(cfg, adapter);
      break;
    }

    case '_serve':                       // internal: foreground server (debug / direct spawn)
    {
      const { cfg, adapter } = loadOrThrow(upstream, cfgPath);
      startServer(cfg, adapter);
      break;
    }

    case 'claude': {
      const { cfg, adapter } = loadOrThrow(upstream, cfgPath);
      let args = sub;
      if (args[0] === '--') args = args.slice(1);   // allow `cc-bridge ds claude -- -p "hi"`
      runWithClaude(cfg, adapter, args);
      break;
    }

    case 'stop':
      stopDaemon(loadConfig({ upstream, configPath: cfgPath }));
      break;

    case 'restart': {
      const { cfg, adapter } = loadOrThrow(upstream, cfgPath);
      await restartDaemon(cfg, adapter);
      break;
    }

    case 'status':
      await statusDaemon(loadConfig({ upstream, configPath: cfgPath }));
      break;

    case 'stats': {
      // 默认终端文本模式（全部 / 单上游判断不变）；--gui 弹本地 dashboard（浏览器
      // 面板：起止时间、趋势图、按上游 / KEY / 模型明细）。--text / -t 保留为兼容
      // 别名（等价默认行为）。输出尾部提示 dashboard 命令。
      const guiMode = sub.includes('--gui') || sub.includes('-g');
      if (guiMode) {
        const { cfg } = loadOrThrow(upstream, cfgPath);
        await startGui({ basePort: cfg.PORT + 1 });
        break;
      }
      if (!explicit && !cfgPath && !process.env.CC_BRIDGE_CONFIG) {
        showStats(null);
      } else {
        showStats(loadConfig({ upstream, configPath: cfgPath }));
      }
      break;
    }

    case 'dashboard': {
      // 本地 dashboard：浏览器面板（仅绑 127.0.0.1、一次性 token）。当前第一模块为
      // 用量统计（概览卡、趋势图、按上游 / KEY / 模型明细），后续其它功能按模块追加
      // （页面 .module 容器 + gui.js API_ROUTES 注册行，框架不动）。stats 终端输出会
      // 提示本命令。
      const { cfg } = loadOrThrow(upstream, cfgPath);
      await startGui({ basePort: cfg.PORT + 1 });
      break;
    }

    case 'logs':
      tailLog(upstream);
      break;

    case 'health': {
      const cfg = loadConfig({ upstream, configPath: cfgPath });
      const ok = await probeHealth(cfg.PORT);
      console.log(ok ? `[bridge] /health ok on :${cfg.PORT} (${upstream})` : `[bridge] /health not responding on :${cfg.PORT} (${upstream})`);
      process.exit(ok ? 0 : 1);
      break;
    }

    case 'config': {
      const action = sub[0];
      if (!action || action === 'edit') { editConfig(upstream); break; }
      if (action === 'show') { showConfig(upstream); break; }
      if (action === 'path') { console.log(configPathFor(upstream)); break; }
      if (action === '--import' || action === 'import') {
        const src = sub[1];
        if (!src) fail('config --import <path> requires a source path');
        try {
          const dst = importConfig(upstream, src);
          console.log(`[bridge] imported ${src} → ${dst}`);
        } catch (e) {
          fail(e.message);
        }
        break;
      }
      fail(`unknown config action '${action}'. Try: cc-bridge ${upstream} config show | path | --import <path>`);
      break;
    }

    case 'set': {
      // `set default upstream [name]`：显示 / 设置用户级默认上游（持久化在
      // ~/.cc-bridge/default-upstream）。省略 upstream 参数时显示当前值；--reset 清除
      // 用户设置、恢复内置默认。设置时校验必须是已实现的上游。
      if (sub[0] !== 'default' || sub[1] !== 'upstream') {
        fail(`unknown set action. Try: cc-bridge set default upstream [name] | --reset`);
      }
      const arg = sub[2];
      if (arg === undefined) {
        const cur = getDefaultUpstream();
        const note = cur === DEFAULT_UPSTREAM ? ' (built-in)' : ' (user-set)';
        console.log(`[bridge] default upstream : ${cur}${note}`);
        console.log(`[bridge] to change        : cc-bridge set default upstream <${listUpstreams().filter(isImplemented).join('|')}>`);
        console.log(`[bridge] to restore       : cc-bridge set default upstream --reset`);
        break;
      }
      if (arg === '--reset' || arg === 'reset') {
        clearDefaultUpstream();
        console.log(`[bridge] default upstream reset to built-in '${DEFAULT_UPSTREAM}'`);
        break;
      }
      try {
        const file = setDefaultUpstream(arg);
        console.log(`[bridge] default upstream set to '${arg}' (saved: ${file})`);
        console.log(`[bridge] bare 'cc-bridge <command>' now targets '${arg}'`);
      } catch (e) {
        fail(e.message);
      }
      break;
    }

    case 'update':
    case '--update': {
      try {
        runUpdate();
      } catch (e) {
        fail(e.message);
      }
      break;
    }

    case 'rollback':
    case '--rollback': {
      try {
        runRollback(sub[0]);
      } catch (e) {
        fail(e.message);
      }
      break;
    }

    case 'version':
    case '-v':
    case '--version': {
      // 版本取自 package.json（npm 安装后一定存在；与 VERSION 文件保持一致）。
      console.log(`cc-bridge ${require('../package.json').version}`);
      break;
    }

    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      break;

    default:
      console.error(`[bridge] unknown command '${cmd}'\n`);
      console.error(HELP);
      process.exit(1);
  }
}

main();
