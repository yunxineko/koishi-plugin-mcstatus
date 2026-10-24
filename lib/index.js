/**
 * koishi-plugin-mcstatus
 * ---------------------------------------------------------------------------
 * 收到关键词 → 按规则向 mcstatus-api 请求状态图 / JSON → 发到当前会话。
 *
 * 所有配置（全局地址、触发范围、关键词 → 请求参数 的映射表）都在 Koishi
 * 控制台的插件配置页里以表单形式编辑，不需要手改 JSON 文件。
 * ---------------------------------------------------------------------------
 */

'use strict'

const fs = require('node:fs')

const { Schema, h } = require('koishi')

/** endpoint 字段 → mcstatus-api 路径 */
const ENDPOINTS = {
  banner: '/api/banner.png',
  overview: '/api/overview.png',
  status: '/api/status',
  'overview-json': '/api/overview',
}

/** JSON 接口（结果按文字发） */
const JSON_ENDPOINTS = new Set(['status', 'overview-json'])

const THEMES = ['default', 'midnight', 'ocean', 'forest', 'sunset', 'frost', 'mono']
const LAYOUTS = ['stack', 'compact', 'split']
const STYLES = ['material', 'cosmic', 'swiss', 'organic', 'editorial']

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const name = 'mcstatus'

/* ------------------------------- 配置 Schema ------------------------------ */

const Rule = Schema.object({
  enabled: Schema.boolean().default(true).description('启用这条规则'),
  keyword: Schema.array(Schema.string())
    .default([])
    .description('触发关键词，可写多个别名（如 `乌托邦`、`mcu`）。匹配时只要命中任意一个就算。'),
  match: Schema.union(['exact', 'contains', 'regex'])
    .default('exact')
    .description('匹配方式：`exact` 整条消息完全相同 / `contains` 消息里包含即可 / `regex` 按正则匹配关键词。'),
  endpoint: Schema.union(['banner', 'overview', 'status', 'overview-json'])
    .default('banner')
    .description(
      '请求哪个接口：`banner` 单服状态图 / `overview` 多服一览图（出图）/ `status` 单服 JSON / `overview-json` 多服 JSON（后两个按文字发送）。'
    ),

  apiBaseUrl: Schema.string()
    .description('这条规则单独使用的 API 地址，留空则用上面的全局地址。填基础地址会自动补接口路径，填完整接口地址就原样使用。'),

  host: Schema.string().description('服务器地址（banner / status 必填）'),
  port: Schema.natural().description('游戏端口，默认 25565'),
  queryPort: Schema.natural().description('Query 端口，默认等于游戏端口'),
  name: Schema.string().description('图上显示的标题，留空则显示 `host:port`'),
  servers: Schema.string()
    .role('textarea')
    .description(
      '多服一览的服务器列表，逗号分隔，格式 `[显示名@]host[:port[:queryPort]]`。overview 规则用这个字段。'
    ),

  theme: Schema.union(['', ...THEMES])
    .default('')
    .description('主题，留空用服务端默认值'),
  layout: Schema.union(['', ...LAYOUTS])
    .default('')
    .description('版式，留空用主题自带的'),
  style: Schema.union(['', ...STYLES])
    .default('')
    .description('视觉语言，留空用主题自带的'),
  scale: Schema.union([Schema.const(0).description('默认'), 1, 2, 3])
    .default(0)
    .description('图片倍数：1 = 800×400，2 = 1600×800，3 = 2400×1200'),

  extraQuery: Schema.string()
    .role('textarea')
    .description('额外查询参数，直接拼在地址后面，如 `refresh=1&timeout=8000`（不需要写 `?`）'),
  beforeText: Schema.string().description('发图前先说一句，留空则直接发图'),
  cooldownSeconds: Schema.number()
    .min(0)
    .step(1)
    .description('单条规则的冷却秒数，留空则用上面的全局冷却'),
}).description('关键词规则')

