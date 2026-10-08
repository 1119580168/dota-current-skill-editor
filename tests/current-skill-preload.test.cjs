const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(
  path.join(__dirname, "../src/current-skill-editor/preload.cjs"),
  "utf8",
);
function fixture() {
  let api;
  const calls = [],
    listeners = new Map();
  vm.runInNewContext(source, {
    TextEncoder,
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "currentSkills");
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (...args) => {
            calls.push(JSON.parse(JSON.stringify(args)));
            return { ok: true };
          },
          on: (name, fn) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(fn);
          },
          removeListener: (name, fn) => listeners.get(name)?.delete(fn),
        },
      };
    },
  });
  return { api, calls, listeners };
}

test("current skills preload exposes fixed commands, strips arbitrary paths/commands and keeps edit capability private", async () => {
  const { api, calls } = fixture();
  assert.equal(Object.isFrozen(api), true);
  await api.invoke("launch", {
    mode: "match",
    executable: "untrusted",
    args: ["unsafe"],
    password: "private",
  });
  await api.invoke("edit", {
    action: "add",
    ability: "synthetic_skill",
    level: 2,
    allowRisk: true,
    command: "quit",
    capability: "forged",
    PlayerID: 7,
  });
  await api.invoke("edit", { action: "snapshot", command: "quit" });
  assert.deepEqual(calls, [
    ["current-skills:invoke", "launch", { mode: "match" }],
    [
      "current-skills:invoke",
      "edit",
      { action: "add", ability: "synthetic_skill", level: 2, allowRisk: true },
    ],
    ["current-skills:invoke", "edit", { action: "snapshot" }],
  ]);
});

for (const [label, payload] of [
  ["missing panel mode", { action: "panel" }],
  ["unknown panel mode", { action: "panel", mode: "toggle" }],
  ["panel mode injection", { action: "panel", mode: "open;quit" }],
  ["raw console action", { action: "execute", command: "quit" }],
  ["name injection", { action: "add", ability: "synthetic_skill;quit" }],
  ["non-string skill", { action: "remove", ability: 1 }],
  ["missing level", { action: "level", ability: "synthetic_skill" }],
  [
    "out-of-range level",
    { action: "level", ability: "synthetic_skill", level: 101 },
  ],
  [
    "fractional level",
    { action: "level", ability: "synthetic_skill", level: 1.1 },
  ],
  ["unbounded query", { action: "catalog", query: "x".repeat(193) }],
  ["UTF8 byte limit", { action: "catalog", query: "汉".repeat(54) }],
  ["query controls", { action: "catalog", query: "hello\nquit" }],
  ["unknown category", { action: "catalog", category: "execute" }],
  ["invalid page", { action: "catalog", page: 0 }],
  ["unbounded page", { action: "catalog", page: 10001 }],
  ["unbounded page size", { action: "catalog", pageSize: 18 }],
  [
    "non-boolean advanced flag",
    { action: "add", ability: "synthetic_skill", allowRisk: "true" },
  ],
])
  test("preload rejects " + label + " before IPC", async () => {
    const { api, calls } = fixture();
    await assert.rejects(api.invoke("edit", payload));
    assert.deepEqual(calls, []);
  });

test("preload accepts fixed editor actions and panel modes with a fixed five-item page", async () => {
  const { api, calls } = fixture();
  for (const payload of [
    { action: "snapshot" },
    { action: "catalog", query: "测试", category: "all", page: 2, pageSize: 5 },
    { action: "add", ability: "synthetic_skill", allowRisk: false },
    { action: "level", ability: "synthetic_skill", level: 2 },
    { action: "remove", ability: "synthetic_skill" },
    { action: "panel", mode: "open" },
    { action: "panel", mode: "close", command: "quit", capability: "forged" },
  ])
    await api.invoke("edit", payload);
  assert.equal(calls.length, 7);
  assert.equal(calls[1][2].pageSize, 5);
  assert.deepEqual(calls[6][2], { action: "panel", mode: "close" });
});

test("onEditor and onState expose only payload data and independently unsubscribe", () => {
  const { api, listeners } = fixture();
  let editor, state;
  const stopEditor = api.onEditor((value) => {
      editor = value;
    }),
    stopState = api.onState((value) => {
      state = value;
    });
  for (const callback of listeners.get("current-skills:editor"))
    callback({ sender: "private IPC identity" }, { connected: false });
  for (const callback of listeners.get("current-skills:state"))
    callback({ sender: "private IPC identity" }, { installed: true });
  assert.deepEqual(editor, { connected: false });
  assert.deepEqual(state, { installed: true });
  stopEditor();
  stopState();
  assert.equal(listeners.get("current-skills:editor").size, 0);
  assert.equal(listeners.get("current-skills:state").size, 0);
  assert.throws(() => api.onEditor(null), /回调/);
});
