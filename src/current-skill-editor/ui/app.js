const bridge =
  typeof window.currentSkills?.invoke === "function" &&
  typeof window.currentSkills?.onState === "function"
    ? window.currentSkills
    : null;
const $ = (id) => document.getElementById(id);
const reference = { patch: "7.41f", build: "6944", sourceRevision: "11085649" };
const model = {
  root: "",
  build: "",
  installed: false,
  ownedRunning: false,
  phase: "idle",
  command: "",
  issue: "",
  compatible: false,
  serverBuild: "",
  sourceRevision: "",
  compatibilityNotice: "",
  reference: { ...reference },
};
const phases = {
  idle: "等待检测客户端",
  inspected: "客户端检测完成",
  detected: "客户端检测完成",
  preparing: "正在准备工具文件…",
  prepared: "工具已准备，可进入本机游戏",
  installed: "工具已准备，可进入本机游戏",
  launching: "正在启动客户端…",
  waiting: "等待本机游戏就绪",
  "waiting-host": "等待本机房主与英雄就绪",
  "waiting-demo": "等待进入本机试玩",
  "waiting-game": "等待本机游戏就绪",
  loading: "正在载入技能面板…",
  ready: "技能面板已就绪",
  running: "客户端正在运行",
  restoring: "正在恢复工具文件…",
  restored: "工具文件已恢复",
  stopped: "游戏已结束",
  error: "需要处理本地环境问题",
  unsupported: "客户端检测未通过",
  "manual-ready": "工具已准备，可手动载入",
  游戏运行中: "客户端正在运行",
  已准备: "工具已准备，启动后连接桌面编辑区",
  需要检查: "需要处理本地环境问题",
  待准备: "等待准备技能工具",
};
const operationLabels = {
  inspect: "正在检测客户端…",
  selectRoot: "正在选择客户端目录…",
  prepare: "正在准备工具…",
  launch: "正在启动客户端…",
  restore: "正在恢复工具文件…",
  openFolder: "正在打开客户端目录…",
};
let busy = "";
let dirtyRoot = false;
let lastPhaseKey = "";
let unsubscribe;
let toastTimer;
const logs = [];