const Config = Schema.intersect([
  Schema.object({
    apiBaseUrl: Schema.string()
      .default('http://127.0.0.1:3002')
      .description('mcstatus-api 的地址。可以只填 `http://主机:端口`，也可以直接填完整接口地址。'),
    sendMode: Schema.union([
      Schema.const('buffer').description('插件先下载再发送（推荐，失败会回复原因）'),
      Schema.const('url').description('把图片地址交给适配器去拉取'),
    ])
      .default('buffer')
      .description('图片发送方式'),
    timeout: Schema.number()
      .min(1000)
      .max(120000)
      .step(1000)
      .default(15000)
      .description('请求超时（毫秒）'),
    cooldown: Schema.number().min(0).step(1).default(5).description('同一会话同一规则的冷却秒数，0 = 不冷却'),
    rulesFile: Schema.string()
      .description(
        '可选：额外加载 NapCat 版 `rules.json` 的路径（本地插件用绝对路径）。填了就每次按修改时间热加载，' +
          '和 NapCat 那边共用同一份规则文件；文件里的规则优先于下面的控制台规则。'
      ),
    rules: Schema.array(Rule)
      .default([
        {
          enabled: true,
          keyword: ['mcs'],
          match: 'exact',
          endpoint: 'banner',
          host: 'play.example.com',
          port: 25565,
          name: '示例服务器',
          theme: 'mono',
          style: 'organic',
          layout: 'split',
          scale: 2,
        },
      ])
      .description('关键词 → 请求 的映射表。从上往下匹配，第一条命中的生效。'),
  }).description('基础设置'),

  Schema.object({
    allowPrivate: Schema.boolean().default(true).description('允许私聊触发'),
    groupWhitelist: Schema.array(Schema.string())
      .default([])
      .description('只在这些群生效，留空表示所有群都生效'),
    requireAt: Schema.boolean().default(false).description('群里必须 @机器人 才触发'),
    silenceOnError: Schema.boolean().default(false).description('请求失败时不回复任何内容'),
    debug: Schema.boolean().default(false).description('在控制台打印命中的规则和请求地址'),
  }).description('触发范围'),
])

/* -------------------------------- 工具函数 -------------------------------- */

/** 地址是否已经带了路径（带了就当作完整接口地址） */
function hasEndpointPath(base) {
  try {
    const { pathname } = new URL(base)
    return Boolean(pathname) && pathname !== '/'
  } catch {
    return false
  }
}

/** 把规则里的字段拼成查询串 */
function buildQuery(rule) {
  const params = new URLSearchParams()
  const put = (key, value) => {
    if (value === undefined || value === null || value === '') return
    params.set(key, String(value))
  }

  if (JSON_ENDPOINTS.has(rule.endpoint) || rule.endpoint === 'banner') {
    put('host', rule.host)
    put('port', rule.port || undefined)
    put('queryPort', rule.queryPort || undefined)
    put('name', rule.name)
  }
  if (rule.endpoint === 'overview' || rule.endpoint === 'overview-json') {
    put('servers', rule.servers)
  }

  put('theme', rule.theme)
  put('layout', rule.layout)
  put('style', rule.style)
  put('scale', rule.scale ? rule.scale : undefined)

  const parts = []
  const encoded = params.toString()
  if (encoded) parts.push(encoded)

  const extra = String(rule.extraQuery || '')
    .replace(/^\?+/, '')
    .trim()
  if (extra) parts.push(extra)

  return parts.join('&')
}

/** 拼出完整请求地址（基础地址自动补路径，完整地址原样追加参数） */
function buildUrl(apiBaseUrl, rule) {
  const base = String(apiBaseUrl || '').trim().replace(/\/+$/, '')
  const endpoint = ENDPOINTS[rule.endpoint] || ENDPOINTS.banner

  let target
  if (hasEndpointPath(base)) {
    target = base
  } else if (base.includes('?')) {
    target = base.replace('?', `${endpoint}?`)
  } else {
    target = `${base}${endpoint}`
  }

  const query = buildQuery(rule)
  if (!query) return target
  return `${target}${target.includes('?') ? '&' : '?'}${query}`
}

/** 关键词是否命中 */
function matchRule(rule, text) {
  const keywords = (rule.keyword || []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!keywords.length) return false

  return keywords.some((keyword) => {
    if (rule.match === 'regex') {
      try {
        return new RegExp(keyword, 'i').test(text)
      } catch {
        return false
      }
    }
    if (rule.match === 'contains') return text.includes(keyword)
    return text === keyword
  })
}

/* -------------------- NapCat 版 rules.json 兼容 -------------------- */

const MATCH_MODES = ['exact', 'contains', 'regex']
const PARAM_KEYS = ['host', 'port', 'queryPort', 'name', 'servers', 'theme', 'layout', 'style', 'scale']

