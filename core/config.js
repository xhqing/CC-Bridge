'use strict';

// Config loading & management. Each upstream has its own config file at
// ~/.cc-bridge/<upstream>.env (e.g. ~/.cc-bridge/glm.env), so the installed CLI
// finds it from any working directory and multiple upstreams can coexist with
// independent settings (port / keys / model …).

const fs = require('fs');
const path = require('path');
const os = require('os');

const { REGISTRY, DEFAULT_UPSTREAM, getDefaultUpstream, loadAdapter, isImplemented } = require('./adapter');

const DIR = path.join(os.homedir(), '.cc-bridge');

const configDir = () => DIR;
const configPathFor = (upstream) => path.join(DIR, `${upstream}.env`);
const pidPathFor = (upstream) => path.join(DIR, `${upstream}.pid`);
const logPathFor = (upstream) => path.join(DIR, `${upstream}.log`);
// dashboard（本地用量面板）的 pid / url / 日志：跨上游共用一份（面板聚全部上游数据，
// 起第二个没有意义）。url 文件兼作后台子进程的「就绪信号」——监听成功后写入。
const dashboardPidPath = () => path.join(DIR, 'dashboard.pid');
const dashboardUrlPath = () => path.join(DIR, 'dashboard.url');
const dashboardLogPath = () => path.join(DIR, 'dashboard.log');

// 按模型 token 统计文件路径：与 config / log / pid 同处（~/.cc-bridge/ 下按上游区分）。
// configPath 传入实际生效的配置文件路径（兼容 $CC_BRIDGE_CONFIG / --config 覆盖），
// server 写盘与 `cc-bridge stats` 读盘都用它，保证两边一定读到同一个文件。
const statsPathFor = (upstream, configPath) =>
  path.join(path.dirname(configPath || configPathFor(upstream)), `stats-${upstream}.json`);

// 每上游的配置模板：<name>-bridge/<name>.env.example（随包发布，按上游区分）。上游未
// 注册时返回 null。`cc-bridge <upstream> config` 首次生成配置时复制的就是它。
const templatePath = (upstream) => {
  const entry = REGISTRY[upstream];
  if (!entry) return null;
  return path.resolve(__dirname, '..', entry.dir, `${upstream}.env.example`);
};

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// Parse a .env file into a plain object (strips quotes, skips comments/blank
// lines). Does NOT touch process.env.
function parseEnv(filePath) {
  const obj = {};
  if (!fs.existsSync(filePath)) return obj;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) obj[k] = v;
  }
  return obj;
}

// 解析模型映射为 [{spoof, target}, ...]。支持三种写法（优先级从高到低）：
//   1) MODEL_MAP="spoofA->targetA,spoofB->targetB"  多对（推荐：单上游内多模型路由，
//                                                   如 opus 和 haiku 都指向 glm-5.3）
//   2) SPOOF_MODEL + TARGET_MODEL                    单对（向后兼容旧配置）
//   3) 两者都没配                                     返回 []（由 server 用 adapter 默认兜底）
// 第一对约定为「主力对」：claude.js 用它的 spoof 作为启动 claude 时的 ANTHROPIC_MODEL。
// 格式错误抛 Error（带清晰信息）；loadConfig 会捕获并入 validate 报告，保持不抛契约。
function parseModelMap(rawMap, rawSpoof, rawTarget) {
  const pairs = [];
  const map = (rawMap || '').trim();
  if (map) {
    for (const part of map.split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const arrow = seg.indexOf('->');
      if (arrow === -1) {
        throw new Error(`invalid entry "${seg}" — expected "spoof->target"`);
      }
      const spoof = seg.slice(0, arrow).trim();
      const target = seg.slice(arrow + 2).trim();
      if (!spoof || !target) {
        throw new Error(`invalid entry "${seg}" — both spoof and target are required around '->'`);
      }
      pairs.push({ spoof, target });
    }
    if (!pairs.length) throw new Error('MODEL_MAP is set but contains no valid entries');
    return pairs;
  }
  // 单对兼容：SPOOF_MODEL / TARGET_MODEL（缺一边则留空，由 server 用 adapter 默认补齐）。
  if ((rawSpoof || '').trim() || (rawTarget || '').trim()) {
    return [{ spoof: (rawSpoof || '').trim(), target: (rawTarget || '').trim() }];
  }
  return [];
}

