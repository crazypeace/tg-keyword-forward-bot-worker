import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "tg-keyword-forward",
    compatibilityDate: "2026-10-08",
    entrypoint: "src/index.js",
    env: {
      // 公开变量
      FORUM_CHAT_ID: bindings.text("-1002133460865"),
      CHANNEL_CHAT_ID: bindings.text("-1002118991610"),
      // 命令白名单(逗号分隔,可填 user / channel / group 的 id)
      ADMIN_WHITELIST: bindings.text("-1002133460865,391932510"),
      // KV:关键字/排除关键字
      STORE: bindings.kv({ id: "2a0379a8612c46d79ee29f940e4a68fa" }),
      // 机密(通过 cf workers secrets update 设置,永不写进配置)
      BOT_TOKEN: bindings.secret(),
      WEBHOOK_SECRET_TOKEN: bindings.secret(),
    },
  },
});
