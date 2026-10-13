# tg-keyword-forward 部署文档

> 项目：监听 Telegram channel 新消息，按关键字转发到 forum 群对应 topic 的 Cloudflare Worker。
> 线上地址：`https://tg-keyword-forward.icdyct.workers.dev`

## 1. 架构概览

```
Telegram channel (-1002118991610)
        │ channel_post (webhook)
        ▼
Cloudflare Worker: tg-keyword-forward
  ├─ 关键字匹配 → forward 到对应 topic
  ├─ 未命中 → forward 到 #General（省略 message_thread_id）
  ├─ 命中排除关键字 → 丢弃
  └─ bot 命令：/start /add_keyword /remove_keyword /add_exclude /remove_exclude /list_keywords
        │
        ▼
Telegram forum 群 (-1002133460865)
KV: tg-keyword-store ── 单键 `config` 存 `{keywords, excludes}`（每条 channel 消息只读 1 次）
```

机密（`BOT_TOKEN`、`WEBHOOK_SECRET_TOKEN`）只存 Cloudflare secret，不进代码和配置文件。

## 2. 前置条件

- Cloudflare 账号，已用 `cf auth login` 登录（OAuth 登录态保存在 `~/.config/cloudflare/`，机器重置后仍在）
- `cf` CLI：`npm install --global cf`（沙箱环境重置后二进制会丢，重装一次即可，**无需**重新登录）
- Node.js + npm（项目用 `wrangler` 作 dev server，已在 devDependencies 中）
- Bot token（找 @BotFather 拿）
- Bot 权限：
  - 在 channel 里是 **管理员**（否则收不到 `channel_post` 推送）
  - 在 forum 群里是 **管理员**（建 topic、发消息需要）

## 3. 项目结构

```
tg-keyword-forward/
├── src/index.js              # worker 主逻辑（webhook / 命令 / 转发）
├── cloudflare.config.ts      # cf 配置：公开变量 + 绑定声明（机密只声明不填值）
├── package.json
├── README.md                 # 功能说明
├── DEPLOY.md                 # 本文档
├── .secrets.local            # 本地机密文件（chmod 600，不提交）
├── .webhook_secret.local     # webhook secret 备份（chmod 600，不提交）
└── .gitignore
```

## 4. 首次部署

### 4.1 安装依赖

```bash
cd tg-keyword-forward
npm install
```

### 4.2 创建 KV namespace

```bash
cf kv namespaces create --title tg-keyword-store
# 记下返回的 id，填到 cloudflare.config.ts 里：
#   STORE: bindings.kv({ id: "<namespace-id>" }),
```

### 4.3 检查 `cloudflare.config.ts`

```ts
worker: {
  name: "tg-keyword-forward",
  env: {
    FORUM_CHAT_ID: bindings.text("-1002133460865"),     // forum 群 id
    CHANNEL_CHAT_ID: bindings.text("-1002118991610"),    // channel id
    ADMIN_WHITELIST: bindings.text("-1002133460865,391932510"), // 命令白名单：user/channel/group id，逗号分隔
    STORE: bindings.kv({ id: "<kv-namespace-id>" }),
    BOT_TOKEN: bindings.secret(),            // 只声明，值用 secret 方式注入
    WEBHOOK_SECRET_TOKEN: bindings.secret(), // 只声明，值用 secret 方式注入
  },
}
```

### 4.4 准备机密文件

```bash
openssl rand -hex 32   # 生成 webhook secret，记下来
cat > .secrets.local <<'EOF'
BOT_TOKEN=<bot token>
WEBHOOK_SECRET_TOKEN=<上一步生成的 secret>
EOF
chmod 600 .secrets.local
echo "<上一步生成的 secret>" > .webhook_secret.local && chmod 600 .webhook_secret.local
```

### 4.5 部署

```bash
# 首次部署（新 worker 必须用 --secrets-file 一次把 secrets 带上）：
cf deploy --secrets-file .secrets.local

# 之后日常更新代码/配置：
cf deploy
```

> 注意：曾遇到首次部署显示 Uploaded 但实际 404 的情况，再跑一次 `cf deploy` 即恢复。