// 解析按模型的思考等级配置为 { map, defaultLevel }。紧凑映射写法：
//   MODEL_THINKING="modelA->levelA,modelB->levelB"
// ——已废弃（2026-08-22 T11：思考钉死功能下线，/effort 档位原样透传、由上游按官方
// 映射解读）。保留空实现仅为兼容旧配置文件里可能残留的 MODEL_THINKING 行：静默忽略，
// 不再产生任何效果。后续大版本可连本函数一起删。
function parseModelThinking() {
  return { map: {}, defaultLevel: null };
}

// 解析 API_BASES="name->url,name->url" 为 [{name, url}]（多端点，如 GLM 同时配
// z.ai 国际版与智谱国内版，KEY 轮换跨端点容灾）。第一个条目是未绑定端点的 KEY 的
// 默认端点。格式错误抛 Error（带清晰信息）；loadConfig 捕获并存入 apiBasesError，
// 由 validate 报告，保持不抛契约。
function parseApiBases(raw) {
  const list = [];
  const s = (raw || '').trim();
  if (!s) return list;
  for (const part of s.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const arrow = seg.indexOf('->');
    if (arrow === -1) {
      throw new Error(`invalid entry "${seg}" — expected "name->url"`);
    }
    const name = seg.slice(0, arrow).trim();
    const url = seg.slice(arrow + 2).trim();
    if (!name || !url) {
      throw new Error(`invalid entry "${seg}" — both name and url are required around '->'`);
    }
    list.push({ name, url });
  }
  if (!list.length) throw new Error('API_BASES is set but contains no valid entries');
  return list;
}

// 收集所有 API KEY，支持两种写法（可混用、合并去空、不去重），返回对象数组
// [{ idx, value, name, baseName, priorityRaw, hideUserIdRaw }]：
//   idx           编号变量的数字（错误信息定位用）
//   value         KEY 本体
//   name          KEY_NAME_n 统计展示名（可空；空时展示用 #idx 兜底）
//   baseName      KEY_n_BASE 绑定的 API_BASES 端点名（可空；空时用第一个端点）
//   priorityRaw   KEY_n_PRIORITY 优先级（正整数，越大越先用；未配视为 0）
//   hideUserIdRaw KEY_n_HIDE_USER_ID 隐私选项（'1' = 该 KEY 清空 metadata.user_id）
//   1) 编号变量 API_KEY_1 / API_KEY_2 / API_KEY_3 …（推荐）。每个 KEY 独立成行，可单独
//      写注释标注账号来源（如「# 工作账号」「# 个人账号」），也可单独注释掉整行来临时
//      禁用某个 KEY——比在一长串逗号串里增删值方便得多。编号按数字大小升序排列（不是
//      字典序，所以 API_KEY_10 仍排在 API_KEY_2 之后）。每个 KEY 的可选属性按同编号
//      派生：API_KEY_1_NAME / API_KEY_1_BASE / API_KEY_1_PRIORITY / API_KEY_1_HIDE_USER_ID
//      对应 API_KEY_1。
//   2) 旧式单变量 API_KEY=k1,k2,k3（逗号分隔，向后兼容）。若同时配了编号变量，老式
//      API_KEY 的值会「追加」在编号变量之后，不会覆盖。旧式 KEY 无 NAME / BASE /
//      PRIORITY / HIDE_USER_ID 属性。
// process.env 与文件 env 都查（process.env 优先，与 get() 语义一致）。
function collectKeys(env, get) {
  const re = /^API_KEY_\d+$/;
  const names = new Set();
  for (const k of Object.keys(process.env)) if (re.test(k)) names.add(k);
  for (const k of Object.keys(env)) if (re.test(k)) names.add(k);
  const ordered = [...names].sort(
    (a, b) => parseInt(a.slice('API_KEY_'.length), 10) - parseInt(b.slice('API_KEY_'.length), 10)
  );
  const out = [];
  for (const n of ordered) {
    const value = get(n, '').trim();
    if (!value) continue;
    out.push({
      idx: parseInt(n.slice('API_KEY_'.length), 10),
      value,
      name: (get(`${n}_NAME`, '') || '').trim(),
      baseName: (get(`${n}_BASE`, '') || '').trim(),
      priorityRaw: (get(`${n}_PRIORITY`, '') || '').trim(),
      hideUserIdRaw: (get(`${n}_HIDE_USER_ID`, '') || '').trim(),
    });
  }
  const legacy = get('API_KEY', '');
  if (legacy) {
    legacy.split(',').map((v) => v.trim()).filter(Boolean).forEach((v) => {
      out.push({ idx: out.length + 1, value: v, name: '', baseName: '', priorityRaw: '', hideUserIdRaw: '' });
    });
  }
  return out;
}

