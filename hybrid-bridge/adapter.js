'use strict';

// Hybrid（混合上游）适配器 —— 一个本地端口同时服务多个模型提供商。
//
// 与单上游桥（glm / ds / mimo …「一个 adapter 对接一个提供商」）不同，hybrid 把
// 多个已实现的成员 adapter 组合在一个端口后面，按「请求的模型」把每条请求路由到
// 对应的提供商：
//
//   Claude Code ──▶ hybrid 桥（一个端口）
//                    ├─ model=claude-opus-4-8  → glm:glm-5.3          → GLM 的端点 / KEY
//                    ├─ model=claude-haiku-4-5 → ds:deepseek-v4-flash → DeepSeek 的端点 / KEY
//                    └─ …（成员可任选已实现上游组合）
//
// 配置形态（~/.cc-bridge/hybrid.env，详见 hybrid.env.example）：每个成员提供商一
// 「节」，节前缀 = 成员名大写（GLM_ / DS_ / MIMO_ …）：
//   GLM_BASES=zai->https://api.z.ai/api/anthropic,cn->https://open.bigmodel.cn/api/anthropic
//   GLM_API_KEY_1=…（+ _NAME / _BASE / _PRIORITY / _HIDE_USER_ID 属性，语义同平铺写法）
//   DS_BASE=https://api.deepseek.com/anthropic
//   DS_API_KEY_1=…
//   MODEL_MAP=claude-opus-4-8->glm:glm-5.3,claude-haiku-4-5->ds:deepseek-v4-flash
//
// 实现思路（框架对 hybrid 零特判，全部经两个可选 adapter 钩子落地）：
//   · preprocessEnv(env)（core/config.js 在解析前调用）——把分节配置摊平为框架
//     标准平铺变量：API_BASES（端点名加「<provider>-」前缀防跨节撞名，如
//     glm-zai / ds-default）、API_KEY_n（跨节统一重编号，KEY_n_BASE 指回本节端
//     点）、MODEL_MAP（target 限定为「provider:model」形式）。摊平后框架其余部
//     分（校验 / KEY 轮换 / 熔断 / 统计 / daemon / GUI）全部无感知复用。
//   · routeKeys(target, KEYS)（core/server.js 每请求调用）——按 target 的
//     provider 前缀返回该提供商的 KEY 索引集合，server 只在集合内轮换 / 容灾。
//     跨提供商容灾没有意义：模型在别家不存在，换了只会 400。
//   · adaptRequestBody(obj, ctx)——剥掉 obj.model 的 provider 前缀，再委派给成员
//     adapter 做该上游的专属适配（max_tokens 钳制、tool 序列修复等）。
//   · modelContextWindow / modelMaxTokens——各成员表按「provider:model」键合并，
//     modelUsage 注入与 resolvePairs 的窗口兜底照常工作（qualified target 命中
//     成员表里的真实值）。
//
// MODEL_MAP 的 target 两种写法：
//   · 显式限定：spoof->glm:glm-5.3（provider:model，提供商与模型都写死）。
//   · 省略 provider：spoof->glm-5.3 —— 在各成员的模型表（modelMaxTokens /
//     modelContextWindow / defaultTarget）里查这个裸模型名，恰好一家认识就自动
//     限定为那家；没有一家认识、或多家都认识（歧义）→ 配置错误，启动校验报出。

const { loadAdapter, isKnown, isImplemented } = require('../core/adapter');

// 「provider:model」限定 target 的拆解。无前缀时 provider 为 null；前缀为空
//（形如 ":model"）同样视为无前缀（首个冒号在首位）。
function splitQualified(target) {
  const s = String(target || '');
  const i = s.indexOf(':');
  if (i <= 0) return { provider: null, model: s || null };
  return { provider: s.slice(0, i), model: s.slice(i + 1) || null };
}

// 小型 MODEL_MAP 解析（语法与 core/config.parseModelMap 一致；不复用它是为了
// 避免 hybrid-bridge → core/config 的反向依赖）。格式错误抛 Error。
function parsePairs(raw) {
  const pairs = [];
  for (const part of String(raw || '').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const arrow = seg.indexOf('->');
    if (arrow === -1) {
      throw new Error(`invalid MODEL_MAP entry "${seg}" — expected "spoof->target"`);
    }
    const spoof = seg.slice(0, arrow).trim();
    const target = seg.slice(arrow + 2).trim();
    if (!spoof || !target) {
      throw new Error(`invalid MODEL_MAP entry "${seg}" — both spoof and target are required around '->'`);
    }
    pairs.push({ spoof, target });
  }
  if (!pairs.length) throw new Error('MODEL_MAP is set but contains no valid entries');
  return pairs;
}