### 4.6 单独更新 secret（如需更换）

```bash
cf workers secrets update BOT_TOKEN --worker tg-keyword-forward --text "<新token>" --type secret_text
cf workers secrets update WEBHOOK_SECRET_TOKEN --worker tg-keyword-forward --text "<新secret>" --type secret_text
```

### 4.7 设置 Telegram webhook

```bash
WS=$(cat .webhook_secret.local)
curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://tg-keyword-forward.icdyct.workers.dev/webhook\",\"secret_token\":\"$WS\",\"allowed_updates\":[\"message\",\"channel_post\"],\"drop_pending_updates\":true}"
```

换了 `WEBHOOK_SECRET_TOKEN` 后必须重设 webhook（secret_token 要一致）。

## 5. 部署验证

```bash
# 1. worker 存活
curl https://tg-keyword-forward.icdyct.workers.dev/   # 应返回 tg-keyword-forward ok

# 2. webhook 状态（pending 应为 0，last_error_message 应为空）
curl -X POST "https://api.telegram.org/bot<token>/getWebhookInfo"

# 3. 命令：在 forum 群里发 /start，应收到命令列表
# 4. 加关键字：/add_keyword /test/i，应自动建 topic 并回复确认
#    查 KV 确认落盘：
cf kv keys get keywords --namespace-id <kv-namespace-id>

# 5. 转发：在 channel 发一条含 test 的消息，应出现在对应 topic；不含关键字的进 #General
```

## 6. 运维常用命令

```bash
# 查看关键字 / 排除关键字
cf kv keys get keywords --namespace-id <id>
cf kv keys get excludes --namespace-id <id>

# 重新部署
cf deploy

# 查看 worker 列表
cf workers list
```

## 7. 故障排查（实战踩坑记录）

| 现象 | 原因 | 处理 |
|---|---|---|
| `cf: command not found` | 沙箱环境重置，二进制丢失（登录态还在） | `npm install --global cf` 重装即可 |
| 部署后访问 404 / `error code: 1042` | 首次部署未真正生效 | 再跑一次 `cf deploy` |
| `/start` 无响应，其他命令正常 | 帮助文本含裸 `<正则>`，`parse_mode=HTML` 解析失败导致 sendMessage 报错 | 所有用户可见文本必须 HTML 转义 |
| channel 消息没进 #General | `message_thread_id=1` 在该群无效（`message thread not found`） | General 转发时**省略**该参数 |
| 私聊 `/add_keyword` 报 `the chat is not a forum` | 建 topic 用了当前聊天的 id | 固定用 `FORUM_CHAT_ID` 建 topic |
| 非白名单用户发命令没反应 | 符合预期：白名单外的命令直接忽略、不回复 | 检查 `ADMIN_WHITELIST` |
| webhook `last_error_message` 有 404 | 部署切换瞬间的抖动 | 一般自愈，确认 `pending_update_count` 为 0 即可 |
| 刚加的关键字不生效 | KV 最终一致性，全球同步要几十秒 | 等一分钟再试 |

## 8. 安全注意事项

- `BOT_TOKEN` 永不写入代码、配置、文档或 git，只通过 Cloudflare secret 注入
- `.secrets.local` / `.webhook_secret.local` 保持 600 权限，`.gitignore` 已排除
- webhook 校验请求头的 `x-telegram-bot-api-secret-token`，不对直接 403
- 本地项目目录含真实机密，**不要**直接公开推送；如需开源，参考 tg-group-verify 的做法先做脱敏包

## 9. 已知限制

- Bot API 发出的消息永远显示 bot 本人身份；群"匿名管理员"权限对 bot 无效（Telegram 官方文档明确写了）
- Bot API 拿不到 channel 历史消息；bot 非 channel 管理员时连 `channel_post` 推送都收不到
- 为节约 KV 写额度，不记录单条消息处理状态；极端情况（转发成功但响应丢失后 Telegram 重试）可能重复转发
- 转发失败时 worker 回 500 触发 Telegram 退避重试；命令类更新始终回 200（避免重试导致重复建 topic）