// 校验 KEY 属性：KEY_NAME 在同一配置内不允许重复（stats 按 key-name 分类聚合，
// 重名会把两个账号的用量混在一起）；KEY_n_BASE 必须是 API_BASES 里已定义的端点名；
// KEY_n_PRIORITY 必须是非负整数。返回错误信息数组（空数组 = 通过）。
function validateKeyAttrs(keys, apiBases) {
  const errs = [];
  const seen = new Map(); // name -> idx（首个使用者）
  for (const k of keys) {
    if (k.name) {
      if (seen.has(k.name)) {
        errs.push(`API_KEY_${seen.get(k.name)}_NAME and API_KEY_${k.idx}_NAME are both "${k.name}" — key names must be unique`);
      } else {
        seen.set(k.name, k.idx);
      }
    }
    if (k.baseName && !apiBases.some((b) => b.name === k.baseName)) {
      errs.push(`API_KEY_${k.idx}_BASE="${k.baseName}" does not match any API_BASES name (available: ${apiBases.map((b) => b.name).join(', ') || 'none'})`);
    }
    if (k.priorityRaw && !/^\d+$/.test(k.priorityRaw)) {
      errs.push(`API_KEY_${k.idx}_PRIORITY="${k.priorityRaw}" is not a non-negative integer`);
    }
    if (k.hideUserIdRaw && k.hideUserIdRaw !== '0' && k.hideUserIdRaw !== '1') {
      errs.push(`API_KEY_${k.idx}_HIDE_USER_ID="${k.hideUserIdRaw}" is not 0 or 1`);
    }
  }
  return errs;
}

// Resolve which .env to read: explicit --config > $CC_BRIDGE_CONFIG > per-upstream default.
function resolveConfigPath(upstream, override) {
  if (override) return override;
  if (process.env.CC_BRIDGE_CONFIG) return process.env.CC_BRIDGE_CONFIG;
  return configPathFor(upstream);
}

