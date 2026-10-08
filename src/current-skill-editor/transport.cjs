const crypto = require("node:crypto");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");
const w = require("../backend/windows.cjs");
const TOKEN = /^[a-f0-9]{64}$/;
const ABILITY = /^[a-z][a-z0-9_]{0,127}$/;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,48}$/;
const LIMIT = 64 * 1024;
const BOOTSTRAP = "script_reload_code current_skill_editor_v1.lua";
const REQUEST_TIMEOUT = "CURRENT_SKILL_REQUEST_TIMEOUT";
const CATEGORIES = new Set([
  "default",
  "all",
  "hidden",
  "talent",
  "item",
  "generic",
  "complex",
  "innate",
]);
async function seal(secret) {
  if (typeof secret !== "string" || !TOKEN.test(secret))
    throw Error("控制凭据格式无效");
  return w.ps(
    "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes(" +
      w.literal(secret) +
      "),[Text.Encoding]::UTF8.GetBytes('CurrentSkillEditor-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  );
}
async function unseal(cipher) {
  if (
    typeof cipher !== "string" ||
    cipher.length > 8192 ||
    !/^[A-Za-z0-9+/=]+$/.test(cipher)
  )
    throw Error("控制凭据无效");
  const value = await w.ps(
    "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String(" +
      w.literal(cipher) +
      "),[Text.Encoding]::UTF8.GetBytes('CurrentSkillEditor-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser))",
  );
  if (typeof value !== "string" || !TOKEN.test(value))
    throw Error("控制凭据读回无效");
  return value;
}
async function freePort() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = crypto.randomInt(28000, 58000);
    try {
      await w.portFree(port);
      return port;
    } catch {}
  }
  throw Error("未找到可用的本机控制端口");
}
async function identity(game) {
  if (
    !game ||
    !Number.isInteger(game.pid) ||
    game.pid <= 0 ||
    !Number.isInteger(game.port) ||
    game.port < 1024 ||
    game.port > 65534 ||
    typeof game.exe !== "string" ||
    !Number.isFinite(Date.parse(game.createdUtc))
  )
    throw Error("工具启动的游戏进程身份无效");
  const row = await w.identity(game.pid);
  if (
    !w.sameProcess(row, game) ||
    Date.parse(row.CreatedUtc) !== Date.parse(game.createdUtc)
  )
    throw Error("工具启动的游戏进程已结束或身份改变");
  const owners = (
    await w.ps(
      `Get-NetTCPConnection -State Listen -LocalPort ${game.port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
      5000,
    )
  )
    .split(/\s+/)
    .filter(Boolean);
  if (!owners.length || owners.some((pid) => pid !== String(game.pid)))
    throw Error("本机控制通道尚未就绪或不属于当前游戏");
}
async function consoleRequest(game, password, command, rid = null) {
  if (typeof password !== "string" || !TOKEN.test(password))
    throw Error("控制凭据格式无效");
  const action = validateCommand(command, rid);
  await identity(game);
  const result = await new Promise((resolve, reject) => {
    let output = Buffer.alloc(0),
      partial = "",
      done = false,
      authenticated = false,
      checking = false,
      pendingSeen = false,
      staleSeen = false;
    const decoder = new StringDecoder("utf8");
    const socket = net.connect(game.port, "127.0.0.1");
    const finish = (error, answer = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(guard);
      socket.destroy();
      if (error) reject(error);
      else resolve({ output: output.toString("utf8"), answer });
    };
    const timer = setTimeout(
      () => {
        const incompleteReply =
          /^(?:\[VScript\]\s*)?CURRENT_SKILL_BRIDGE_REPLY\b/.test(partial);
        const mutation = !["snapshot", "catalog", "bootstrap"].includes(action);
        const error = Error(
          staleSeen
            ? "未收到当前请求的回应（仅收到过期回应）。"
            : incompleteReply
              ? "本机技能回应未形成完整协议行。"
              : pendingSeen
                ? "资源预载尚未返回最终结果，结果未知；请读取状态，不重复操作。"
                : mutation
                  ? "本机技能修改请求超时，结果未知；请读取状态，不重复操作。"
                  : "本机控制请求超时。",
        );
        // Only a genuine silent-request timeout is eligible for read-only VM
        // recovery. Stale/incomplete protocol frames are not recovery signals.
        error.code =
          staleSeen || incompleteReply
            ? "CURRENT_SKILL_PROTOCOL_ERROR"
            : REQUEST_TIMEOUT;
        error.action = action;
        error.outcomeUnknown = mutation;
        finish(error);
      },
      action === "add" ? 25000 : 5000,
    );
    const guard = setInterval(async () => {
      if (done || checking) return;
      checking = true;
      try {
        await identity(game);
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
      }
    }, 1500);
    socket.once("connect", async () => {
      try {
        await identity(game);
        if (done) return;
        authenticated = true;
        socket.write("PASS " + password + "\n" + command + "\n", "utf8");
      } catch (error) {
        finish(error);
      }
    });
    function lineReceived(raw) {
      const line = raw.replace(/\r$/, "").replace(/^\[VScript\]\s*/, "");
      if (
        /^(?:Bad|Invalid|Wrong) password\b|^Authentication (?:failed|failure)\b|^Password incorrect\b|^Not authenticated\b/i.test(
          line,
        )
      )
        return finish(Error("本机控制通道认证失败。"));
      if (/^Unknown command[^\r\n]*current_skill_bridge\b/i.test(line))
        return finish(null);
      if (
        /^Unknown command\b|^(?:SCRIPT ERROR|Script Runtime Error|Lua (?:error|runtime error)|CURRENT_SKILL_ERROR)\b|^.*current_skill_editor_v1\.lua:\d+:\s/i.test(
          line,
        )
      )
        return finish(Error("本机技能模块未能执行固定命令。"));
      if (action === "bootstrap" && /^CURRENT_SKILL_EDITOR_LOADED\b/.test(line))
        return finish(null);
      if (
        action === "bootstrap" &&
        /^CURRENT_SKILL_(?:REFUSED|ERROR)\b/.test(line)
      )
        return finish(Error("本机技能模块拒绝加载。"));
      if (!rid) return;
      const match = line.match(
        /^CURRENT_SKILL_BRIDGE_REPLY ([a-zA-Z0-9_-]{1,48}) (.*)$/,
      );
      if (!match) return;
      if (match[1] !== rid) {
        staleSeen = true;
        return;
      }
      let answer;
      try {
        answer = JSON.parse(match[2]);
      } catch {
        return finish(Error("本机技能回应格式无效。"));
      }
      if (
        !answer ||
        typeof answer !== "object" ||
        Array.isArray(answer) ||
        answer.requestId !== rid ||
        typeof answer.ok !== "boolean"
      )
        return finish(Error("本机技能回应编号或状态无效。"));
      if (answer.pending !== undefined && answer.pending !== false) {
        if (
          answer.pending === null ||
          typeof answer.pending !== "object" ||
          Array.isArray(answer.pending)
        )
          return finish(Error("本机技能预载状态无效。"));
        // State snapshots expose global precache information, not a promise
        // that this read-only request will receive another frame. Only an
        // accepted add owns an asynchronous final reply for its request ID.
        if (action === "add" && answer.ok === true) {
          pendingSeen = true;
          return;
        }
      }
      finish(null, answer);
    }
    socket.on("data", (buffer) => {
      if (done) return;
      if (!authenticated)
        return finish(Error("本机控制通道在认证前返回数据。"));
      // Bound retained output separately from the complete-line stream parser.
      output =
        buffer.length >= LIMIT
          ? buffer.subarray(buffer.length - LIMIT)
          : Buffer.concat([output, buffer]).subarray(-LIMIT);
      partial += decoder.write(buffer);
      let newline;
      while (!done && (newline = partial.indexOf("\n")) !== -1) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (Buffer.byteLength(line, "utf8") > LIMIT)
          return finish(Error("本机控制回应超过单行容量。"));
        lineReceived(line);
      }
      if (!done && Buffer.byteLength(partial, "utf8") > LIMIT)
        finish(Error("本机控制回应超过单行容量。"));
    });
    socket.once("error", () => finish(Error("本机控制通道连接失败。")));
    socket.once("close", () =>
      finish(
        Error(
          pendingSeen
            ? "本机控制通道在预载完成前关闭。"
            : "本机控制通道在完整回应前关闭。",
        ),
      ),
    );
  });
  await identity(game);
  return result;
}
function argumentsFor(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Error("技能操作参数无效");
  const fields = {
    snapshot: ["action"],
    close: ["action"],
    panel: ["action", "mode"],
    catalog: ["action", "query", "category", "page", "pageSize"],
    add: ["action", "ability", "level", "allowRisk"],
    level: ["action", "ability", "level"],
    remove: ["action", "ability"],
  };
  const allowed = fields[payload.action];
  if (!allowed || Object.keys(payload).some((key) => !allowed.includes(key)))
    throw Error("技能操作或参数字段无效");
  const action = payload.action;
  if (action === "snapshot" || action === "close") return action;
  if (action === "panel") {
    if (!["open", "close"].includes(payload.mode)) throw Error("面板模式无效");
    return `panel ${payload.mode}`;
  }
  if (action === "catalog") {
    const query = payload.query === undefined ? "" : payload.query;
    if (
      typeof query !== "string" ||
      Buffer.byteLength(query, "utf8") > 160 ||
      /[\x00-\x1f\x7f]/.test(query)
    )
      throw Error("搜索内容过长或无效");
    const category =
        payload.category === undefined ? "default" : payload.category,
      page = payload.page ?? 1,
      size = payload.pageSize ?? 5;
    if (
      !CATEGORIES.has(category) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10000 ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > 18
    )
      throw Error("目录页码或分类无效");
    return `catalog ${category} ${page} ${size} ${query ? Buffer.from(query, "utf8").toString("hex") : "-"}`;
  }
  if (typeof payload.ability !== "string" || !ABILITY.test(payload.ability))
    throw Error("技能内部名称无效");
  if (action === "remove") return "remove " + payload.ability;
  const level =
    payload.level === undefined && action === "add" ? 1 : payload.level;
  if (!Number.isInteger(level) || level < 0 || level > 100)
    throw Error("技能等级无效");
  if (action === "level") return `level ${payload.ability} ${level}`;
  if (payload.allowRisk !== undefined && typeof payload.allowRisk !== "boolean")
    throw Error("高级确认无效");
  return `add ${payload.ability} ${level} ${payload.allowRisk === true ? "1" : "0"}`;
}
// Commands are reconstructed from the same fixed payload grammar, never evaluated.
function validateCommand(command, rid) {
  if (rid === null && command === BOOTSTRAP) return "bootstrap";
  if (
    typeof command !== "string" ||
    command.length > 1200 ||
    typeof rid !== "string" ||
    !REQUEST_ID.test(rid)
  )
    throw Error("控制消息无效");
  const parts = command.split(" ");
  if (
    parts[0] !== "current_skill_bridge" ||
    !TOKEN.test(parts[1] || "") ||
    parts[2] !== rid
  )
    throw Error("控制消息无效");
  const action = parts[3],
    payload = { action };
  if (action === "catalog" && parts.length === 8) {
    const hex = parts[7];
    if (hex !== "-" && !/^(?:[a-f0-9]{2}){1,160}$/.test(hex))
      throw Error("控制搜索编码无效");
    const query = hex === "-" ? "" : Buffer.from(hex, "hex").toString("utf8");
    if (hex !== "-" && Buffer.from(query, "utf8").toString("hex") !== hex)
      throw Error("控制搜索编码无效");
    Object.assign(payload, {
      category: parts[4],
      page: Number(parts[5]),
      pageSize: Number(parts[6]),
      query,
    });
  } else if (action === "add" && parts.length === 7 && /^[01]$/.test(parts[6]))
    Object.assign(payload, {
      ability: parts[4],
      level: Number(parts[5]),
      allowRisk: parts[6] === "1",
    });
  else if (action === "level" && parts.length === 6)
    Object.assign(payload, { ability: parts[4], level: Number(parts[5]) });
  else if (action === "remove" && parts.length === 5)
    payload.ability = parts[4];
  else if (action === "panel" && parts.length === 5)
    payload.mode = parts[4];
  else if (!["snapshot", "close"].includes(action) || parts.length !== 4)
    throw Error("控制消息无效");
  if (
    command !==
    `current_skill_bridge ${parts[1]} ${rid} ${argumentsFor(payload)}`
  )
    throw Error("控制消息无效");
  return action;
}
function createTransport() {
  let tail = Promise.resolve(),
    cache = null;
  async function edit(game, capability, payload) {
    const args = argumentsFor(payload);
    const readOnly = args === "snapshot" || args.startsWith("catalog ");
    if (typeof capability !== "string" || !TOKEN.test(capability))
      throw Error("技能会话权限无效");
    const run = async () => {
      if (!game) throw Error("技能游戏会话无效");
      if (
        !cache ||
        cache.pid !== game.pid ||
        cache.createdUtc !== game.createdUtc ||
        cache.exe !== game.exe ||
        cache.port !== game.port ||
        cache.sealedPassword !== game.sealedPassword
      )
        cache = {
          pid: game.pid,
          createdUtc: game.createdUtc,
          exe: game.exe,
          port: game.port,
          sealedPassword: game.sealedPassword,
          password: await unseal(game.sealedPassword),
        };
      const rid = "r" + crypto.randomBytes(12).toString("hex");
      const command = `current_skill_bridge ${capability} ${rid} ${args}`;
      let reply,
        recover = false;
      try {
        reply = await consoleRequest(game, cache.password, command, rid);
      } catch (error) {
        if (!readOnly || error.code !== REQUEST_TIMEOUT) throw error;
        // Native console registrations can outlive their Lua VM. Read-only
        // recovery is safe, but a timed-out mutation must never be replayed.
        recover = true;
      }
      if (
        recover ||
        (!reply.answer &&
          /Unknown command[^\r\n]*current_skill_bridge/i.test(reply.output))
      ) {
        await consoleRequest(game, cache.password, BOOTSTRAP);
        // One recovery only, same request ID. A second timeout propagates.
        reply = await consoleRequest(game, cache.password, command, rid);
      }
      if (!reply.answer)
        throw Error(
          "尚未读到本地英雄状态。请进入本地地图、选定英雄并开启作弊后重试。",
        );
      return reply.answer;
    };
    const current = tail.then(run, run);
    tail = current.catch(() => {});
    return current;
  }
  return { edit };
}
module.exports = {
  seal,
  unseal,
  freePort,
  identity,
  consoleRequest,
  argumentsFor,
  createTransport,
};