// 小型多端点解析（语法与 core/config.parseApiBases 一致）。「名字->URL」逗号
// 列表，URL 去尾部斜杠。格式错误抛 Error。
function parseBases(raw, where) {
  const list = [];
  for (const part of String(raw || '').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const arrow = seg.indexOf('->');
    if (arrow === -1) {
      throw new Error(`invalid entry "${seg}" in ${where} — expected "name->url"`);
    }
    const name = seg.slice(0, arrow).trim();
    const url = seg.slice(arrow + 2).trim().replace(/\/+$/, '');
    if (!name || !url) {
      throw new Error(`invalid entry "${seg}" in ${where} — both name and url are required around '->'`);
    }
    list.push({ name, url });
  }
  if (!list.length) throw new Error(`${where} is set but contains no valid entries`);
  return list;
}

// 从 env 文件对象里发现「成员分节」。节变量形态（P = 成员名大写，字母数字）：
//   P_BASES / P_BASE                    —— 该成员的端点（多端点列表 / 单端点 URL）
//   P_API_KEY_n                          —— 该成员的 KEY（本节内编号）
//   P_API_KEY_n_NAME/_BASE/_PRIORITY/_HIDE_USER_ID —— KEY 属性（语义同平铺写法）
// 只扫 env 文件对象、不扫 process.env——后者键空间是全局的，前缀匹配容易误伤
// 无关变量（如 OPENAI_API_KEY_1）。前缀小写后必须是注册表里的已知上游才认作
// 分节（GLM_API_KEY_1_BASE 这类 KEY 属性变量的前缀是 GLM_API_KEY_1，不是已知
// 上游名，天然不误认）；未实现 / hybrid 自身在发现后统一校验报错。
// 返回按文件出现顺序排列的节描述数组。
function discoverProviders(env) {
  const order = [];
  const byName = new Map();
  const ensure = (low) => {
    let p = byName.get(low);
    if (!p) {
      p = { name: low, basesRaw: null, baseSingle: '', bases: [], keys: new Map(), keyList: [] };
      byName.set(low, p);
      order.push(p);
    }
    return p;
  };
  for (const k of Object.keys(env)) {
    // KEY 属性变量的正则在前（更具体）：P_API_KEY_n_NAME 等。
    let m = /^([A-Z][A-Z0-9]*)_API_KEY_(\d+)_(NAME|BASE|PRIORITY|HIDE_USER_ID)$/.exec(k);
    if (m) {
      if (!isKnown(m[1].toLowerCase())) continue;
      const p = ensure(m[1].toLowerCase());
      const n = parseInt(m[2], 10);
      const rec = p.keys.get(n) || { n, value: '', name: '', baseName: '', priorityRaw: '', hideUserIdRaw: '' };
      const field = { NAME: 'name', BASE: 'baseName', PRIORITY: 'priorityRaw', HIDE_USER_ID: 'hideUserIdRaw' }[m[3]];
      rec[field] = env[k].trim();
      p.keys.set(n, rec);
      continue;
    }
    m = /^([A-Z][A-Z0-9]*)_API_KEY_(\d+)$/.exec(k);
    if (m) {
      if (!isKnown(m[1].toLowerCase())) continue;
      const p = ensure(m[1].toLowerCase());
      const n = parseInt(m[2], 10);
      const rec = p.keys.get(n) || { n, value: '', name: '', baseName: '', priorityRaw: '', hideUserIdRaw: '' };
      rec.value = env[k].trim();
      p.keys.set(n, rec);
      continue;
    }
    m = /^([A-Z][A-Z0-9]*)_(BASES|BASE)$/.exec(k);
    if (m) {
      if (!isKnown(m[1].toLowerCase())) continue; // API_BASE / AGNES_API_BASE 等前缀不是上游名
      const p = ensure(m[1].toLowerCase());
      if (m[2] === 'BASES') p.basesRaw = env[k];
      else p.baseSingle = env[k].trim().replace(/\/+$/, '');
    }
  }
  return order;
}

