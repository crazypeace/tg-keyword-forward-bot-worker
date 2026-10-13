// tg-keyword-forward: 监听 channel 新消息，按关键字转发到 forum 的对应 topic
//
// 流程:
//   channel_post -> 取 text/caption -> 命中排除关键字则丢弃
//   -> 命中关注关键字则 forward 到对应 topic(首个命中的关键字胜出)
//   -> 都没命中则 forward 到 #General (message_thread_id = 1)
//
// 命令(管理命令仅 forum 群组内、仅管理员可用):
//   /start            回复命令列表
//   /add_keyword <正则>    添加关注关键字(自动在 forum 建对应 topic)
//   /remove_keyword <正则> 移除关注关键字(不删除已建的 topic)
//   /add_exclude <正则>    添加排除关键字
//   /remove_exclude <正则> 移除排除关键字
//   /list_keywords         查看所有关键字
//
// 正则写法: /kw1|kw2/i (尾随 i = 不区分大小写) 或裸写 kw1|kw2 (区分大小写)
// 关键字与排除列表存在 KV 中。

const KV_CONFIG = "config"; // keywords + excludes 合并存一项,每次处理只读一次 KV

const COMMANDS_HELP = [
  "/start - 回复命令列表",
  "/add_keyword <正则> - 添加关注关键字(自动建 topic)",
  "/remove_keyword <正则> - 移除关注关键字(topic 改名加 🚫 停用)",
  "/add_exclude <正则> - 添加排除关键字",
  "/remove_exclude <正则> - 移除排除关键字",
  "/list_keywords - 查看所有关键字",
].join("\n");

/* ---------------- Telegram API ---------------- */
async function tg(env, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error(`tg ${method} failed:`, JSON.stringify(data).slice(0, 500));
  }
  return data;
}

