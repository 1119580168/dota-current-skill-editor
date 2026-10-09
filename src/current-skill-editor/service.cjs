const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const f = require("../backend/files.cjs");
const w = require("../backend/windows.cjs");
const localization = require("./localization.cjs");
const transportModule = require("./transport.cjs");
const BUILD = 6944;
const REFERENCE = Object.freeze({
  patch: "7.41f",
  build: BUILD,
  sourceRevision: 11085649,
});
const TARGETS = Object.freeze([
  "game/dota/scripts/vscripts/current_skill_editor_v1.lua",
  "game/dota/panorama/layout/custom_game/current_ability_editor.vxml_c",
  "game/dota/panorama/scripts/custom_game/current_ability_editor.vjs_c",
  "game/dota/panorama/styles/custom_game/current_ability_editor.vcss_c",
]);
const COMMAND = "sv_cheats 1; script_reload_code current_skill_editor_v1.lua";
const SESSION_TARGET = "game/dota/scripts/npc/current_skill_session_v1.txt";
const LEASE_TARGETS = Object.freeze([
  ...TARGETS,
  localization.TARGET,
  SESSION_TARGET,
]);
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const SHA = /^[a-f0-9]{64}$/;
const DEFAULT_ROOT = path.join(
  process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
  "Steam/steamapps/common/dota 2 beta",
);
function createService({
  data,
  payload,
  notify = () => {},
  notifyEditor = () => {},
}) {
  if (!path.isAbsolute(data || "") || !path.isAbsolute(payload || ""))
    throw Error("工具数据与资源需要实际绝对路径");
  const stateFile = path.join(data, "current-editor.json");
  let record,
    lock = false;
  const transport = transportModule.createTransport();
  let editor = null,
    editorConnected = false,
    editable = false;
  async function read() {
    if (!record) {
      await f.noLinks(data);
      await f.noLinks(stateFile);
      try {
        record = await f.readJson(stateFile);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        record = { schema: 1, root: DEFAULT_ROOT, lease: null, game: null };
      }
      if (
        !record ||
        typeof record !== "object" ||
        record.schema !== 1 ||
        typeof record.root !== "string" ||
        !path.isAbsolute(record.root)
      )
        throw Error("工具状态文件无效");
    }
    return record;
  }
  async function save() {
    await f.noLinks(data);
    await f.noLinks(stateFile);
    await f.writeJson(stateFile, record);
  }
  async function client() {
    await read();
    await f.noLinks(record.root);
    const infFile = f.inside(record.root, "game/dota/steam.inf");
    await f.noLinks(infFile);
    const infStat = await fs.stat(infFile);
    if (!infStat.isFile() || infStat.size > 64 * 1024)
      throw Error("客户端版本文件无效");
    const bytes = await fs.readFile(infFile),
      text = bytes.toString("utf8");
    const value = (name) => {
      const all = [
        ...text.matchAll(
          new RegExp("^\\s*" + name + "\\s*=\\s*(\\d+)\\s*$", "gim"),
        ),
      ];
      const parsed = all.length === 1 ? Number(all[0][1]) : null;
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    };
    const field = (name) => {
      const all = [
        ...text.matchAll(
          new RegExp(
            "^\\s*" + name + "[ \\t]*=[ \\t]*([^\\r\\n]*)\\r?$",
            "gim",
          ),
        ),
      ];
      const parsed = all.length === 1 ? all[0][1].trim() : "";
      return parsed && parsed.length <= 128 && !/[\x00-\x1f\x7f]/.test(parsed)
        ? parsed
        : null;
    };
    if (value("appID") !== 570)
      throw Error("请选择 AppID 570 的 DOTA2 客户端安装目录");
    const build = value("ClientVersion"),
      serverBuild = value("ServerVersion"),
      sourceRevision = value("SourceRevision");
    const exe = f.inside(record.root, "game/bin/win64/dota2.exe");
    await f.noLinks(exe);
    if (!(await fs.stat(exe)).isFile())
      throw Error("客户端启动文件必须是普通文件");
    return {
      build,
      serverBuild,
      sourceRevision,
      versionDate: field("VersionDate"),
      versionTime: field("VersionTime"),
      sha: digest(bytes),
      exe,
    };
  }
  async function games() {
    await read();
    const raw = await w.ps(
      'Get-CimInstance Win32_Process -Filter "Name=\'dota2.exe\' OR Name=\'dota.exe\'" | Select-Object Name,ProcessId,ExecutablePath,@{Name="CreatedUtc";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress',
    );
    const rows = raw ? [].concat(JSON.parse(raw)) : [],
      selectedExe = path.resolve(record.root, "game/bin/win64/dota2.exe"),
      result = [];
    for (const row of rows) {
      const exe =
          typeof row?.ExecutablePath === "string" ? row.ExecutablePath : "",
        name = String(row?.Name || path.basename(exe)).toLowerCase();
      // hl2.exe is shared by unrelated Source games and is never a current
      // editor candidate. Keep this check even if discovery returns extra rows.
      if (!["dota2.exe", "dota.exe"].includes(name)) continue;
      const uncertain = () =>
        result.push({
          ...row,
          processIssue:
            "无法核实已有 Dota 进程的路径或 AppID；请退出该进程后重试。工具不会关闭外部游戏。",
        });
      if (!path.isAbsolute(exe) || path.basename(exe).toLowerCase() !== name) {
        uncertain();
        continue;
      }
      const resolvedExe = path.resolve(exe);
      // The selected executable may still be using our files even if Steam
      // has replaced its metadata. It must never depend on a fresh AppID read.
      if (resolvedExe.toLowerCase() === selectedExe.toLowerCase()) {
        result.push(row);
        continue;
      }
      const dir = path.dirname(resolvedExe),
        source2 =
          name === "dota2.exe" &&
          ["win64", "win32"].includes(path.basename(dir).toLowerCase()) &&
          path.basename(path.dirname(dir)).toLowerCase() === "bin" &&
          path.basename(path.dirname(path.dirname(dir))).toLowerCase() ===
            "game",
        infFile = source2
          ? path.join(dir, "../../dota/steam.inf")
          : path.join(dir, "dota/steam.inf");
      try {
        await f.noLinks(infFile);
        const stat = await fs.stat(infFile);
        if (!stat.isFile() || stat.size > 64 * 1024) {
          uncertain();
          continue;
        }
        const text = (await fs.readFile(infFile)).toString("utf8"),
          fields = [
            ...text.matchAll(/^\s*appID[ \t]*=[ \t]*([^\r\n]*)\r?$/gim),
          ],
          appId =
            fields.length === 1 && /^\d+$/.test(fields[0][1].trim())
              ? Number(fields[0][1].trim())
              : null;
        if (!Number.isSafeInteger(appId) || appId <= 0) uncertain();
        else if (appId === 570) result.push(row);
        // A valid different AppID proves this is another game. A missing,
        // unreadable or ambiguous marker cannot safely exempt a Dota-named
        // process. No Steam routes, mounts or external files are modified.
      } catch {
        uncertain();
      }
    }
    return result;
  }
  async function requireGameIdle(message) {
    const list = await games();
    if (list.length)
      throw Error(
        message +
          (list.some((row) => row.processIssue)
            ? "；" + list.find((row) => row.processIssue).processIssue
            : ""),
      );
  }
  function validateLease() {
    const lease = record.lease;
    if (!lease) return null;
    if (
      lease.schema !== 1 ||
      lease.root !== record.root ||
      lease.build !== BUILD ||
      !SHA.test(lease.infSha || "") ||
      typeof lease.restored !== "boolean" ||
      !Array.isArray(lease.files) ||
      lease.files.length > LEASE_TARGETS.length
    )
      throw Error("安装清单无效，拒绝恢复");
    const seen = new Set();
    for (const row of lease.files) {
      if (
        !LEASE_TARGETS.includes(row.target) ||
        seen.has(row.target) ||
        !SHA.test(row.sha || "") ||
        typeof row.owned !== "boolean" ||
        typeof row.restored !== "boolean"
      )
        throw Error("安装清单含非工具文件");
      seen.add(row.target);
    }
    return lease;
  }
  async function payloadFiles() {
    await f.noLinks(payload);
    const manifestFile = f.inside(payload, "manifest.json");
    await f.noLinks(manifestFile);
    const manifestStat = await fs.stat(manifestFile);
    if (!manifestStat.isFile() || manifestStat.size > 64 * 1024)
      throw Error("现代工具资源清单必须是有效普通文件");
    const manifest = await f.readJson(manifestFile);
    if (
      manifest.schema !== 1 ||
      manifest.clientBuild !== BUILD ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== 4
    )
      throw Error("现代工具资源清单无效");
    const rows = [],
      seen = new Set();
    for (const row of manifest.files) {
      if (
        !TARGETS.includes(row.target) ||
        seen.has(row.target) ||
        !SHA.test(row.sha256 || "") ||
        typeof row.source !== "string" ||
        row.source.includes("\\") ||
        row.source.split("/").some((p) => !p || p === "." || p === "..") ||
        path.posix.basename(row.source) !== path.posix.basename(row.target)
      )
        throw Error("现代工具资源路径无效");
      seen.add(row.target);
      const source = f.inside(payload, row.source);
      await f.noLinks(source);
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > 2 * 1024 ** 2)
        throw Error("工具资源大小无效");
      const bytes = await fs.readFile(source);
      if (digest(bytes) !== row.sha256) throw Error("工具资源损坏");
      rows.push({ target: row.target, sha: row.sha256, bytes });
    }
    return rows;
  }
  async function inspect() {
    await read();
    let build = null,
      serverBuild = null,
      sourceRevision = null,
      versionDate = null,
      versionTime = null,
      baselineMatched = false,
      compatible = false,
      issue = null,
      installed = false;
    try {
      const c = await client();
      build = c.build;
      serverBuild = c.serverBuild;
      sourceRevision = c.sourceRevision;
      versionDate = c.versionDate;
      versionTime = c.versionTime;
      baselineMatched =
        build === REFERENCE.build &&
        serverBuild === REFERENCE.build &&
        sourceRevision === REFERENCE.sourceRevision;
      compatible = true;
      const lease = validateLease();
      installed = !!lease && lease.files.length === 6 && !lease.restored;
      for (const row of lease?.files || []) {
        const file = f.inside(record.root, row.target);
        await f.noLinks(file);
        if (
          row.restored ||
          !(await f.exists(file)) ||
          (await f.hash(file)) !== row.sha
        )
          installed = false;
      }
    } catch (e) {
      issue = e.message;
    }
    const list = await games();
    issue ||= list.find((row) => row.processIssue)?.processIssue || null;
    const ownedRunning =
      !!record.game && list.some((p) => w.sameProcess(p, record.game));
    if (!ownedRunning) {
      editorConnected = false;
      editable = false;
      editor = null;
    }
    return {
      root: record.root,
      build,
      serverBuild,
      sourceRevision,
      versionDate,
      versionTime,
      reference: { ...REFERENCE },
      baselineMatched,
      // `compatible` is retained for existing IPC consumers and now means
      // installation eligibility, never a guarantee for an updated engine.
      launchEligible: compatible,
      compatibilityNotice: !compatible
        ? "工具基于 7.41f / build 6944 制作；请先检查客户端安装目录。"
        : baselineMatched
          ? "工具基于 7.41f / build 6944 制作。检测版本与制作基线相同，运行时仍会检查本机房主与作弊环境。"
          : "工具基于 7.41f / build 6944 制作。当前客户端与制作基线不同，允许尝试；新版本兼容性尚未验证。",
      compatible,
      installed,
      ownedRunning,
      editorConnected: ownedRunning && editorConnected,
      editorReady: ownedRunning && editorConnected && !!editor?.hero?.unitName,
      editable: ownedRunning && editable,
      gameRunning: list.length > 0,
      canRestore: !!record.lease && !record.lease.restored,
      phase: ownedRunning
        ? "游戏运行中"
        : installed
          ? "已准备"
          : issue
            ? "需要检查"
            : "待准备",
      command: COMMAND,
      issue,
    };
  }
  async function exclusive(fn) {
    if (lock) throw Error("上一项操作仍在进行");
    lock = true;
    try {
      return await fn();
    } finally {
      lock = false;
    }
  }
  async function prepare() {
    return exclusive(async () => {
      const c = await client();
      await requireGameIdle("请先退出 DOTA2，再准备工具文件");
      const previous = validateLease();
      if (previous && !previous.restored) {
        if ((await inspect()).installed) return;
        throw Error("已有安装记录未恢复，请先恢复工具文件");
      }
      const planned = await payloadFiles();
      const names = await localization.generate(record.root, "schinese");
      if (
        !Buffer.isBuffer(names) ||
        names.length < 1 ||
        names.length > 2 * 1024 ** 2
      )
        throw Error("本机名称索引无效");
      planned.push({
        target: localization.TARGET,
        sha: digest(names),
        bytes: names,
      });
      const sessionBytes = Buffer.from(
        '"CurrentSkillSession"\n{\n "Capability" "' +
          crypto.randomBytes(32).toString("hex") +
          '"\n}\n',
        "utf8",
      );
      planned.push({
        target: SESSION_TARGET,
        sha: digest(sessionBytes),
        bytes: sessionBytes,
      });
      // This comparison belongs only to the current preparation transaction.
      // It is never compared with the payload baseline or a prior lease.
      if ((await client()).sha !== c.sha)
        throw Error("客户端在本次准备过程中已更新，请重试准备工具");
      await requireGameIdle("DOTA2 已在准备期间启动；请退出游戏后重试");
      for (const row of planned) {
        const target = f.inside(record.root, row.target);
        await f.noLinks(target);
        row.owned = true;
        if (await f.exists(target)) {
          if (
            !(await fs.stat(target)).isFile() ||
            (await f.hash(target)) !== row.sha
          )
            throw Error(
              "目标已有不同内容，保留原文件：" + path.basename(target),
            );
          row.owned = false;
        }
      }
      record.lease = {
        schema: 1,
        root: record.root,
        // This is the tool payload provenance, not a runtime client constraint.
        build: BUILD,
        // Informational capture; Steam changes do not invalidate an intact lease.
        infSha: c.sha,
        files: [],
        restored: false,
      };
      await save();
      for (const row of planned) {
        await requireGameIdle(
          "DOTA2 已在准备期间启动；请退出游戏后恢复工具文件",
        );
        if ((await client()).sha !== c.sha)
          throw Error("客户端在本次准备过程中已更新，请恢复工具文件后重试准备");
        const item = {
          target: row.target,
          sha: row.sha,
          owned: row.owned,
          restored: false,
        };
        record.lease.files.push(item);
        await save();
        const file = f.inside(record.root, row.target);
        if (item.owned) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await f.noLinks(file);
          await requireGameIdle(
            "DOTA2 已在准备期间启动；请退出游戏后恢复工具文件",
          );
          try {
            await fs.writeFile(file, row.bytes, { flag: "wx" });
          } catch (e) {
            if (e.code !== "EEXIST") throw e;
            item.owned = false;
            await save();
          }
        }
        await f.noLinks(file);
        if ((await f.hash(file)) !== row.sha)
          throw Error("安装读回失败，已保留外部文件");
      }
    });
  }
  async function restore() {
    return exclusive(async () => {
      await read();
      await requireGameIdle(
        "请先退出全部 DOTA2 窗口再恢复；工具不会关闭外部游戏",
      );
      const lease = validateLease();
      if (!lease || lease.restored) return;
      let modified = false;
      for (const row of lease.files) {
        if (row.restored) continue;
        const file = f.inside(record.root, row.target);
        await f.noLinks(file);
        if (row.owned && (await f.exists(file))) {
          if (
            !(await fs.stat(file)).isFile() ||
            (await f.hash(file)) !== row.sha
          ) {
            modified = true;
            continue;
          }
          await requireGameIdle(
            "DOTA2 已在恢复期间启动；工具不会关闭外部游戏，请退出后继续恢复",
          );
          await fs.unlink(file);
        }
        row.restored = true;
        await save();
      }
      lease.restored = lease.files.every((r) => r.restored);
      await save();
      if (modified)
        throw Error("部分工具文件已被外部修改，已保留；未删除其他游戏文件");
    });
  }
  async function selectRoot(root) {
    return exclusive(async () => {
      await read();
      if (record.lease && !record.lease.restored)
        throw Error("请先恢复当前客户端的工具文件，再切换目录");
      if (!path.isAbsolute(root || "")) throw Error("请选择客户端实际文件夹");
      await f.noLinks(root);
      record.root = path.resolve(root);
      await save();
    });
  }
  async function launch(mode = "menu") {
    return exclusive(async () => {
      if (!["menu", "demo", "match"].includes(mode))
        throw Error("无效启动方式");
      const state = await inspect();
      if (!state.installed) throw Error("请先准备工具文件");
      if (state.gameRunning)
        throw Error(
          "DOTA2 已运行；桌面编辑面板需要由本工具启动的控制通道，请先退出外部游戏再启动",
        );
      const c = await client();
      const password = crypto.randomBytes(32).toString("hex");
      const port = await transportModule.freePort();
      const sealedPassword = await transportModule.seal(password);
      const args = [
        "-insecure",
        "-dev",
        "-console",
        "-vconsole",
        "-netconport",
        String(port),
        "-netconpassword",
        password,
        "-language",
        "schinese",
        "-windowed",
        "-w",
        "1280",
        "-h",
        "720",
        "+con_enable",
        "1",
        "+bind",
        "F8",
        "toggleconsole",
        "+sv_cheats",
        "1",
      ];
      if (mode === "match")
        args.push(
          "+dota_force_gamemode",
          "1",
          "+dota_bot_practice_difficulty",
          "1",
          "+dota_bot_practice_team",
          "0",
          "+dota_bot_practice_start",
          "1",
          "+map",
          "dota",
        );
      const child = childProcess.spawn(c.exe, args, {
        cwd: path.dirname(c.exe),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      const row = await w.identity(child.pid);
      if (
        !row ||
        String(row.ExecutablePath).toLowerCase() !== c.exe.toLowerCase()
      )
        throw Error("未能确认启动的客户端进程");
      record.game = {
        pid: child.pid,
        exe: c.exe,
        createdUtc: row.CreatedUtc,
        mode,
        port,
        sealedPassword,
      };
      await save();
      notify(await inspect());
    });
  }
  async function edit(payload) {
    const current = await inspect();
    if (!current.installed || !current.compatible || !current.ownedRunning)
      throw Error(
        "桌面编辑面板需要由本工具启动客户端。请先退出现有游戏，再从这里启动并进入本地作弊地图。",
      );
    const row = validateLease().files.find(
      (r) => r.target === SESSION_TARGET && !r.restored,
    );
    if (!row) throw Error("缺少本机编辑会话");
    const file = f.inside(record.root, SESSION_TARGET);
    await f.noLinks(file);
    if ((await f.hash(file)) !== row.sha) throw Error("本机编辑会话已改变");
    const bytes = await fs.readFile(file, "utf8");
    const match = bytes.match(/"Capability"\s+"([a-f0-9]{64})"/);
    if (!match) throw Error("本机编辑会话无效");
    try {
      const result = await transport.edit(record.game, match[1], payload);
      editorConnected = true;
      editor = result;
      if (payload.action === "snapshot")
        editable = result.ok === true && !!result.hero?.unitName;
      else if (!result.hero?.unitName) editable = false;
      notifyEditor(result);
      notify(await inspect());
      return result;
    } catch (e) {
      editorConnected = false;
      editable = false;
      notify(await inspect());
      throw e;
    }
  }
  return { inspect, prepare, restore, selectRoot, launch, edit, stateFile };
}
module.exports = {
  createService,
  BUILD,
  REFERENCE,
  TARGETS,
  LEASE_TARGETS,
  COMMAND,
  DEFAULT_ROOT,
  SESSION_TARGET,
};