/** 去掉 // 与 块注释（字符串内部不动） */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        if (next !== undefined) {
          out += next
          i += 1
        }
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    out += char
  }
  return out
}

/** 去掉尾随逗号（],}），字符串内部不动 */
function removeTrailingCommas(text) {
  let out = ''
  let inString = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      out += char
      if (char === '\\') {
        const next = text[i + 1]
        if (next !== undefined) {
          out += next
          i += 1
        }
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ',') {
      // 逗号后面如果只有空白就遇到 ] 或 }，说明是尾随逗号
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === ']' || text[j] === '}') continue
    }
    out += char
  }
  return out
}

function parseJsonc(text) {
  return JSON.parse(removeTrailingCommas(stripJsonComments(String(text).replace(/^\uFEFF/, ''))))
}

/** 关键词：字符串 / 逗号分隔 / 数组 */
function splitKeywords(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

/** 把 NapCat 的一条规则转成插件内部结构 */
function toRule(raw) {
  if (!raw || typeof raw !== 'object') return null

  const keywords = splitKeywords(raw.keyword ?? raw.keywords)
  if (!keywords.length) return null

  const rule = {
    enabled: raw.enabled !== false,
    keyword: keywords,
    match: MATCH_MODES.includes(raw.match) ? raw.match : 'exact',
    endpoint: Object.prototype.hasOwnProperty.call(ENDPOINTS, raw.endpoint) ? raw.endpoint : 'banner',
    apiBaseUrl: raw.apiBaseUrl || '',
    host: '',
    port: undefined,
    queryPort: undefined,
    name: '',
    servers: raw.servers || '',
    theme: '',
    layout: '',
    style: '',
    scale: 0,
    extraQuery: '',
    beforeText: raw.beforeText || '',
    cooldownSeconds: typeof raw.cooldownSeconds === 'number' ? raw.cooldownSeconds : undefined,
  }

  const extras = []
  const applyParams = (params) => {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      if (PARAM_KEYS.includes(key)) rule[key] = value
      else extras.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  }

  if (typeof raw.params === 'string') {
    const query = raw.params.replace(/^\?+/, '').trim()
    if (query) {
      try {
        applyParams(Object.fromEntries(new URLSearchParams(query)))
      } catch {
        extras.push(query)
      }
    }
  } else if (raw.params && typeof raw.params === 'object') {
    applyParams(raw.params)
  }

  if (extras.length) rule.extraQuery = extras.join('&')
  if (!rule.scale || rule.scale === '0') rule.scale = 0

  return rule
}

/** rules.json 读取器：按 mtime + size 判断要不要重读，改完存盘即生效 */
function createRulesFile(getConfig, logger) {
  let cache = { key: null, rules: [] }

  return function readFileRules() {
    const file = String(getConfig().rulesFile || '').trim()
    if (!file) return []
    if (!fs.existsSync(file)) {
      if (cache.key !== 'missing:' + file) {
        cache = { key: 'missing:' + file, rules: [] }
        logger.warn(`rulesFile 不存在：${file}`)
      }
      return []
    }

    try {
      const stat = fs.statSync(file)
      const key = `${file}:${stat.mtimeMs}:${stat.size}`
      if (key === cache.key) return cache.rules

      const data = parseJsonc(fs.readFileSync(file, 'utf8'))
      const list = Array.isArray(data) ? data : data.rules || []
      const rules = list.map(toRule).filter(Boolean)
      cache = { key, rules }
      logger.info(`rules.json 已加载 ${rules.length} 条规则（${file}）`)
      return rules
    } catch (error) {
      const reason = (error && error.message) || String(error)
      logger.warn(`rules.json 读取失败${cache.rules.length ? '，沿用上次结果' : ''}：${reason}`)
      return cache.rules
    }
  }
}

function isPng(buffer) {
  if (!buffer || buffer.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
}

/** 带超时的请求，返回 { buffer, status, type } */
async function request(url, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeout) || 15000))
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    const buffer = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get('content-type') || ''
    return { buffer, status: response.status, type }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error(`请求超时（${Math.round((Number(timeout) || 15000) / 1000)} 秒内没有响应）`)
    }
    const code = (error && error.cause && error.cause.code) || (error && error.code)
    throw new Error(`无法连接 mcstatus-api（${code || (error && error.message) || '网络错误'}）`)
  } finally {
    clearTimeout(timer)
  }
}