async function reply(env, chatId, text, threadId) {
  const params = { chat_id: chatId, text, parse_mode: "HTML" };
  if (threadId) params.message_thread_id = threadId;
  return tg(env, "sendMessage", params);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseWhitelist(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

// 白名单门禁:发送者 user id 或所在 chat id 任一在名单中即放行,
// 否则直接忽略(不回复)
function isWhitelisted(env, msg) {
  const wl = parseWhitelist(env.ADMIN_WHITELIST);
  const fromId = msg.from ? String(msg.from.id) : "";
  const chatId = String(msg.chat.id);
  return wl.has(fromId) || wl.has(chatId);
}

/* ---------------- KV ----------------
 * 配置单键存储:{ keywords: [...], excludes: [...] },
 * channel 每条消息只读一次,命令写回时整体替换。
 */
async function getConfig(env) {
  const raw = await env.STORE.get(KV_CONFIG);
  if (!raw) return { keywords: [], excludes: [] };
  try {
    const c = JSON.parse(raw);
    return {
      keywords: Array.isArray(c.keywords) ? c.keywords : [],
      excludes: Array.isArray(c.excludes) ? c.excludes : [],
    };
  } catch {
    return { keywords: [], excludes: [] };
  }
}
async function putConfig(env, config) {
  await env.STORE.put(KV_CONFIG, JSON.stringify(config));
}

/* ---------------- 正则解析 ----------------
 * 支持: /pattern/i | /pattern/ | pattern(裸写,区分大小写)
 * 只允许 i 标记。
 */
function parseUserRegex(input) {
  const s = (input || "").trim();
  if (!s) return { error: "正则表达式不能为空" };
  let pattern, flags = "";
  if (s.startsWith("/")) {
    const lastSlash = s.lastIndexOf("/");
    if (lastSlash <= 0) return { error: "格式错误,应为 /pattern/ 或 /pattern/i" };
    pattern = s.slice(1, lastSlash);
    flags = s.slice(lastSlash + 1);
    if (!/^[i]?$/.test(flags)) return { error: "只支持 i 标记(不区分大小写)" };
  } else {
    pattern = s;
  }
  if (!pattern) return { error: "正则表达式不能为空" };
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    return { error: "正则表达式无效: " + e.message };
  }
  return { source: s, pattern, flags };
}

function testEntry(entry, text) {
  try {
    return new RegExp(entry.pattern, entry.flags).test(text);
  } catch {
    return false;
  }
}

function findEntry(list, parsed, rawInput) {
  const raw = (rawInput || "").trim();
  return list.findIndex(
    (e) => e.source === raw || (parsed && !parsed.error && e.pattern === parsed.pattern && e.flags === parsed.flags)
  );
}

/* ---------------- 命令处理 ---------------- */
function splitCommand(text) {
  // "/add_keyword@botname /btc/i" -> { cmd: "/add_keyword", args: "/btc/i" }
  const firstSpace = text.search(/\s/);
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  const cmd = head.split("@")[0].toLowerCase();
  return { cmd, args };
}

async function handleCommand(env, msg) {
  // 白名单门禁(含 /start 在内的所有命令):不在名单中直接忽略,不回复
  if (!isWhitelisted(env, msg)) {
    console.log(`command from ${msg.from?.id} in chat ${msg.chat.id} ignored (not whitelisted)`);
    return;
  }

  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const { cmd, args } = splitCommand(msg.text || "");

  if (cmd === "/start") {
    await reply(env, chatId, `可用命令:\n${escHtml(COMMANDS_HELP)}`, threadId);
    return;
  }

  switch (cmd) {
    case "/add_keyword": {
      if (!args) {
        await reply(env, chatId, "用法: /add_keyword &lt;正则表达式&gt;\n例: /add_keyword /btc|eth/i", threadId);
        return;
      }
      const parsed = parseUserRegex(args);
      if (parsed.error) {
        await reply(env, chatId, `添加失败: ${escHtml(parsed.error)}`, threadId);
        return;
      }
      const config = await getConfig(env);
      const keywords = config.keywords;
      if (findEntry(keywords, parsed, args) !== -1) {
        await reply(env, chatId, "该关键字已存在。", threadId);
        return;
      }
      // 在 forum 群建对应 topic(命令可能来自私聊,不能用当前 chat_id)
      const forumChatId = Number(env.FORUM_CHAT_ID);
      const topicName = parsed.pattern.length > 96 ? parsed.pattern.slice(0, 96) : parsed.pattern;
      const created = await tg(env, "createForumTopic", { chat_id: forumChatId, name: topicName });
      if (!created.ok) {
        await reply(env, chatId, `建 topic 失败: ${escHtml(created.description || "未知错误")}`, threadId);
        return;
      }
      const topicId = created.result.message_thread_id;
      keywords.push({
        source: parsed.source,
        pattern: parsed.pattern,
        flags: parsed.flags,
        topic_id: topicId,
        topic_name: created.result.name,
        created_at: Date.now(),
      });
      await putConfig(env, config);
      const link = `https://t.me/c/${String(env.FORUM_CHAT_ID).replace("-100", "")}/${topicId}`;
      await reply(
        env,
        chatId,
        `已添加关注关键字 <code>${escHtml(parsed.source)}</code>\n对应 topic: <a href="${link}">${escHtml(created.result.name)}</a> (#${topicId})`,
        threadId
      );
      return;
    }

    case "/remove_keyword": {
      if (!args) {
        await reply(env, chatId, "用法: /remove_keyword &lt;正则表达式&gt;", threadId);
        return;
      }
      const parsed = parseUserRegex(args);
      const config = await getConfig(env);
      const keywords = config.keywords;
      const idx = findEntry(keywords, parsed.error ? null : parsed, args);
      if (idx === -1) {
        await reply(env, chatId, "未找到该关键字。", threadId);
        return;
      }
      const removed = keywords.splice(idx, 1)[0];
      await putConfig(env, config);
      // topic 不删除,改名前加 🚫 标记为停用
      let renameNote = "";
      if (removed.topic_id) {
        const renamed = Array.from(`🚫 ${removed.topic_name || removed.pattern}`).slice(0, 128).join("");
        const r = await tg(env, "editForumTopic", {
          chat_id: Number(env.FORUM_CHAT_ID),
          message_thread_id: removed.topic_id,
          name: renamed,
        });
        renameNote = r.ok
          ? `\n对应 topic 已重命名为 ${escHtml(renamed)}`
          : `\ntopic 重命名失败(${escHtml(r.description || "未知错误")})，topic 已保留`;
      }
      await reply(
        env,
        chatId,
        `已移除关注关键字 <code>${escHtml(removed.source)}</code>${renameNote}`,
        threadId
      );
      return;
    }

    case "/add_exclude": {
      if (!args) {
        await reply(env, chatId, "用法: /add_exclude &lt;正则表达式&gt;\n例: /add_exclude /spam|广告/i", threadId);
        return;
      }
      const parsed = parseUserRegex(args);
      if (parsed.error) {
        await reply(env, chatId, `添加失败: ${escHtml(parsed.error)}`, threadId);
        return;
      }
      const config = await getConfig(env);
      const excludes = config.excludes;
      if (findEntry(excludes, parsed, args) !== -1) {
        await reply(env, chatId, "该排除关键字已存在。", threadId);
        return;
      }
      excludes.push({ source: parsed.source, pattern: parsed.pattern, flags: parsed.flags });
      await putConfig(env, config);
      await reply(env, chatId, `已添加排除关键字 <code>${escHtml(parsed.source)}</code>`, threadId);
      return;
    }

    case "/remove_exclude": {
      if (!args) {
        await reply(env, chatId, "用法: /remove_exclude &lt;正则表达式&gt;", threadId);
        return;
      }
      const parsed = parseUserRegex(args);
      const config = await getConfig(env);
      const excludes = config.excludes;
      const idx = findEntry(excludes, parsed.error ? null : parsed, args);
      if (idx === -1) {
        await reply(env, chatId, "未找到该排除关键字。", threadId);
        return;
      }
      const removed = excludes.splice(idx, 1)[0];
      await putConfig(env, config);
      await reply(env, chatId, `已移除排除关键字 <code>${escHtml(removed.source)}</code>`, threadId);
      return;
    }

    case "/list_keywords": {
      const { keywords, excludes } = await getConfig(env);
      const kwLines = keywords.length
        ? keywords.map((k, i) => `${i + 1}. <code>${escHtml(k.source)}</code> → topic #${k.topic_id}`).join("\n")
        : "(无)";
      const exLines = excludes.length
        ? excludes.map((e, i) => `${i + 1}. <code>${escHtml(e.source)}</code>`).join("\n")
        : "(无)";
      await reply(env, chatId, `<b>关注关键字</b> (${keywords.length}):\n${kwLines}\n\n<b>排除关键字</b> (${excludes.length}):\n${exLines}`, threadId);
      return;
    }

    default:
      await reply(env, chatId, `未知命令。可用命令:\n${escHtml(COMMANDS_HELP)}`, threadId);
  }
}

/* ---------------- channel 消息处理 ----------------
 * 返回 true 表示处理完成(已转发/已排除),false 表示转发失败(调用方应回 500 让 Telegram 重试)。
 * 注意:#General 不能用 message_thread_id=1(实测报 message thread not found),
 * 转发到 General 时直接省略该参数。
 * 注:为节约 KV 写额度,不再记录单条消息的处理状态去重;Telegram 正常投递(回 200)
 * 不会重复推送,极端情况下(转发成功但响应丢失后触发重试)可能产生重复转发。
 */
async function handleChannelPost(env, post) {
  const channelId = String(env.CHANNEL_CHAT_ID);
  if (String(post.chat.id) !== channelId) return true;

  const text = post.text || post.caption || "";

  // 配置只读一次(单 KV 项)
  const config = await getConfig(env);

  // 1. 排除关键字:命中则不转发
  const excludes = config.excludes;
  for (const e of excludes) {
    if (testEntry(e, text)) {
      console.log(`message ${post.message_id} excluded by ${e.source}`);
      return true;
    }
  }

  // 2. 关注关键字:首个命中的转到对应 topic;否则进 #General(省略 thread 参数)
  const keywords = config.keywords;
  let topicId = null;
  for (const k of keywords) {
    if (testEntry(k, text)) {
      topicId = k.topic_id;
      console.log(`message ${post.message_id} matched ${k.source} -> topic ${topicId}`);
      break;
    }
  }

  // 3. 转发
  const params = {
    chat_id: Number(env.FORUM_CHAT_ID),
    from_chat_id: post.chat.id,
    message_id: post.message_id,
  };
  if (topicId !== null) params.message_thread_id = topicId;
  const res = await tg(env, "forwardMessage", params);
  return !!res.ok;
}

/* ---------------- 入口 ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("tg-keyword-forward ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token") || "";
      if (secret !== env.WEBHOOK_SECRET_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const update = await request.json();
        if (update.message && update.message.entities?.some((e) => e.type === "bot_command")) {
          // 命令:始终 200,避免重试导致重复执行(如重复建 topic)
          await handleCommand(env, update.message);
        } else if (update.channel_post) {
          // channel 转发:失败回 500,让 Telegram 退避重试;成功/排除/重复回 200
          const ok = await handleChannelPost(env, update.channel_post);
          if (!ok) return new Response("forward failed", { status: 500 });
        }
      } catch (e) {
        console.error("webhook error:", e?.message || e);
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};
