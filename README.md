# koishi-plugin-mcstatus

在 Koishi 里按关键词查 Minecraft 服务器状态：命中关键词 → 向 [mcstatus-api](https://github.com/Plantrian/MCstatus) 请求状态图 / JSON → 发到当前会话。

关键词和每个关键词对应的请求参数**全部在 Koishi 控制台里表单配置**，不用手改 JSON。跟之前那个 NapCat 插件（`napcat-plugin-mcstatus`）是同一套请求逻辑，只是搬到 Koishi 上、配置搬进了控制台。

## 安装

```bash
# 在 Koishi 项目根目录
npm install /path/to/koishi-plugin-mcstatus
# 或者把整个文件夹丢进 node_modules/
```

然后在 `koishi.yml` 里加一段：

```yaml
plugins:
  mcstatus:
    apiBaseUrl: http://127.0.0.1:3002
```

启动后打开控制台 → 插件配置 → `mcstatus`，右边就是表单，改完点右上角保存即可生效（配置会写回 `koishi.yml`）。

## 配置项

### 基础设置

| 字段 | 说明 |
| --- | --- |
| `apiBaseUrl` | mcstatus-api 地址。填 `http://主机:端口` 会自动补接口路径；填完整接口地址（带 `/api/xxx.png`）则原样使用 |
| `sendMode` | `buffer` 插件自己下载再发（失败会回原因）；`url` 把图片地址交给适配器拉取 |
| `timeout` | 请求超时，默认 15000 ms |
| `cooldown` | 同一会话同一规则的冷却秒数，默认 5，填 0 关闭 |
| `rulesFile` | 直接指向 NapCat 版那份 `rules.json`，两个机器人共用同一份规则文件 |
| `rules` | 关键词 → 请求 的映射表（也可以纯用控制台配，和 `rulesFile` 并存时文件里的优先） |

### 触发范围

| 字段 | 说明 |
| --- | --- |
| `allowPrivate` | 允许私聊触发 |
| `groupWhitelist` | 只在这些群生效，留空 = 所有群 |
| `requireAt` | 群里必须 @机器人 才触发 |
| `silenceOnError` | 请求失败时闭嘴不回复 |
| `debug` | 控制台打印命中的规则和请求地址 |

### 单条规则（rules[n]）

| 字段 | 说明 |
| --- | --- |
| `enabled` | 开关 |
| `keyword` | 关键词数组，多个即别名；命中任意一个即可 |
| `match` | `exact` 整条消息完全相同 / `contains` 包含即可 / `regex` 正则 |
| `endpoint` | `banner` 单服状态图 / `overview` 多服一览图 / `status` 单服 JSON / `overview-json` 多服 JSON（后两个发文字） |
| `apiBaseUrl` | 这条规则单独用的 API 地址，留空走全局 |
| `host` `port` `queryPort` `name` | 单服参数，`name` 是图上标题，不写则显示 `host:port` |
| `servers` | 多服列表，逗号分隔，`[显示名@]host[:port[:queryPort]]`，`overview` 用 |
| `theme` `layout` `style` `scale` | 出图外观，留空用服务端默认；`scale` 1/2/3 对应 800×400 / 1600×800 / 2400×1200 |
| `extraQuery` | 额外查询参数，原样拼到地址后面，如 `refresh=1&timeout=8000` |
| `beforeText` | 发图前先说一句 |
| `cooldownSeconds` | 单条规则自己的冷却，留空走全局 |

## 和 NapCat 版共用 rules.json

`rulesFile` 填 NapCat 那份 `rules.json` 的绝对路径就行，不用转换、不用复制：

```yaml
plugins:
  mcstatus:
    apiBaseUrl: http://127.0.0.1:3002
    rulesFile: /home/yunxi/napcat-plugin-mcstatus/rules.json
```

- 每次收消息都会按「mtime + 文件大小」判断要不要重读，改完保存即生效，和 NapCat 那边看到的是同一份规则。
- `params` 两种写法都认：对象（`{"host": "...", "theme": "mono"}`）和查询串（`"?host=...&theme=..."`）。
- `keyword` 写字符串、逗号分隔、数组都行；`endpoint`、`match`、`apiBaseUrl`、`beforeText`、`cooldownSeconds`、顶层 `servers` 全部沿用原字段名。
- 未知的查询参数（比如 `refresh=1`）会原样拼到请求地址后面，不会丢。
- 文件里的规则排在控制台 `rules` 前面，同名关键词以文件为准。

## 和 NapCat 版的区别

| | napcat-plugin-mcstatus | 本插件 |
| --- | --- | --- |
| 规则来源 | `rules.json`（JSONC，热加载） | `rulesFile` 指向同一份文件 / 控制台表单，两者可并存 |
| 消息来源 | NapCat 插件事件 / OneBot WS 客户端 | Koishi `message` 事件，所有适配器通用 |
| 请求逻辑 | 拼 URL → 拉 PNG → 失败回原因 | 同 |
| 发图 | `base64://` 或 URL | Buffer 或 URL，按适配器自动编码 |
| 冷却 / 白名单 / 私聊开关 | 配置里的固定字段 | 控制台可改，规则也能单独设冷却 |

## 行为细节

- banner / overview 接口就算参数错了也会回一张说明图（PNG），这种情况照常发图，不报错。
- `status` 返回的 JSON 会缩进后按文字发送，超过 1200 字截断。
- 只有连不上 / 超时 / 返回的不是 PNG 才算失败，此时回一句「服务器状态查询失败：原因」。

## 测试

```bash
cd ../koishi-test && npm test   # 需要一个跑着的 mcstatus-api
```

覆盖：banner / overview / status / 别名 / contains / regex / 前置文字 / 冷却 / 禁用规则 / 未命中不回复 / 私聊 / API 不可达 / 错误图照发，共 13 项。
