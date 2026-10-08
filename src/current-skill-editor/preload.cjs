const { contextBridge, ipcRenderer } = require("electron");

const actions = new Set([
  "inspect",
  "selectRoot",
  "prepare",
  "launch",
  "restore",
  "openFolder",
  "edit",
]);
const modes = new Set(["menu", "demo", "match"]);
const edits = new Set(["snapshot", "catalog", "add", "level", "remove", "panel"]);
const categories = new Set([
  "default",
  "all",
  "hidden",
  "talent",
  "item",
  "generic",
  "innate",
  "complex",
]);
const integer = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;

function editorInput(payload) {
  if (!edits.has(payload.action)) throw Error("未知的技能操作");
  const input = { action: payload.action };
  if (payload.action === "panel") {
    if (!["open", "close"].includes(payload.mode)) throw Error("面板模式无效");
    input.mode = payload.mode;
  }
  if (payload.action === "catalog") {
    if (payload.query !== undefined) {
      if (
        typeof payload.query !== "string" ||
        payload.query.length > 160 ||
        new TextEncoder().encode(payload.query).byteLength > 160 ||
        /[\x00-\x1f\x7f]/.test(payload.query)
      )
        throw Error("技能搜索内容无效");
      input.query = payload.query;
    }
    if (payload.category !== undefined) {
      if (!categories.has(payload.category)) throw Error("未知的技能分类");
      input.category = payload.category;
    }
    if (payload.page !== undefined) {
      if (!integer(payload.page, 1, 10000)) throw Error("技能目录页码无效");
      input.page = payload.page;
    }
    if (payload.pageSize !== undefined) {
      if (payload.pageSize !== 5) throw Error("技能目录每页固定为五项");
      input.pageSize = 5;
    }
  }
  if (["add", "level", "remove"].includes(payload.action)) {
    if (
      typeof payload.ability !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(payload.ability)
    )
      throw Error("技能名称无效");
    input.ability = payload.ability;
  }
  if (
    payload.action === "level" ||
    (payload.action === "add" && payload.level !== undefined)
  ) {
    if (!integer(payload.level, 0, 100)) throw Error("技能等级无效");
    input.level = payload.level;
  }
  if (payload.action === "add" && payload.allowRisk !== undefined) {
    if (typeof payload.allowRisk !== "boolean")
      throw Error("高级技能确认参数无效");
    input.allowRisk = payload.allowRisk;
  }
  return input;
}

contextBridge.exposeInMainWorld(
  "currentSkills",
  Object.freeze({
    invoke(action, payload = {}) {
      if (!actions.has(action)) return Promise.reject(Error("未知的工具操作"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return Promise.reject(Error("工具操作参数无效"));
      const input = {};
      if (action === "inspect" && payload.root !== undefined) {
        if (
          typeof payload.root !== "string" ||
          payload.root.length > 4096 ||
          /[\x00-\x1f]/.test(payload.root)
        )
          return Promise.reject(Error("客户端目录无效"));
        input.root = payload.root;
      }
      if (action === "launch") {
        if (!modes.has(payload.mode))
          return Promise.reject(Error("未知的游戏入口"));
        input.mode = payload.mode;
      }
      if (action === "edit") {
        try {
          Object.assign(input, editorInput(payload));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return ipcRenderer.invoke("current-skills:invoke", action, input);
    },
    onState(callback) {
      if (typeof callback !== "function") throw Error("状态回调必须是函数");
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("current-skills:state", listener);
      return () => ipcRenderer.removeListener("current-skills:state", listener);
    },
    onEditor(callback) {
      if (typeof callback !== "function") throw Error("技能状态回调必须是函数");
      const listener = (_event, editor) => callback(editor);
      ipcRenderer.on("current-skills:editor", listener);
      return () =>
        ipcRenderer.removeListener("current-skills:editor", listener);
    },
  }),
);