// Load and normalise config for an upstream. process.env wins over the .env file.
// Never throws on missing fields — callers use validate() to check required ones.
// 未显式指定上游时用用户级默认（~/.cc-bridge/default-upstream，见 adapter.js），
// 用户未设置则回退内置 DEFAULT_UPSTREAM。
function loadConfig(opts = {}) {
  const upstream = opts.upstream || getDefaultUpstream();
  const file = resolveConfigPath(upstream, opts.configPath);
  const env = parseEnv(file);

  // 上游专属配置预处理钩子（可选能力，见 core/adapter.js 接口注释）：adapter 实现
  // preprocessEnv(env) 时先调用，让它把自定义「分节配置」改写（mutate）为标准平铺
  // 变量——hybrid 混合桥用它把 PROVIDER 分节摊平为 API_BASES / API_KEY_n /
  // MODEL_MAP，摊平后下方所有解析 / 校验逻辑无感知复用。未实现该钩子的上游零影
  // 响；预留未实现的上游（kimi / qwen）跳过（不破坏 stop / status / config 等
  // 只读命令）。钩子抛错不向上传播——记入 providerConfigError，由 validate 报给
  // 用户，保持 loadConfig「永不抛错」的契约。
  let providerConfigError = null;
  if (isImplemented(upstream)) {
    try {
      const hookAdapter = loadAdapter(upstream);
      if (hookAdapter && typeof hookAdapter.preprocessEnv === 'function') {
        hookAdapter.preprocessEnv(env);
      }
    } catch (e) {
      providerConfigError = e.message;
    }
  }

  const get = (k, d) => {
    if (process.env[k] !== undefined && process.env[k] !== '') return process.env[k];
    if (env[k] !== undefined) return env[k];
    return d;
  };

  // 多 KEY 容灾：支持编号变量 API_KEY_1 / API_KEY_2 / …（推荐）与旧式 API_KEY=k1,k2
  // （向后兼容）两种写法，详见 collectKeys。某 KEY 被判失效 / 欠费（401/403）或同 KEY
  // 瞬态重试用尽时，自动切换到下一个 KEY——多端点（API_BASES）时 KEY 轮换天然跨端点容灾。
  const normBase = (v) => (v || '').replace(/\/+$/, '');
  const rawKeys = collectKeys(env, get);

  // 多端点：API_BASES="name->url,…"（如 GLM 配 z.ai 国际版 + 智谱国内版）。未配时退
  // 单端点 API_BASE（兼容旧配置）。解析失败不抛——错误存入 keyAttrErrors，由 validate
  // 报给用户，保持 loadConfig「永不抛错」的契约。
  let API_BASES = [];
  let apiBasesError = null;
  try {
    API_BASES = parseApiBases(get('API_BASES', ''));
  } catch (e) {
    apiBasesError = e.message;
  }
  if (!API_BASES.length) {
    const single = normBase(get('API_BASE', ''));
    if (single) API_BASES = [{ name: 'default', url: single }];
  }
  // KEY 属性校验（key-name 查重 / base 绑定存在性）——同样不抛，入 validate 报告。
  const keyAttrErrors = apiBasesError ? [] : validateKeyAttrs(rawKeys, API_BASES);

  // 每个实际使用的 KEY 解析出最终 base URL（baseName → API_BASES 查表；未绑 → 第一个
  // 端点）、统计展示名（name → 用户配的 key-name；未配 → #idx 兜底）与优先级
  // （priority → KEY_n_PRIORITY；未配或非法为 0）。随后按优先级降序稳定排序：
  // 高优先级 KEY 排前、每次请求先用（KEY 轮换按数组顺序扫）；同优先级保持配置里
  // 的编号顺序（稳定排序）。这让「主力 KEY 先用、备用 KEY 容灾」由配置表达，
  // server 的轮换 / 熔断逻辑无需感知优先级。
  const firstBase = API_BASES[0] ? API_BASES[0].url : '';
  const KEYS = rawKeys
    .map((k) => {
      const baseEntry = k.baseName ? API_BASES.find((b) => b.name === k.baseName) : null;
      return {
        value: k.value,
        name: k.name || `#${k.idx}`,
        baseName: k.baseName || (API_BASES.length ? API_BASES[0].name : ''),
        base: baseEntry ? baseEntry.url : firstBase,
        priority: /^\d+$/.test(k.priorityRaw || '') ? parseInt(k.priorityRaw, 10) : 0,
        // 隐私选项：'1' = 该 KEY 转发时清空 metadata.user_id；其余（未配 / '0'）透传。
        hideUserId: k.hideUserIdRaw === '1',
        idx: k.idx,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.idx - b.idx);

  // 模型映射（多对 spoof→target）。解析失败不抛——错误存入 modelMapError，由 validate
  // 报给用户，保持 loadConfig「永不抛错」的契约。
  let PAIRS = [];
  let modelMapError = null;
  try {
    PAIRS = parseModelMap(get('MODEL_MAP', ''), get('SPOOF_MODEL', ''), get('TARGET_MODEL', ''));
  } catch (e) {
    modelMapError = e.message;
  }

  // 按模型思考等级（MODEL_THINKING）——已废弃（2026-08-22 T11：思考钉死功能下线，/effort
  // 档位原样透传）。旧配置文件里残留的 MODEL_THINKING / MODEL_THINKING_DEFAULT 行被静默
  // 忽略，不再产生任何效果。THINK_MAP 恒空、THINK_DEFAULT 恒 null，字段保留仅为不破坏
  // 下游（server / adapter）的读取契约，后续大版本可一并删。
  const THINK_MAP = {};
  const THINK_DEFAULT = null;

  return {
    upstream,
    PORT: parseInt(get('PROXY_PORT', '8787'), 10) || 8787,
    // 多端点列表 [{name, url}]（API_BASES；未配则由单 API_BASE 包成单元素数组）。
    API_BASES,
    // 兼容字段：首个端点的 URL。单端点配置下与旧 API_BASE 等值；多端点时仅作展示
    // （banner / health），实际转发按每 KEY 的 base（KEYS[i].base）。
    API_BASE: firstBase,
    // 全部 KEY（对象数组）：value=KEY 本体、name=统计展示名（KEY_NAME_n 或 #idx）、
    // baseName/base=该 KEY 使用的端点名与 URL、priority=优先级（大者先用，已按降序
    // 排好）、hideUserId=隐私选项（true 时该 KEY 清空 metadata.user_id）。
    // KEY 轮换在 KEYS 间进行（顺序即优先级顺序），跨端点容灾。
    KEYS,
    API_KEY: KEYS[0] ? KEYS[0].value : '', // 首个 KEY，向后兼容只读单 KEY 的旧代码
    // 模型映射：[{spoof, target}, ...]。空数组 → server 用 adapter 默认单对兜底。
    PAIRS,
    SPOOF_MODEL: PAIRS[0] ? PAIRS[0].spoof : '',   // 主力 spoof（兼容旧字段，= 第一对）
    TARGET_MODEL: PAIRS[0] ? PAIRS[0].target : '', // 主力 target（同上）
    CONTEXT_WINDOW: parseInt(get('CONTEXT_WINDOW', '0'), 10) || 0,
    MAX_OUTPUT_TOKENS: parseInt(get('MAX_OUTPUT_TOKENS', '0'), 10) || 0,
    VERBOSE: (get('PROXY_LOG', '1') !== '0'),
    DUMP: (get('PROXY_DUMP', '0') === '1'),
    // 上游转发代理（可选）：配置后所有对上游端点的 https 请求经此 HTTP 代理出站
    //（如 http://127.0.0.1:1087）——境外上游（agnes 等）直连不通 / 不稳时用。
    // 未配置（默认）保持直连，零影响。仅作用于框架主转发路径（含断流续写），
    // 不影响分类器通道（classifier 自带 HTTPS_PROXY 感知）。
    UPSTREAM_PROXY: (get('UPSTREAM_PROXY', '') || '').trim(),
    // CC 安全分类器路由（详见 core/classifier.js）：off=直接放行（默认，不走模型，0 消耗无判断）；
    // on=走 agnes 免费模型（主模型失败切备用）。CLASSIFIER_MODE 未配时默认 off。
    CLASSIFIER_MODE: (get('CLASSIFIER_MODE', 'off') || 'off').toLowerCase(),
    AGNES_API_BASE: get('AGNES_API_BASE', ''),
    AGNES_API_KEY: get('AGNES_API_KEY', ''),
    AGNES_MODEL_PRIMARY: get('AGNES_MODEL_PRIMARY', 'agnes-2.5-flash'),
    AGNES_MODEL_FALLBACK: get('AGNES_MODEL_FALLBACK', 'agnes-2.0-flash'),
    // 按模型思考等级——已废弃（T11），恒空 / 恒 null，仅为下游读取契约保留。
    THINK_MAP,
    THINK_DEFAULT,
    modelMapError,
    apiBasesError,
    keyAttrErrors,
    // 上游 preprocessEnv 钩子的错误（分节配置摊平失败等；hybrid 用）。null = 通过。
    providerConfigError,
    configPath: file,
  };
}

function validate(cfg) {
  const missing = [];
  if (!cfg.API_BASE) missing.push('API_BASE (or API_BASES)');
  if (!cfg.KEYS.length) missing.push('API_KEY_1 (or legacy API_KEY)');
  if (cfg.modelMapError) missing.push(`MODEL_MAP (${cfg.modelMapError})`);
  if (cfg.apiBasesError) missing.push(`API_BASES (${cfg.apiBasesError})`);
  if (cfg.providerConfigError) missing.push(`provider config (${cfg.providerConfigError})`);
  for (const e of cfg.keyAttrErrors || []) missing.push(e);
  return missing;
}

// Create ~/.cc-bridge/<upstream>.env from the upstream's bundled <upstream>.env.example if absent.
// 模板按上游区分：<name>-bridge/<name>.env.example（找不到则写一行占位注释）。
function ensureConfig(upstream) {
  ensureDir();
  const CONFIG = configPathFor(upstream);
  if (!fs.existsSync(CONFIG)) {
    const tpl = templatePath(upstream);
    if (tpl && fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, CONFIG);
    } else {
      fs.writeFileSync(CONFIG, `# cc-bridge (${upstream}) config — fill in API_BASE / API_KEY\n`);
    }
  }
  return CONFIG;
}

// Copy an existing .env into the per-upstream config slot.
function importConfig(upstream, srcPath) {
  if (!fs.existsSync(srcPath)) throw new Error(`source not found: ${srcPath}`);
  ensureDir();
  fs.copyFileSync(srcPath, configPathFor(upstream));
  return configPathFor(upstream);
}

// Open the config in $EDITOR (fallback vi).
function editConfig(upstream) {
  const CONFIG = ensureConfig(upstream);
  const editor = process.env.EDITOR || 'vi';
  const { spawnSync } = require('child_process');
  spawnSync(editor, [CONFIG], { stdio: 'inherit' });
}

function mask(key) {
  if (!key) return '(unset)';
  if (key.length <= 6) return '***';
  return key.slice(0, 6) + '***';
}

function showConfig(upstream) {
  const cfg = loadConfig({ upstream });
  console.log(`upstream      : ${cfg.upstream}`);
  console.log(`config file   : ${cfg.configPath}`);
  console.log(`PROXY_PORT    : ${cfg.PORT}`);
  console.log(`PROXY_LOG     : ${cfg.VERBOSE ? '1' : '0'}`);
  if (cfg.UPSTREAM_PROXY) console.log(`upstream proxy: ${cfg.UPSTREAM_PROXY}`);
  if (cfg.API_BASES.length > 1) {
    console.log(`api bases     : ${cfg.API_BASES.length} endpoints`);
    cfg.API_BASES.forEach((b, i) => {
      const tag = i === 0 ? 'main' : '    ';
      console.log(`  ${tag}  ${b.name}  ${b.url}`);
    });
  } else {
    console.log(`api base      : ${cfg.API_BASE || '(unset)'}`);
  }
  if (cfg.PAIRS.length) {
    console.log(`model map     : ${cfg.PAIRS.length} pair(s)  (first pair = main model)`);
    cfg.PAIRS.forEach((p, i) => {
      const tag = i === 0 ? 'main' : '    ';
      console.log(`  ${tag} #${i + 1}  ${p.spoof || '(adapter default)'} → ${p.target || '(adapter default)'}`);
    });
  } else {
    console.log(`model map     : (unset — will use adapter default spoof → target)`);
  }
  if (cfg.modelMapError) console.log(`MODEL_MAP err : ${cfg.modelMapError}`);
  if (cfg.providerConfigError) console.log(`provider err  : ${cfg.providerConfigError}`);
  const thinkEntries = Object.entries(cfg.THINK_MAP || {});
  if (thinkEntries.length) {
    console.log(`thinking      : per-model  (default=${cfg.THINK_DEFAULT || 'adapter max'})`);
    thinkEntries.forEach(([m, l]) => {
      console.log(`              ${m} → ${l}`);
    });
  } else {
    console.log(`thinking      : (unset — all models use default ${cfg.THINK_DEFAULT || 'adapter max'})`);
  }
  if (cfg.apiBasesError) console.log(`API_BASES err : ${cfg.apiBasesError}`);
  for (const e of cfg.keyAttrErrors || []) console.log(`KEY attr err  : ${e}`);
  console.log(`API_KEYs      : ${cfg.KEYS.length}`);
  cfg.KEYS.forEach((k, i) => {
    const baseTag = cfg.API_BASES.length > 1 ? `  @${k.baseName || 'default'}` : '';
    const priTag = k.priority ? `  prio=${k.priority}` : '';
    console.log(`  ${String('#' + (i + 1)).padEnd(8)} ${mask(k.value)}  name=${k.name}${baseTag}${priTag}`);
  });
  if (cfg.CONTEXT_WINDOW) console.log(`context       : ${cfg.CONTEXT_WINDOW.toLocaleString()} tokens`);
  if (cfg.MAX_OUTPUT_TOKENS) console.log(`maxOut        : ${cfg.MAX_OUTPUT_TOKENS.toLocaleString()} tokens`);
}

// 把 cfg.PAIRS 解析成 server/daemon 直接可用的「路由 + 展示用」对列表：
// 用户未配（PAIRS 空）→ 用 adapter 默认单对兜底；单边配置 → 另一边用 adapter 默认补齐。
// 供 server.js（路由）和 daemon.js（banner）共用，避免派生逻辑重复。
function resolvePairs(cfg, adapter) {
  const list = (cfg.PAIRS && cfg.PAIRS.length)
    ? cfg.PAIRS.map((p) => ({ spoof: p.spoof, target: p.target }))
    : [{ spoof: adapter.defaultSpoof, target: adapter.defaultTarget }];
  return list.map((p) => ({
    spoof: p.spoof || adapter.defaultSpoof,
    target: p.target || adapter.defaultTarget,
  }));
}

module.exports = {
  configDir, configPathFor, pidPathFor, logPathFor, statsPathFor, templatePath,
  dashboardPidPath, dashboardUrlPath, dashboardLogPath,
  parseEnv, parseApiBases, parseModelMap, parseModelThinking, resolvePairs, resolveConfigPath, loadConfig, validate,
  ensureConfig, importConfig, editConfig, showConfig, mask, ensureDir,
};