/** JSON 结果压成适合聊天窗口的文字 */
function formatJson(buffer, limit = 1200) {
  let text
  try {
    text = JSON.stringify(JSON.parse(buffer.toString('utf8')), null, 2)
  } catch {
    text = buffer.toString('utf8')
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/* -------------------------------- 插件主体 -------------------------------- */

function apply(ctx, config) {
  const logger = ctx.logger('mcstatus')
  /** 冷却表：`会话:规则下标` → 过期时间 */
  const cooldown = new Map()

  const rules = () => (Array.isArray(config.rules) ? config.rules : [])
  const readFileRules = createRulesFile(() => config, logger)

  /** rules.json 里的规则在前，控制台里的规则在后 */
  const allRules = () => [...readFileRules(), ...rules()]

  /** 取出纯文本 + 是否 @ 了机器人 */
  function parseSession(session) {
    const stripped = session.stripped || session
    const text = String(stripped.content || session.content || '')
      .replace(/<[^>]+>/g, '')
      .trim()
    const atSelf = Boolean(stripped.hasAt || stripped.appel || (session.stripped && session.stripped.atSelf))
    return { text, atSelf }
  }

  function inWhitelist(session) {
    const list = (config.groupWhitelist || []).map(String).filter(Boolean)
    if (!list.length) return true
    return list.includes(String(session.guildId || session.channelId || ''))
  }

  async function handle(session) {
    if (!session || session.userId === session.selfId) return
    if (session.isDirect && !config.allowPrivate) return
    if (!session.isDirect && !inWhitelist(session)) return

    const { text, atSelf } = parseSession(session)
    if (!text) return
    if (config.requireAt && !session.isDirect && !atSelf) return

    const list = allRules()
    const index = list.findIndex((rule) => rule.enabled !== false && matchRule(rule, text))
    if (index < 0) return
    const rule = list[index]

    const key = `${session.channelId || session.userId}:${index}`
    const wait = rule.cooldownSeconds ?? config.cooldown
    if (wait > 0) {
      const now = Date.now()
      if ((cooldown.get(key) || 0) > now) {
        if (config.debug) logger.info(`冷却中，忽略「${text}」`)
        return
      }
      cooldown.set(key, now + wait * 1000)
      if (cooldown.size > 500) {
        for (const [k, expireAt] of cooldown) if (expireAt <= now) cooldown.delete(k)
      }
    }

    const url = buildUrl(rule.apiBaseUrl || config.apiBaseUrl, rule)
    if (config.debug) logger.info(`命中「${text}」→ ${url}`)

    const prefix = rule.beforeText ? [h.text(rule.beforeText)] : []
    const isJson = JSON_ENDPOINTS.has(rule.endpoint)

    try {
      if (!isJson && config.sendMode === 'url') {
        await session.send([...prefix, h.image(url)])
        return
      }

      const { buffer, status, type } = await request(url, config.timeout)

      if (isJson) {
        const ok = status >= 200 && status < 300
        if (!ok && config.silenceOnError) return
        await session.send([...prefix, h.text(formatJson(buffer))])
        return
      }

      if (!isPng(buffer)) {
        const snippet = buffer.toString('utf8', 0, 200).replace(/\s+/g, ' ').trim()
        throw new Error(`API 返回的不是 PNG（HTTP ${status}${type ? ` ${type}` : ''}${snippet ? `：${snippet}` : ''}）`)
      }

      await session.send([...prefix, h.image(buffer, 'image/png')])
    } catch (error) {
      const reason = (error && error.message) || String(error)
      logger.warn(`查询失败（${url}）：${reason}`)
      if (config.silenceOnError) return
      await session.send(h.text(`服务器状态查询失败：${reason}`))
    }
  }

  ctx.on('message', (session) => {
    handle(session).catch((error) => logger.error(error))
  })

  // 控制台里有用的提示
  ctx.on('ready', () => {
    const fileCount = readFileRules().length
    const enabled = rules().filter((rule) => rule.enabled !== false)
    logger.info(`已加载 ${enabled.length + fileCount} 条规则（rules.json ${fileCount} 条 + 控制台 ${enabled.length} 条）| API: ${config.apiBaseUrl}`)
  })
}

module.exports = { name, Config, apply }
