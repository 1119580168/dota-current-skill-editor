// Only synthetic loopback TCP servers are used. Windows identity and DPAPI are
// mocked; these tests never discover, launch, or connect to a real DOTA process.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const net = require("node:net");
const realWindows = require("../src/backend/windows.cjs");
const source = fs.readFileSync(
  path.join(__dirname, "../src/current-skill-editor/transport.cjs"),
  "utf8",
);
const PASSWORD = "a".repeat(64),
  CAPABILITY = "b".repeat(64),
  RID = "r_fixed_1";
const CIPHER = Buffer.from("synthetic DPAPI ciphertext").toString("base64");
const command = (args = "snapshot", rid = RID) =>
  `current_skill_bridge ${CAPABILITY} ${rid} ${args}`;
const reply = (value = {}, rid = RID, prefix = "") =>
  prefix +
  "CURRENT_SKILL_BRIDGE_REPLY " +
  rid +
  " " +
  JSON.stringify({ requestId: rid, ok: true, ...value }) +
  "\n";

function harness(options = {}) {
  const calls = [],
    timerDurations = [];
  let identityCalls = 0,
    ownerCalls = 0;
  const game = {
    pid: 424242,
    exe: "C:\\synthetic\\dota2.exe",
    createdUtc: "2026-01-01T00:00:00.000Z",
    port: 35000,
    sealedPassword: CIPHER,
  };
  const windows = {
    literal: realWindows.literal,
    sameProcess: realWindows.sameProcess,
    identity: async (pid) => {
      calls.push(["identity", pid]);
      const row = {
        ProcessId: game.pid,
        ExecutablePath: game.exe,
        CreatedUtc: game.createdUtc,
      };
      return options.row
        ? options.row(++identityCalls, row)
        : (++identityCalls, row);
    },
    ps: async (script, timeout) => {
      calls.push(["ps", script, timeout]);
      if (script.startsWith("Get-NetTCPConnection"))
        return options.owners
          ? options.owners(++ownerCalls)
          : (++ownerCalls, String(game.pid));
      if (script.includes("]::Unprotect(")) return options.unsealed ?? PASSWORD;
      if (script.includes("]::Protect(")) return CIPHER;
      throw Error("Unexpected synthetic Windows call");
    },
    portFree: async (port) => {
      calls.push(["portFree", port]);
      if (options.portFailure) throw Error("synthetic busy");
    },
  };
  const sandbox = {
    module: { exports: {} },
    Buffer,
    console,
    require: (name) =>
      name === "../backend/windows.cjs" ? windows : require(name),
    setTimeout: (fn, ms) => {
      timerDurations.push(ms);
      return setTimeout(fn, ms >= 5000 ? (options.timeout ?? 250) : ms);
    },
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, options.guardInterval ?? 20),
    clearInterval,
  };
  vm.runInNewContext(source, sandbox, {
    filename: "synthetic-current-skill-transport.cjs",
  });
  return { api: sandbox.module.exports, game, calls, timerDurations };
}
async function serverFixture(t, handler, options = {}) {
  const h = harness(options),
    sockets = new Set(),
    received = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "",
      handled = false;
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      if (!handled && buffer.split("\n").length >= 3) {
        handled = true;
        received.push(buffer);
        handler(socket, buffer, received.length);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  h.game.port = server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { ...h, received };
}

test("argument whitelist isolates UTF8 queries from console syntax", () => {
  const { api } = harness();
  assert.equal(api.argumentsFor({ action: "snapshot" }), "snapshot");
  assert.equal(api.argumentsFor({ action: "close" }), "close");
  assert.equal(api.argumentsFor({ action: "panel", mode: "open" }), "panel open");
  assert.equal(api.argumentsFor({ action: "panel", mode: "close" }), "panel close");
  assert.equal(
    api.argumentsFor({ action: "catalog", query: "风暴" }),
    "catalog default 1 5 e9a38ee69ab4",
  );
  const unsafeLooking = 'storm; script dofile("untrusted.lua")';
  const args = api.argumentsFor({ action: "catalog", query: unsafeLooking });
  assert.equal(
    args,
    "catalog default 1 5 " + Buffer.from(unsafeLooking).toString("hex"),
  );
  assert.doesNotMatch(args, /[;"()]/);
  assert.doesNotThrow(() =>
    api.argumentsFor({ action: "catalog", query: "x".repeat(160) }),
  );
  assert.doesNotThrow(() =>
    api.argumentsFor({ action: "catalog", query: "中".repeat(53) }),
  );
  for (const query of [
    "x".repeat(161),
    "中".repeat(54),
    "x\n",
    "\0",
    "\x7f",
    42,
  ])
    assert.throws(() => api.argumentsFor({ action: "catalog", query }));
  for (const payload of [
    null,
    [],
    "x",
    { action: "eval", code: "print(1)" },
    { action: "snapshot", PlayerID: 0 },
    { action: "snapshot", code: "x" },
    { action: "panel" },
    { action: "panel", mode: "toggle" },
    { action: "panel", mode: "open;quit" },
    { action: "panel", mode: "open", addon: "forged" },
    { action: "catalog", category: "bad" },
    { action: "catalog", category: "" },
    { action: "catalog", page: 0 },
    { action: "catalog", page: 10001 },
    { action: "catalog", page: 1.1 },
    { action: "catalog", pageSize: 19 },
  ])
    assert.throws(() => api.argumentsFor(payload));
});
test("ability and level validation does not accept scripts or coercions", () => {
  const { api } = harness();
  assert.equal(
    api.argumentsFor({ action: "add", ability: "sven_storm_bolt" }),
    "add sven_storm_bolt 1 0",
  );
  assert.equal(
    api.argumentsFor({
      action: "add",
      ability: "sven_storm_bolt",
      level: 0,
      allowRisk: true,
    }),
    "add sven_storm_bolt 0 1",
  );
  assert.equal(
    api.argumentsFor({
      action: "level",
      ability: "sven_storm_bolt",
      level: 100,
    }),
    "level sven_storm_bolt 100",
  );
  for (const ability of [
    "x;quit",
    "../ability",
    "sven_storm_bolt\nquit",
    "UpperCase",
    "",
    12,
  ])
    assert.throws(() => api.argumentsFor({ action: "remove", ability }));
  for (const level of [undefined, null, "1", -1, 1.5, 101, NaN, Infinity])
    assert.throws(() =>
      api.argumentsFor({ action: "level", ability: "sven_storm_bolt", level }),
    );
  assert.throws(() =>
    api.argumentsFor({
      action: "add",
      ability: "sven_storm_bolt",
      allowRisk: 1,
    }),
  );
  assert.throws(() =>
    api.argumentsFor({
      action: "remove",
      ability: "sven_storm_bolt",
      level: 1,
    }),
  );
});
test("DPAPI uses CurrentUser fixed entropy and validates both sides without native calls", async () => {
  const h = harness();
  assert.equal(await h.api.seal(PASSWORD), CIPHER);
  assert.equal(await h.api.unseal(CIPHER), PASSWORD);
  for (const call of h.calls) {
    assert.match(call[1], /CurrentUser/);
    assert.match(call[1], /CurrentSkillEditor-v1/);
  }
  const before = h.calls.length;
  for (const invalid of [
    "",
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(64) + ";quit",
    null,
  ])
    await assert.rejects(h.api.seal(invalid));
  for (const invalid of [
    "",
    "a".repeat(8193),
    "$()",
    "`anything`",
    "'; print(1)",
    null,
  ])
    await assert.rejects(h.api.unseal(invalid));
  assert.equal(h.calls.length, before);
  await assert.rejects(
    harness({ unsealed: "incorrect" }).api.unseal(CIPHER),
    /读回/,
  );
});
test("PID, executable and even nearby creation-time changes are rejected", async () => {
  for (const changed of [
    { ProcessId: 424243 },
    { ExecutablePath: "C:\\foreign\\dota2.exe" },
    { CreatedUtc: "2026-01-01T00:00:00.001Z" },
  ]) {
    const h = harness({ row: (_, row) => ({ ...row, ...changed }) });
    await assert.rejects(h.api.identity(h.game), /身份改变/);
  }
  for (const owners of ["", "424243", "424242\n424243"]) {
    const h = harness({ owners: () => owners });
    await assert.rejects(h.api.identity(h.game), /不属于/);
  }
});
test("fixed command grammar rejects arbitrary Lua, newline and mismatched capability/rid before identity", async () => {
  const h = harness();
  for (const value of [
    "quit",
    "script print(1)",
    "script_reload_code other.lua",
    command() + ";quit",
    command() + "\nquit",
    command("add sven_storm_bolt 1 0") + " extra",
    command("panel toggle"),
    command("panel open;quit"),
    command("panel open extra"),
    command("catalog default 1 5 ff"),
    command("catalog default 01 5 -"),
  ])
    await assert.rejects(h.api.consoleRequest(h.game, PASSWORD, value, RID));
  await assert.rejects(
    h.api.consoleRequest(h.game, PASSWORD, command(), "r_other"),
  );
  await assert.rejects(h.api.consoleRequest(h.game, "x", command(), RID));
  assert.equal(h.calls.length, 0);
});
test("sends exact PASS and fixed command only after a second ownership check", async (t) => {
  const h = await serverFixture(t, (socket, data) => socket.write(reply()));
  const result = await h.api.consoleRequest(h.game, PASSWORD, command(), RID);
  assert.equal(result.answer.requestId, RID);
  assert.equal(h.received[0], `PASS ${PASSWORD}\n${command()}\n`);
  assert.ok(h.calls.filter((call) => call[0] === "identity").length >= 3);
  assert.ok(h.timerDurations.includes(5000));
});
test("ownership changed during connect sends no password or command", async (t) => {
  const h = await serverFixture(
    t,
    () => assert.fail("no credential should be sent"),
    { row: (n, row) => (n === 1 ? row : { ...row, ProcessId: 1 }) },
  );
  await assert.rejects(
    h.api.consoleRequest(h.game, PASSWORD, command(), RID),
    /身份改变/,
  );
  assert.equal(h.received.length, 0);
});
test("waiting ownership guard refuses a channel reassigned to another process", async (t) => {
  const h = await serverFixture(t, () => {}, {
    owners: (n) => (n <= 2 ? "424242" : "1"),
  });
  await assert.rejects(
    h.api.consoleRequest(h.game, PASSWORD, command(), RID),
    /不属于/,
  );
});
test("post-response identity changes are still rejected", async (t) => {
  const h = await serverFixture(t, (socket) => socket.write(reply()), {
    row: (n, row) =>
      n <= 2 ? row : { ...row, ExecutablePath: "C:\\foreign\\dota2.exe" },
    guardInterval: 1000,
  });
  await assert.rejects(
    h.api.consoleRequest(h.game, PASSWORD, command(), RID),
    /身份改变/,
  );
});
test("pending acknowledgement waits for the final same-rid response", async (t) => {
  const h = await serverFixture(t, (socket) => {
    socket.write(
      reply({ pending: { ability: "sven_storm_bolt", stage: "precache" } }),
    );
    setTimeout(
      () =>
        socket.write(
          reply({
            skills: [{ name: "sven_storm_bolt", owned: true, level: 1 }],
          }),
        ),
      40,
    );
  });
  const result = await h.api.consoleRequest(
    h.game,
    PASSWORD,
    command("add sven_storm_bolt 1 0"),
    RID,
  );
  assert.equal(result.answer.pending, undefined);
  assert.equal(result.answer.skills[0].owned, true);
  assert.ok(h.timerDurations.includes(25000));
});
test("pending-only closure and pending timeout cannot become success", async (t) => {
  const closed = await serverFixture(t, (socket) =>
    socket.end(reply({ pending: { stage: "precache" } })),
  );
  await assert.rejects(
    closed.api.consoleRequest(
      closed.game,
      PASSWORD,
      command("add sven_storm_bolt 1 0"),
      RID,
    ),
    /预载完成前关闭/,
  );
  const timed = await serverFixture(
    t,
    (socket) => socket.write(reply({ pending: { stage: "precache" } })),
    { timeout: 50 },
  );
  await assert.rejects(
    timed.api.consoleRequest(
      timed.game,
      PASSWORD,
      command("add sven_storm_bolt 1 0"),
      RID,
    ),
    /最终结果/,
  );
});
test("only complete marker lines with the matching JSON request ID are accepted", async (t) => {
  const partial = await serverFixture(t, (socket) =>
    socket.end(reply().trimEnd()),
  );
  await assert.rejects(
    partial.api.consoleRequest(partial.game, PASSWORD, command(), RID),
    /完整回应前关闭/,
  );
  const mismatch = await serverFixture(t, (socket) =>
    socket.write(reply({ requestId: "r_forged" })),
  );
  await assert.rejects(
    mismatch.api.consoleRequest(mismatch.game, PASSWORD, command(), RID),
    /编号/,
  );
  const malformed = await serverFixture(t, (socket) =>
    socket.write(`CURRENT_SKILL_BRIDGE_REPLY ${RID} {invalid}\n`),
  );
  await assert.rejects(
    malformed.api.consoleRequest(malformed.game, PASSWORD, command(), RID),
    /格式/,
  );
});
test("stale IDs and arbitrary prefix cannot substitute for the current response", async (t) => {
  const h = await serverFixture(
    t,
    (socket) =>
      socket.write(reply({}, "r_stale") + reply({}, RID, "untrusted text ")),
    { timeout: 50 },
  );
  await assert.rejects(
    h.api.consoleRequest(h.game, PASSWORD, command(), RID),
    /过期回应/,
  );
});
test("fragmented UTF8 plus optional fixed VScript prefix is read correctly", async (t) => {
  const h = await serverFixture(t, (socket) => {
    const bytes = Buffer.from(
      reply({ hero: { name: "风暴之灵" } }, RID, "[VScript] "),
    );
    const at = bytes.indexOf(Buffer.from("风")) + 1;
    socket.write(bytes.subarray(0, at));
    setTimeout(() => socket.write(bytes.subarray(at)), 10);
  });
  const result = await h.api.consoleRequest(h.game, PASSWORD, command(), RID);
  assert.equal(result.answer.hero.name, "风暴之灵");
});
test("bounded output ring tolerates many complete engine lines but rejects one oversized line", async (t) => {
  const h = await serverFixture(t, (socket) =>
    socket.write(
      ("engine noise " + "x".repeat(200) + "\n").repeat(700) + reply(),
    ),
  );
  const result = await h.api.consoleRequest(h.game, PASSWORD, command(), RID);
  assert.equal(result.answer.ok, true);
  assert.ok(Buffer.byteLength(result.output) <= 65536);
  const oversized = await serverFixture(t, (socket) =>
    socket.write("x".repeat(65537)),
  );
  await assert.rejects(
    oversized.api.consoleRequest(oversized.game, PASSWORD, command(), RID),
    /单行容量/,
  );
});
test("authentication failures and Lua errors are explicit without leaking credential text", async (t) => {
  for (const line of [
    "Bad password\n",
    "Authentication failed\n",
    "SCRIPT ERROR: current_skill_editor_v1.lua\n",
    "current_skill_editor_v1.lua:24: invalid operation\n",
  ]) {
    const h = await serverFixture(t, (socket) => socket.write(line));
    await assert.rejects(
      h.api.consoleRequest(h.game, PASSWORD, command(), RID),
      (error) =>
        !error.message.includes(PASSWORD) &&
        /认证失败|未能执行/.test(error.message),
    );
  }
});
test("application refusal is returned as failure state, never invented success", async (t) => {
  const h = await serverFixture(t, (socket) =>
    socket.write(reply({ ok: false, error: "cheats required" })),
  );
  const result = await h.api.consoleRequest(h.game, PASSWORD, command(), RID);
  assert.equal(result.answer.ok, false);
  assert.equal(result.answer.error, "cheats required");
});
test("invalid pending types cannot be interpreted as completion", async (t) => {
  for (const pending of [null, true, 1, "precache", []]) {
    const h = await serverFixture(t, (socket) =>
      socket.write(reply({ pending })),
    );
    await assert.rejects(
      h.api.consoleRequest(h.game, PASSWORD, command(), RID),
      /预载状态/,
    );
  }
});
test("unknown bridge uses only the fixed bootstrap once, then retries the original rid", async (t) => {
  const h = await serverFixture(t, (socket, data, n) => {
    const cmd = data.split("\n")[1];
    if (n === 1) socket.write("Unknown command: current_skill_bridge\n");
    else if (n === 2) {
      assert.equal(cmd, "script_reload_code current_skill_editor_v1.lua");
      socket.write("[VScript] CURRENT_SKILL_EDITOR_LOADED\n");
    } else {
      const rid = cmd.split(" ")[2];
      socket.write(reply({}, rid));
    }
  });
  const value = await h.api
    .createTransport()
    .edit(h.game, CAPABILITY, { action: "snapshot" });
  assert.equal(value.ok, true);
  assert.equal(h.received.length, 3);
  assert.equal(h.received[0].split("\n")[1], h.received[2].split("\n")[1]);
});
test("serialized edits and sealed credential cache use current process identity", async (t) => {
  const h = await serverFixture(t, (socket, data) =>
    setTimeout(
      () => socket.write(reply({}, data.split("\n")[1].split(" ")[2])),
      10,
    ),
  );
  const transport = h.api.createTransport();
  const values = await Promise.all([
    transport.edit(h.game, CAPABILITY, { action: "snapshot" }),
    transport.edit(h.game, CAPABILITY, { action: "catalog" }),
  ]);
  assert.equal(values.length, 2);
  assert.notEqual(values[0].requestId, values[1].requestId);
  assert.equal(
    h.calls.filter(
      (call) => call[0] === "ps" && call[1].includes("]::Unprotect("),
    ).length,
    1,
  );
  h.game.sealedPassword = Buffer.from("new synthetic ciphertext").toString(
    "base64",
  );
  await transport.edit(h.game, CAPABILITY, { action: "snapshot" });
  assert.equal(
    h.calls.filter(
      (call) => call[0] === "ps" && call[1].includes("]::Unprotect("),
    ).length,
    2,
  );
});
test("silent registered read-only callbacks recover once with fixed bootstrap and same rid", async (t) => {
  for (const action of ["snapshot", "catalog"]) {
    const h = await serverFixture(
      t,
      (socket, data, n) => {
        const cmd = data.split("\n")[1];
        if (n === 1) return; // Stale native registration: no Unknown command.
        if (n === 2) {
          assert.equal(cmd, "script_reload_code current_skill_editor_v1.lua");
          socket.write("CURRENT_SKILL_EDITOR_LOADED v1\n");
        } else socket.write(reply({}, cmd.split(" ")[2]));
      },
      { timeout: 45 },
    );
    const answer = await h.api
      .createTransport()
      .edit(h.game, CAPABILITY, { action });
    assert.equal(answer.ok, true);
    assert.equal(h.received.length, 3);
    assert.equal(h.received[0].split("\n")[1], h.received[2].split("\n")[1]);
    assert.ok(h.timerDurations.every((ms) => ms === 5000));
  }
});
test("read-only VM recovery never loops after a second silent timeout", async (t) => {
  const h = await serverFixture(
    t,
    (socket, data, n) => {
      if (n === 2) socket.write("CURRENT_SKILL_EDITOR_LOADED\n");
    },
    { timeout: 40 },
  );
  await assert.rejects(
    h.api.createTransport().edit(h.game, CAPABILITY, { action: "snapshot" }),
    (error) => error.code === "CURRENT_SKILL_REQUEST_TIMEOUT",
  );
  assert.equal(h.received.length, 3);
  assert.equal(
    h.received.filter((data) => data.includes("script_reload_code")).length,
    1,
  );
});
test("mutation timeouts preserve unknown outcome without bootstrap or replay", async (t) => {
  for (const payload of [
    { action: "add", ability: "sven_storm_bolt" },
    { action: "level", ability: "sven_storm_bolt", level: 2 },
    { action: "remove", ability: "sven_storm_bolt" },
    { action: "close" },
    { action: "panel", mode: "open" },
    { action: "panel", mode: "close" },
  ]) {
    const h = await serverFixture(t, () => {}, { timeout: 40 });
    await assert.rejects(
      h.api.createTransport().edit(h.game, CAPABILITY, payload),
      (error) =>
        error.code === "CURRENT_SKILL_REQUEST_TIMEOUT" &&
        error.outcomeUnknown === true &&
        /结果未知/.test(error.message),
    );
    assert.equal(h.received.length, 1);
    assert.doesNotMatch(h.received[0], /script_reload_code/);
    assert.ok(
      h.timerDurations.includes(payload.action === "add" ? 25000 : 5000),
    );
  }
});
test("pending mutation timeout is not mistaken for safe stale-VM recovery", async (t) => {
  const h = await serverFixture(
    t,
    (socket, data) =>
      socket.write(
        reply(
          { pending: { stage: "precache" } },
          data.split("\n")[1].split(" ")[2],
        ),
      ),
    { timeout: 40 },
  );
  await assert.rejects(
    h.api
      .createTransport()
      .edit(h.game, CAPABILITY, { action: "add", ability: "sven_storm_bolt" }),
    (error) =>
      error.code === "CURRENT_SKILL_REQUEST_TIMEOUT" && error.outcomeUnknown,
  );
  assert.equal(h.received.length, 1);
});
test("authentication, oversized and malformed read-only replies never bootstrap", async (t) => {
  for (const failure of [
    "auth",
    "oversize",
    "wrong-json-rid",
    "incomplete",
    "stale",
    "closed",
    "lua-error",
  ]) {
    const h = await serverFixture(
      t,
      (socket, data) => {
        const rid = data.split("\n")[1].split(" ")[2];
        if (failure === "auth") socket.write("Bad password\n");
        if (failure === "oversize") socket.write("x".repeat(65537));
        if (failure === "wrong-json-rid")
          socket.write(reply({ requestId: "r_other" }, rid));
        if (failure === "incomplete") socket.write(reply({}, rid).trimEnd());
        if (failure === "stale") socket.write(reply({}, "r_other"));
        if (failure === "closed") socket.end();
        if (failure === "lua-error")
          socket.write("SCRIPT ERROR: current_skill_editor_v1.lua\n");
      },
      { timeout: 40 },
    );
    await assert.rejects(
      h.api.createTransport().edit(h.game, CAPABILITY, { action: "snapshot" }),
      (error) => error.code !== "CURRENT_SKILL_REQUEST_TIMEOUT",
    );
    assert.equal(h.received.length, 1, failure + " must not load or replay");
  }
});
test("lost process ownership during read-only wait never invokes fixed bootstrap", async (t) => {
  const h = await serverFixture(t, () => {}, {
    owners: (n) => (n <= 2 ? "424242" : "1"),
    timeout: 150,
  });
  await assert.rejects(
    h.api.createTransport().edit(h.game, CAPABILITY, { action: "snapshot" }),
    /不属于/,
  );
  assert.equal(h.received.length, 1);
});
test("known Unknown command still permits one fixed bootstrap for a mutation", async (t) => {
  const h = await serverFixture(t, (socket, data, n) => {
    const cmd = data.split("\n")[1];
    if (n === 1) socket.write("Unknown command: current_skill_bridge\n");
    else if (n === 2) socket.write("CURRENT_SKILL_EDITOR_LOADED\n");
    else socket.write(reply({}, cmd.split(" ")[2]));
  });
  const answer = await h.api
    .createTransport()
    .edit(h.game, CAPABILITY, { action: "add", ability: "sven_storm_bolt" });
  assert.equal(answer.ok, true);
  assert.equal(h.received.length, 3);
  assert.equal(h.received[0].split("\n")[1], h.received[2].split("\n")[1]);
});
test("read-only snapshots and catalogs return global pending state without recovery", async (t) => {
  for (const action of ["snapshot", "catalog"]) {
    const h = await serverFixture(
      t,
      (socket, data) => {
        const rid = data.split("\n")[1].split(" ")[2];
        socket.write(
          reply(
            { pending: { ability: "sven_storm_bolt", stage: "precache" } },
            rid,
          ),
        );
      },
      { timeout: 40 },
    );
    const result = await h.api
      .createTransport()
      .edit(h.game, CAPABILITY, { action });
    assert.equal(result.ok, true);
    assert.equal(result.pending.stage, "precache");
    assert.equal(h.received.length, 1);
    assert.doesNotMatch(h.received[0], /script_reload_code/);
  }
});
test("failed adds and other operations with global pending are already final", async (t) => {
  for (const [payload, ok] of [
    [{ action: "add", ability: "sven_storm_bolt" }, false],
    [{ action: "level", ability: "sven_storm_bolt", level: 2 }, false],
    [{ action: "remove", ability: "sven_storm_bolt" }, false],
    [{ action: "close" }, true],
  ]) {
    const h = await serverFixture(
      t,
      (socket, data) => {
        const rid = data.split("\n")[1].split(" ")[2];
        socket.write(
          reply(
            {
              ok,
              error: ok ? "" : "another add is pending",
              pending: { ability: "test_other", stage: "precache" },
            },
            rid,
          ),
        );
      },
      { timeout: 40 },
    );
    const result = await h.api
      .createTransport()
      .edit(h.game, CAPABILITY, payload);
    assert.equal(result.ok, ok);
    assert.equal(result.pending.ability, "test_other");
    assert.equal(h.received.length, 1);
  }
});