function short(value, maximum = 280) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}
function addLog(message, error = false) {
  const text = short(message);
  if (!text || logs[0]?.message === text) return;
  logs.unshift({ message: text, error, time: new Date() });
  logs.splice(12);
  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = entry.time.toISOString();
    time.textContent = entry.time.toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    const textNode = document.createElement("span");
    textNode.textContent = entry.message;
    if (entry.error) textNode.className = "error";
    row.append(time, textNode);
    fragment.append(row);
  }
  $("activity-log").replaceChildren(fragment);
  $("log-count").textContent = String(logs.length);
}
function notice(message, error = false) {
  $("notice-text").textContent = short(message, 600);
  $("notice").classList.toggle("success", !error);
  $("notice").hidden = !message;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 2800);
}
function badge(element, text, tone = "neutral") {
  element.textContent = text;
  element.className = `badge ${tone}`;
}
function applyState(value) {
  const next = value?.state || value;
  if (!next || typeof next !== "object" || Array.isArray(next)) return;
  if (typeof next.root === "string" && next.root !== model.root) {
    model.running = false;
    model.gameRunning = false;
    model.supported = undefined;
    model.compatible = false;
    model.launchEligible = undefined;
    model.baselineMatched = undefined;
    model.serverBuild = "";
    model.sourceRevision = "";
    model.compatibilityNotice = "";
    model.canRestore = false;
  }
  for (const key of [
    "root",
    "build",
    "serverBuild",
    "sourceRevision",
    "phase",
    "command",
    "issue",
    "compatibilityNotice",
  ])
    if (
      typeof next[key] === "string" ||
      (["build", "serverBuild", "sourceRevision"].includes(key) &&
        typeof next[key] === "number")
    )
      model[key] = String(next[key]).slice(0, key === "command" ? 16000 : 4096);
  for (const key of [
    "build",
    "serverBuild",
    "sourceRevision",
    "compatibilityNotice",
  ])
    if (next[key] === null) model[key] = "";
  if (
    next.reference &&
    typeof next.reference === "object" &&
    !Array.isArray(next.reference)
  ) {
    for (const key of ["patch", "build", "sourceRevision"])
      if (["string", "number"].includes(typeof next.reference[key]))
        model.reference[key] = String(next.reference[key]).slice(0, 40);
  }
  if (next.issue === null) model.issue = "";
  for (const key of [
    "installed",
    "ownedRunning",
    "running",
    "gameRunning",
    "supported",
    "compatible",
    "launchEligible",
    "baselineMatched",
    "canRestore",
  ])
    if (typeof next[key] === "boolean") model[key] = next[key];
  if (!dirtyRoot) $("client-root").value = model.root;
  const phaseKey = `${model.phase}|${model.build}|${model.installed}|${model.ownedRunning}`;
  if (phaseKey !== lastPhaseKey) {
    lastPhaseKey = phaseKey;
    addLog(
      phases[model.phase] || "本地状态已更新",
      model.phase === "error" || Boolean(model.issue),
    );
  }
  render();
}
function render() {
  const eligible =
    model.launchEligible !== false &&
    model.compatible !== false &&
    (model.launchEligible === true || model.compatible === true);
  const detected = Boolean(model.root && (model.build || eligible));
  const accepted = Boolean(model.root && eligible && !model.issue);
  const baselineMatched =
    typeof model.baselineMatched === "boolean"
      ? model.baselineMatched
      : model.build === model.reference.build &&
        model.serverBuild === model.reference.build &&
        model.sourceRevision === model.reference.sourceRevision;
  const installed = model.installed === true;
  const running =
    model.ownedRunning === true ||
    model.running === true ||
    model.gameRunning === true;
  const changed = dirtyRoot && $("client-root").value.trim() !== model.root;
  const canUse = accepted && !changed && Boolean(bridge);
  const pending = Boolean(busy);
  $("build-value").textContent = model.build
    ? `Build ${model.build}`
    : accepted
      ? "未知"
      : "—";
  $("build-value").classList.toggle("ready", accepted);
  $("reference-patch").textContent = model.reference.patch;
  $("reference-build").textContent = `BUILD ${model.reference.build}`;
  const versionDetails = [
    model.serverBuild && `服务器 Build ${model.serverBuild}`,
    model.sourceRevision && `源码修订 ${model.sourceRevision}`,
  ].filter(Boolean);
  $("version-detail").textContent = versionDetails.join(" · ");
  $("version-detail").hidden = !versionDetails.length;
  $("compatibility-note").textContent =
    short(model.compatibilityNotice, 600) ||
    `制作基线为 ${model.reference.patch} / Build ${model.reference.build}。可尝试运行，兼容性未验证。`;
  $("compatibility-note").hidden = !accepted || baselineMatched;
  $("install-value").textContent = installed ? "已准备" : "尚未准备";
  $("install-value").classList.toggle("ready", installed);
  $("process-value").textContent = model.ownedRunning
    ? "本工具启动 · 运行中"
    : running
      ? "检测到已有游戏"
      : "未启动";
  badge(
    $("client-status"),
    model.issue
      ? "需要检查"
      : !detected
        ? "等待检测"
        : accepted
          ? "客户端已识别"
          : "客户端待检查",
    model.issue
      ? "warn"
      : !detected
        ? "neutral"
        : accepted
          ? "success"
          : "warn",
  );
  badge(
    $("launch-state"),
    changed
      ? "目录待检测"
      : !accepted
        ? "先检测客户端"
        : running
          ? "游戏正在运行"
          : installed
            ? "可以启动"
            : "先准备工具",
    accepted && installed && !changed ? "success" : "neutral",
  );
  $("client-root").disabled = pending;
  for (const id of ["refresh", "select-root", "inspect"])
    $(id).disabled = pending || !bridge;
  $("prepare").disabled = pending || !canUse || running;
  $("prepare").querySelector("span").textContent = installed
    ? "重新检查准备"
    : "一键准备";
  for (const button of document.querySelectorAll("[data-launch]"))
    button.disabled = pending || !canUse || !installed || running;
  $("open-folder").disabled = pending || !model.root || changed || !bridge;
  $("restore").disabled =
    pending || !(model.canRestore === true || installed) || running || !bridge;
  $("copy-command").disabled = !installed || !model.command || changed;
  $("load-command").textContent =
    installed && model.command ? model.command : "检测并准备工具后显示";
  $("root-help").textContent = changed
    ? "目录已修改，请先检测再继续。"
    : model.issue
      ? short(model.issue, 600)
      : "检测当前客户端目录与工具文件状态。Steam 更新后，请重新检测。";
  const phaseText = busy
    ? operationLabels[busy]
    : phases[model.phase] || "等待本机环境就绪";
  $("phase-text").textContent = phaseText;
  $("phase-dot").className =
    `phase-dot ${pending || ["preparing", "loading", "launching", "restoring"].includes(model.phase) ? "busy" : model.phase === "error" || model.phase === "unsupported" || model.issue ? "error" : installed ? "success" : ""}`;
  $("phase-detail").textContent = running
    ? "退出游戏后可恢复工具文件"
    : installed
      ? "文件已准备；启动后在桌面编辑区操作"
      : "文件准备与面板加载分别检查";
  const step = !accepted || changed ? 1 : !installed ? 2 : 3;
  ["step-client", "step-prepare", "step-launch"].forEach((id, index) => {
    const node = $(id);
    node.classList.toggle("complete", index + 1 < step);
    if (index + 1 === step) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  });
  $("prepare").setAttribute("aria-busy", String(busy === "prepare"));
  $("restore").setAttribute("aria-busy", String(busy === "restore"));
}
async function invoke(action, payload = {}) {
  if (!bridge || busy) return;
  busy = action;
  notice("");
  render();
  try {
    const result = await bridge.invoke(action, payload);
    if (!result || typeof result !== "object")
      throw Error("本地管理器返回了无效状态");
    if (result.state) applyState(result.state);
    if (result.ok !== true) {
      const message =
        short(result.message || result.error) || "操作未完成，请检查本地环境。";
      notice(message, true);
      addLog(message, true);
    } else {
      if (action === "selectRoot" || action === "inspect") {
        dirtyRoot = false;
        $("client-root").value = model.root;
      }
      if (result.message) {
        notice(result.message);
        addLog(result.message);
      }
    }
  } catch (error) {
    const message = short(error.message) || "本地管理器暂时不可用";
    notice(message, true);
    addLog(message, true);
  } finally {
    busy = "";
    render();
  }
}
async function copyCommand() {
  if (!model.installed || !model.command) return;
  try {
    await navigator.clipboard.writeText(model.command);
    toast("加载命令已复制");
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("load-command"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    $("load-command").focus();
    toast("请选择已高亮的命令，按 Ctrl+C 复制");
  }
}
$("client-root").addEventListener("input", () => {
  dirtyRoot = true;
  render();
});
$("inspect").addEventListener("click", () =>
  invoke("inspect", { root: $("client-root").value.trim() }),
);
$("refresh").addEventListener("click", () =>
  invoke("inspect", { root: $("client-root").value.trim() || model.root }),
);
$("select-root").addEventListener("click", () => invoke("selectRoot"));
$("prepare").addEventListener("click", () => invoke("prepare"));
$("restore").addEventListener("click", () => invoke("restore"));
$("open-folder").addEventListener("click", () => invoke("openFolder"));
$("copy-command").addEventListener("click", copyCommand);
for (const button of document.querySelectorAll("[data-launch]"))
  button.addEventListener("click", () =>
    invoke("launch", { mode: button.dataset.launch }),
  );
document.addEventListener("keydown", (event) => {
  if (event.isComposing || busy) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    $("client-root").focus();
    $("client-root").select();
  }
  if (event.key === "Enter" && event.target === $("client-root")) {
    event.preventDefault();
    invoke("inspect", { root: $("client-root").value.trim() });
  }
});
window.addEventListener("beforeunload", () => {
  unsubscribe?.();
  clearTimeout(toastTimer);
});
render();
if (bridge) {
  unsubscribe = bridge.onState(applyState);
  invoke("inspect");
} else {
  model.phase = "error";
  notice("请通过独立桌面管理器打开此界面。", true);
  addLog("未连接本地管理器", true);
  render();
}