module.exports = {
  name: 'hybrid',
  displayName: 'Hybrid (multi-provider)',

  // 下列字段在 preprocessEnv 里按实际配置的成员动态填充。这里给的是「尚未预处
  // 理时」的占位值——正常启动路径一定先经 loadConfig → preprocessEnv（无分节配
  // 置会在那里报配置错误、走不到 server），占位值只防御非常规的直接引用。
  defaultSpoof: 'claude-opus-4-8',
  defaultTarget: '',
  modelMaxTokens: {},
  modelContextWindow: {},

  // 成员 adapter 表（preprocessEnv 填充）：{ providerName: adapter }。
  _members: {},

  // 配置预处理钩子（core/config.js 在解析平铺变量前调用）：把分节配置摊平为
  // 框架标准平铺变量，并填充本 adapter 的成员表 / 合并模型表 / 默认对。
  // 抛出的 Error 由 loadConfig 捕获记入 providerConfigError、validate 报给用户。
  preprocessEnv(env) {
    const providers = discoverProviders(env);
    if (!providers.length) {
      throw new Error(
        'no provider sections found — hybrid needs at least one provider, e.g. ' +
        'GLM_BASES=… + GLM_API_KEY_1=… and/or DS_BASE=… + DS_API_KEY_1=… (see hybrid.env.example)',
      );
    }
    // 混用检查：分节与平铺（API_BASES / API_BASE / API_KEY / API_KEY_n）同时出现
    // 必是配置错误（照抄了别的上游的 env），直接报——混合摊平的语义说不清。
    const flatVars = Object.keys(env).filter(
      (k) => k === 'API_BASES' || k === 'API_BASE' || k === 'API_KEY' || /^API_KEY_\d+$/.test(k),
    );
    if (flatVars.length) {
      throw new Error(
        `mixed provider sections (${providers.map((p) => p.name).join(', ')}) and flat variables ` +
        `(${flatVars.join(', ')}) — hybrid config uses per-provider sections only`,
      );
    }

    // 逐节校验并归一（端点列表 / KEY 列表 / KEY 属性绑定）。
    for (const p of providers) {
      const P = p.name.toUpperCase();
      if (p.name === 'hybrid') {
        throw new Error('hybrid cannot nest itself as a provider — combine concrete upstreams (glm / ds / mimo …)');
      }
      if (!isImplemented(p.name)) {
        throw new Error(`provider '${p.name}' is reserved but not implemented yet (section ${P}_…)`);
      }
      if (p.basesRaw != null && String(p.basesRaw).trim()) {
        p.bases = parseBases(p.basesRaw, `${P}_BASES`);
      } else if (p.baseSingle) {
        p.bases = [{ name: 'default', url: p.baseSingle }];
      }
      if (!p.bases.length) {
        throw new Error(`provider '${p.name}' has no endpoint — set ${P}_BASES or ${P}_BASE`);
      }
      p.keyList = [...p.keys.values()].filter((r) => r.value).sort((a, b) => a.n - b.n);
      if (!p.keyList.length) {
        throw new Error(`provider '${p.name}' has no key — set at least one ${P}_API_KEY_n`);
      }
      for (const r of p.keyList) {
        if (r.baseName && !p.bases.some((b) => b.name === r.baseName)) {
          throw new Error(
            `${P}_API_KEY_${r.n}_BASE="${r.baseName}" does not match any endpoint of provider '${p.name}' ` +
            `(available: ${p.bases.map((b) => b.name).join(', ')})`,
          );
        }
      }
    }

    // 加载成员 adapter，合并模型表（qualified 键）并建立「裸模型名 → 成员」索引
    //（MODEL_MAP 省略 provider 时的自动限定依据；多家都认识标记为歧义）。
    const members = {};
    const modelOwner = new Map();
    const ambiguous = new Set();
    const mergedMax = {};
    const mergedCW = {};
    for (const p of providers) {
      const ad = loadAdapter(p.name);
      members[p.name] = ad;
      const known = new Set([
        ...Object.keys(ad.modelMaxTokens || {}),
        ...Object.keys(ad.modelContextWindow || {}),
      ]);
      if (ad.defaultTarget) known.add(ad.defaultTarget);
      for (const model of known) {
        if (modelOwner.has(model)) ambiguous.add(model);
        else modelOwner.set(model, p.name);
      }
      for (const [model, cap] of Object.entries(ad.modelMaxTokens || {})) {
        mergedMax[`${p.name}:${model}`] = cap;
      }
      for (const [model, cw] of Object.entries(ad.modelContextWindow || {})) {
        mergedCW[`${p.name}:${model}`] = cw;
      }
    }

    // MODEL_MAP / TARGET_MODEL 的 target 限定为「provider:model」。
    const providersSet = new Set(providers.map((p) => p.name));
    const qualify = (target, where) => {
      const { provider, model } = splitQualified(target);
      if (provider != null) {
        if (!providersSet.has(provider)) {
          throw new Error(`${where}: provider '${provider}' is not configured (providers: ${[...providersSet].join(', ')})`);
        }
        if (!model) throw new Error(`${where}: missing model after '${provider}:'`);
        return target;
      }
      if (ambiguous.has(target)) {
        throw new Error(`${where}: model '${target}' is known by multiple providers — qualify it as 'provider:${target}'`);
      }
      if (modelOwner.has(target)) return `${modelOwner.get(target)}:${target}`;
      throw new Error(
        `${where}: model '${target}' is not known by any configured provider ` +
        `(known: ${[...modelOwner.keys()].sort().join(', ')})`,
      );
    };
    if (String(env.MODEL_MAP || '').trim()) {
      env.MODEL_MAP = parsePairs(env.MODEL_MAP)
        .map((pp) => `${pp.spoof}->${qualify(pp.target, `MODEL_MAP entry "${pp.spoof}->${pp.target}"`)}`)
        .join(',');
    }
    if (String(env.TARGET_MODEL || '').trim()) {
      env.TARGET_MODEL = qualify(env.TARGET_MODEL.trim(), `TARGET_MODEL "${env.TARGET_MODEL.trim()}"`);
    }

    // 摊平为框架标准平铺变量：端点名加「<provider>-」前缀（防跨节撞名，也是
    // routeKeys 按 KEY 归属成员的依据）；KEY 跨节统一重编号（跳过空值行）；未显
    // 式绑端点的 KEY 绑到本节第一个端点（不是全局第一个——那是别家成员的）。
    const flatBases = [];
    let j = 0;
    for (const p of providers) {
      for (const b of p.bases) flatBases.push({ name: `${p.name}-${b.name}`, url: b.url });
      for (const r of p.keyList) {
        j++;
        env[`API_KEY_${j}`] = r.value;
        const bind = r.baseName || p.bases[0].name;
        env[`API_KEY_${j}_BASE`] = `${p.name}-${bind}`;
        if (r.name) env[`API_KEY_${j}_NAME`] = r.name;
        if (r.priorityRaw) env[`API_KEY_${j}_PRIORITY`] = r.priorityRaw;
        if (r.hideUserIdRaw) env[`API_KEY_${j}_HIDE_USER_ID`] = r.hideUserIdRaw;
      }
    }
    env.API_BASES = flatBases.map((b) => `${b.name}->${b.url}`).join(',');

    // 填充本 adapter 的动态字段（module 单例上生效；server / resolvePairs /
    // buildModelUsage 都在 loadConfig 之后运行，读到的已是填充后的值）。
    this._members = members;
    this.modelMaxTokens = mergedMax;
    this.modelContextWindow = mergedCW;
    this.defaultTarget = `${providers[0].name}:${members[providers[0].name].defaultTarget}`;
  },

  // 请求体适配：剥掉 obj.model 的「provider:」前缀（上游只认裸模型名——server 在
  // 改写 spoof→target 时写进的是 qualified target），然后委派给成员 adapter 做
  // 该上游的专属适配（GLM 钳 max_tokens、DeepSeek 修 tool 序列等）。ctx.target
  // 无前缀（异常防御）时原样透传、不委派。
  adaptRequestBody(obj, ctx) {
    if (!obj || typeof obj !== 'object') return obj;
    const { provider, model } = splitQualified((ctx && ctx.target) || this.defaultTarget);
    if (provider && model) {
      obj.model = model;
      const member = this._members[provider];
      if (member && typeof member.adaptRequestBody === 'function') {
        return member.adaptRequestBody(obj, { target: model });
      }
    }
    return obj;
  },

  // 请求级 KEY 收窄钩子（core/server.js 每请求调用）：按 target 的 provider 前缀
  // 返回该成员的 KEY 索引数组。KEY 归属看摊平时生成的 baseName（恒为
  // 「<provider>-<端点名>」或恰为「<provider>」）。返回 null 表示不收窄（识别
  // 不了 provider 的防御路径），空数组由 server 兜底报错（不误路由到别家）。
  routeKeys(target, keys) {
    const { provider } = splitQualified(target);
    if (!provider) return null;
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      const bn = keys[i] && keys[i].baseName;
      if (bn === provider || (bn && bn.startsWith(provider + '-'))) out.push(i);
    }
    return out;
  },
};
