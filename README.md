# tg-keyword-forward

Cloudflare Worker 驱动的 Telegram bot：监听指定 channel 的新消息，按关键字转发到 forum 群组的对应 topic。

- worker：`tg-keyword-forward` → https://tg-keyword-forward.icdyct.workers.dev
- bot：@crazypeace_keyword_alert_1_bot（token 只存 Cloudflare secret，不在仓库/文档里）
- channel：-1002118991610（@FuckGFWNewbieNeedHelp）
- forum：-1002133460865
- KV：`tg-keyword-store`（`2a0379a8612c46d79ee29f940e4a68fa`），单键 `config` 存 `{keywords, excludes}`

## 转发规则

1. 消息命中**排除关键字** → 不转发
2. 命中**关注关键字** → forward 到对应 topic（多个命中时取最早添加的）
3. 都没命中 → forward 到 #General（**省略** `message_thread_id` 参数；实测 `message_thread_id=1` 会报 `message thread not found`）

匹配文本取 `text` / `caption`（无文本的纯媒体也转发到 #General）。配置（关注关键字 + 排除关键字）合并存在 KV 单键 `config` 中；每条 channel 消息只读 **1 次** KV，0 次写（不记录单条消息处理状态）。转发失败时 worker 回 500 让 Telegram 退避重试（命令类更新始终回 200，避免重试重复执行）。

## 命令（含 /start 在内的所有命令均受白名单门禁）

白名单配在 `cloudflare.config.ts` 的 `ADMIN_WHITELIST`（逗号分隔，可填 user / channel / group 的 id）；
发送者 id 或所在 chat id 任一在名单中即放行，否则**直接忽略、不回复**。

| 命令 | 说明 |
|---|---|
| `/start` | 回复命令列表 |
| `/add_keyword <正则>` | 添加关注关键字，自动在 forum 建对应 topic |
| `/remove_keyword <正则>` | 移除关注关键字（topic 不删除，改名前加 🚫 标记停用） |
| `/add_exclude <正则>` | 添加排除关键字 |
| `/remove_exclude <正则>` | 移除排除关键字 |
| `/list_keywords` | 查看所有关键字 |

正则写法：`/kw1|kw2/i`（尾随 `i` = 不区分大小写）或裸写 `kw1|kw2`（区分大小写）。只支持 `i` 标记。

## 部署

完整部署流程见 [DEPLOY.md](./DEPLOY.md)。快速参考：

```bash
npm install
cf deploy --secrets-file .secrets.local   # 首次部署；.secrets.local 本地自建(600 权限)，绝不提交
cf deploy                                  # 日常更新
```

## 已知限制

- bot 通过 Bot API 发消息永远显示 bot 身份，"匿名管理员"权限对 bot 无效（Telegram 官方文档明确）。
- `getUpdates` 拿不到 channel 历史；公开 channel 可从 `t.me/s/<username>` 取消息 ID。
- KV 是最终一致性：刚 `/add_keyword` 的几十秒内，极少数 channel 消息可能仍走旧规则。
