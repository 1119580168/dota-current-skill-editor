// Synthetic clients only: all Windows discovery and spawning are stubbed.
// Tests never run DOTA2, access Steam profiles, or terminate any process.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const f = require("../src/backend/files.cjs");
const w = require("../src/backend/windows.cjs");
const localization = require("../src/current-skill-editor/localization.cjs");
const transport = require("../src/current-skill-editor/transport.cjs");
const {
  createService,
  TARGETS,
  LEASE_TARGETS,
  BUILD,
  REFERENCE,
  SESSION_TARGET,
} = require("../src/current-skill-editor/service.cjs");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const inf = `ClientVersion=${BUILD}\nServerVersion=${BUILD}\nSourceRevision=11085649\nappID=570\nVersionDate=Oct 02 2026\nVersionTime=00:00:00\n`;
const indexBytes = Buffer.from(
  '"ChronicleSkillLocalization" { "Tokens" { "synthetic_ability" "Synthetic" } "SearchTokens" {} }\n',
);

async function fixture(t) {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-current-service-test-"),
  );
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith("chronicle-current-service-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "client"),
    payload = path.join(temp, "payload"),
    data = path.join(temp, "data");
  let gameSource = () => [];
  const discovery = t.mock.method(w, "ps", async (script) => {
    assert.match(script, /^Get-CimInstance Win32_Process -Filter/);
    assert.match(script, /Name='dota2\.exe'/);
    assert.match(script, /Select-Object Name,ProcessId,ExecutablePath/);
    assert.doesNotMatch(script, /Name='hl2\.exe'/);
    assert.doesNotMatch(script, /Stop-Process|Set-Item|Registry|Remove-Item/);
    const rows = await gameSource();
    return rows.length ? JSON.stringify(rows) : "";
  });
  const stop = t.mock.method(w, "stopOwned", async () => {
    throw Error("No process termination is allowed in this test");
  });
  const identity = t.mock.method(w, "identity", async () => {
    throw Error("Unexpected real process identity query");
  });
  const spawning = t.mock.method(childProcess, "spawn", () => {
    throw Error("No native process launch is allowed in this test");
  });
  const transportEdit = t.mock.fn(async () => {
    throw Error("Unexpected native editor control in test");
  });
  t.mock.method(transport, "createTransport", () => ({ edit: transportEdit }));
  const freePort = t.mock.method(transport, "freePort", async () => 39001);
  const seal = t.mock.method(transport, "seal", async (value) => {
    assert.match(value, /^[a-f0-9]{64}$/);
    return Buffer.from("synthetic sealed credential").toString("base64");
  });
  const names = t.mock.method(
    localization,
    "generate",
    async (selectedRoot, language) => {
      assert.equal(selectedRoot, root);
      assert.equal(language, "schinese");
      return indexBytes;
    },
  );
  await fs.mkdir(path.join(root, "game/dota/cfg"), { recursive: true });
  await fs.mkdir(path.join(root, "game/bin/win64"), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(root, "game/dota/steam.inf"), inf);
  await fs.writeFile(
    path.join(root, "game/bin/win64/dota2.exe"),
    "synthetic non-executable client fixture\n",
  );
  await fs.writeFile(
    path.join(root, "game/dota/cfg/config.cfg"),
    "synthetic original config\n",
  );
  const originals = await Promise.all(
    [
      "game/dota/steam.inf",
      "game/bin/win64/dota2.exe",
      "game/dota/cfg/config.cfg",
    ].map(async (relative) => [
      relative,
      await f.hash(path.join(root, relative)),
    ]),
  );
  const files = [];
  for (const target of TARGETS) {
    const source = "original-test-data/" + path.posix.basename(target),
      bytes = Buffer.from("synthetic original tool payload: " + source);
    await fs.mkdir(path.dirname(path.join(payload, source)), {
      recursive: true,
    });
    await fs.writeFile(path.join(payload, source), bytes);
    files.push({ source, target, sha256: sha(bytes) });
  }
  const manifest = { schema: 1, clientBuild: BUILD, files };
  const writeManifest = () =>
    fs.writeFile(path.join(payload, "manifest.json"), JSON.stringify(manifest));
  await writeManifest();
  const service = createService({ data, payload });
  await service.selectRoot(root);
  const stateFile = service.stateFile;
  return {
    temp,
    root,
    payload,
    data,
    service,
    stateFile,
    manifest,
    writeManifest,
    names,
    discovery,
    stop,
    identity,
    spawning,
    transportEdit,
    freePort,
    seal,
    games: (fn) => {
      gameSource = fn;
    },
    syntheticGame: async (name, source2 = true, metadata = inf) => {
      const externalRoot = path.join(temp, "external-" + name),
        relative = source2 ? "game/bin/win64/dota2.exe" : "dota.exe",
        exe = path.join(externalRoot, relative),
        infFile = path.join(
          externalRoot,
          source2 ? "game/dota/steam.inf" : "dota/steam.inf",
        );
      await fs.mkdir(path.dirname(exe), { recursive: true });
      await fs.mkdir(path.dirname(infFile), { recursive: true });
      await fs.writeFile(exe, "synthetic non-executable external fixture\n");
      await fs.writeFile(infFile, metadata);
      return {
        infFile,
        row: {
          Name: path.basename(exe),
          ProcessId: 9001,
          ExecutablePath: exe,
          CreatedUtc: "2026-01-01T00:00:00Z",
        },
      };
    },
    target: (index) => path.join(root, LEASE_TARGETS[index]),
    payloadBytes: (index) =>
      fs.readFile(path.join(payload, manifest.files[index].source)),
    record: () => f.readJson(stateFile),
    writeRecord: (value) => f.writeJson(stateFile, value),
    reopen: () => createService({ data, payload }),
    verifyOriginals: async (exceptInf = false) => {
      for (const [relative, digest] of originals)
        if (!exceptInf || !relative.endsWith("steam.inf"))
          assert.equal(
            await f.hash(path.join(root, relative)),
            digest,
            relative + " changed",
          );
      assert.equal(stop.mock.callCount(), 0);
    },
  };
}

function allowSyntheticLaunch(fx, extraRows = []) {
  const row = {
    Name: "dota2.exe",
    ProcessId: 7100,
    ExecutablePath: path.join(fx.root, "game/bin/win64/dota2.exe"),
    CreatedUtc: "2026-01-01T00:00:00Z",
  };
  fx.identity.mock.mockImplementation(async () => row);
  fx.spawning.mock.mockImplementation(() => {
    fx.games(() => [...extraRows, row]);
    const child = Object.assign(new EventEmitter(), {
      pid: row.ProcessId,
      unref() {},
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
}

test("current editor prepares six tool files including a private capability, repeated prepare is idempotent, and explicit restore leaves originals unchanged", async (t) => {
  const fx = await fixture(t);
  const before = await fx.service.inspect();
  assert.equal(before.compatible, true);
  assert.equal(before.launchEligible, true);
  assert.deepEqual(before.reference, REFERENCE);
  assert.equal(before.baselineMatched, true);
  assert.equal(before.build, BUILD);
  assert.equal(before.serverBuild, BUILD);
  assert.equal(before.sourceRevision, REFERENCE.sourceRevision);
  assert.equal(before.versionDate, "Oct 02 2026");
  assert.equal(before.versionTime, "00:00:00");
  assert.equal(before.installed, false);
  await fx.service.prepare();
  const state = await fx.service.inspect();
  assert.equal(state.installed, true);
  assert.equal(state.canRestore, true);
  assert.equal(state.phase, "已准备");
  assert.equal(state.ownedRunning, false);
  const record = await fx.record(),
    bytes = await fs.readFile(fx.stateFile);
  assert.deepEqual(
    record.lease.files.map((row) => row.target),
    LEASE_TARGETS,
  );
  assert.ok(record.lease.files.every((row) => row.owned && !row.restored));
  for (const row of record.lease.files)
    assert.equal(await f.hash(path.join(fx.root, row.target)), row.sha);
  assert.equal(await fs.readFile(fx.target(4), "utf8"), indexBytes.toString());
  const session = await fs.readFile(path.join(fx.root, SESSION_TARGET), "utf8");
  const capability = session.match(/"Capability"\s+"([a-f0-9]{64})"/)[1];
  assert.equal(record.lease.files.length, 6);
  assert.equal(
    bytes.includes(capability),
    false,
    "nonce stays in the private client file, not persisted settings",
  );
  assert.equal(
    JSON.stringify(state).includes(capability),
    false,
    "inspection must not publish the capability",
  );
  await fx.service.prepare();
  assert.deepEqual(await fs.readFile(fx.stateFile), bytes);
  assert.equal(fx.names.mock.callCount(), 1);
  await fx.service.restore();
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  assert.equal((await fx.service.inspect()).canRestore, false);
  await fx.verifyOriginals();
});

test("identical preexisting tools are borrowed and survive restoration", async (t) => {
  const fx = await fixture(t),
    target = fx.target(0),
    bytes = await fx.payloadBytes(0);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  await fx.service.prepare();
  assert.equal((await fx.record()).lease.files[0].owned, false);
  await fx.service.restore();
  assert.deepEqual(await fs.readFile(target), bytes);
  for (let index = 1; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

test("preexisting different bytes are preserved before any installation intent or other tool write", async (t) => {
  const fx = await fixture(t),
    target = fx.target(2);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "external original file");
  await assert.rejects(fx.service.prepare(), /已有不同内容/);
  assert.equal(await fs.readFile(target, "utf8"), "external original file");
  assert.equal((await fx.record()).lease, null);
  for (const index of [0, 1, 3, 4])
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

test("modified owned file is preserved while other owned files are restored and recovery remains available", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  await fs.writeFile(fx.target(1), "external modification after prepare");
  await assert.rejects(fx.service.restore(), /外部修改/);
  assert.equal(
    await fs.readFile(fx.target(1), "utf8"),
    "external modification after prepare",
  );
  for (const index of [0, 2, 3, 4])
    assert.equal(await f.exists(fx.target(index)), false);
  const state = await fx.service.inspect();
  assert.equal(state.canRestore, true);
  assert.equal(state.installed, false);
  await fs.writeFile(fx.target(1), await fx.payloadBytes(1));
  await fx.service.restore();
  assert.equal(await f.exists(fx.target(1)), false);
  await fx.verifyOriginals();
});

test("directory replacement is treated as an external change and its children are never recursively removed", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  await fs.unlink(fx.target(0));
  await fs.mkdir(fx.target(0));
  const sentinel = path.join(fx.target(0), "external.txt");
  await fs.writeFile(sentinel, "preserve this directory");
  await assert.rejects(fx.service.restore(), /外部修改/);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve this directory");
  for (let index = 1; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

test("crash after persisted intent but before the second file write can be recovered by a fresh service", async (t) => {
  const fx = await fixture(t),
    writeFile = fs.writeFile;
  t.mock.method(fs, "writeFile", async (file, bytes, options) => {
    if (file === fx.target(1) && options?.flag === "wx")
      throw Object.assign(Error("synthetic interrupted write"), {
        code: "EIO",
      });
    return writeFile(file, bytes, options);
  });
  await assert.rejects(fx.service.prepare(), /interrupted/);
  const record = await fx.record();
  assert.equal(record.lease.files.length, 2);
  assert.equal(await f.exists(fx.target(0)), true);
  assert.equal(await f.exists(fx.target(1)), false);
  const recovered = fx.reopen();
  assert.equal((await recovered.inspect()).canRestore, true);
  await recovered.restore();
  assert.equal((await recovered.inspect()).canRestore, false);
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

test("external creation racing exclusive write is borrowed, never deleted, and does not authorize later tool writes", async (t) => {
  const fx = await fixture(t),
    writeFile = fs.writeFile;
  let raced = false;
  t.mock.method(fs, "writeFile", async (file, bytes, options) => {
    if (!raced && file === fx.target(0) && options?.flag === "wx") {
      raced = true;
      await writeFile(file, "racing external bytes");
      throw Object.assign(Error("exists"), { code: "EEXIST" });
    }
    return writeFile(file, bytes, options);
  });
  await assert.rejects(fx.service.prepare(), /安装读回失败/);
  assert.equal((await fx.record()).lease.files[0].owned, false);
  await fx.reopen().restore();
  assert.equal(
    await fs.readFile(fx.target(0), "utf8"),
    "racing external bytes",
  );
  for (let index = 1; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

test("Steam update keeps intact tool preparation, launch, attach and recovery available while reporting actual version", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const oldInfSha = (await fx.record()).lease.infSha;
  await fs.writeFile(
    path.join(fx.root, "game/dota/steam.inf"),
    inf
      .replaceAll("6944", "6951")
      .replace("11085649", "11096670")
      .replace("Oct 02 2026", "Oct 06 2026")
      .replace("00:00:00", "20:08:53")
      .replaceAll("\n", "\r\n"),
  );
  const service = fx.reopen(),
    state = await service.inspect();
  assert.equal(state.compatible, true);
  assert.equal(state.launchEligible, true);
  assert.equal(state.installed, true);
  assert.equal(state.canRestore, true);
  assert.deepEqual(state.reference, REFERENCE);
  assert.equal(state.build, 6951);
  assert.equal(state.serverBuild, 6951);
  assert.equal(state.sourceRevision, 11096670);
  assert.equal(state.versionDate, "Oct 06 2026");
  assert.equal(state.versionTime, "20:08:53");
  assert.equal(state.baselineMatched, false);
  assert.match(state.compatibilityNotice, /7\.41f.*6944.*允许尝试.*尚未验证/);
  assert.equal(state.issue, null);
  assert.notEqual(
    oldInfSha,
    await f.hash(path.join(fx.root, "game/dota/steam.inf")),
  );
  await service.prepare();
  assert.equal(
    fx.names.mock.callCount(),
    1,
    "version changes alone do not invalidate intact tool files",
  );
  const row = {
    ProcessId: 7100,
    ExecutablePath: path.join(fx.root, "game/bin/win64/dota2.exe"),
    CreatedUtc: "2026-01-01T00:00:00Z",
  };
  fx.identity.mock.mockImplementation(async () => row);
  fx.spawning.mock.mockImplementation(() => {
    fx.games(() => [row]);
    const child = Object.assign(new EventEmitter(), {
      pid: row.ProcessId,
      unref() {},
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await service.launch("menu");
  const response = {
    ok: true,
    hero: { unitName: "npc_dota_hero_synthetic" },
    skills: [],
  };
  fx.transportEdit.mock.mockImplementation(async () => response);
  assert.deepEqual(await service.edit({ action: "snapshot" }), response);
  assert.equal((await service.inspect()).editable, true);
  fx.games(() => []);
  await service.restore();
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  assert.equal(fx.spawning.mock.callCount(), 1);
  await fx.verifyOriginals(true);
});

test("an update during localization aborts only that preparation transaction and a newer build can retry", async (t) => {
  const fx = await fixture(t);
  fx.names.mock.mockImplementation(async () => {
    await fs.writeFile(
      path.join(fx.root, "game/dota/steam.inf"),
      inf.replaceAll("6944", "6945"),
    );
    return indexBytes;
  });
  await assert.rejects(fx.service.prepare(), /本次准备过程中已更新.*重试/);
  assert.equal((await fx.record()).lease, null);
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.service.prepare();
  const state = await fx.service.inspect();
  assert.equal(state.installed, true);
  assert.equal(state.baselineMatched, false);
  assert.equal(state.build, BUILD + 1);
  assert.equal(
    (await fx.record()).lease.build,
    BUILD,
    "lease build identifies the tool payload baseline",
  );
  assert.equal((await fx.record()).lease.files.length, LEASE_TARGETS.length);
  await fx.service.restore();
  await fx.verifyOriginals(true);
});

test("an update between tool writes leaves a recoverable partial lease then permits preparation of the updated client", async (t) => {
  const fx = await fixture(t),
    writeFile = fs.writeFile;
  let changed = false;
  t.mock.method(fs, "writeFile", async (file, bytes, options) => {
    const result = await writeFile(file, bytes, options);
    if (!changed && file === fx.target(0) && options?.flag === "wx") {
      changed = true;
      await writeFile(
        path.join(fx.root, "game/dota/steam.inf"),
        inf.replaceAll("6944", "6951"),
      );
    }
    return result;
  });
  await assert.rejects(
    fx.service.prepare(),
    /本次准备过程中已更新.*恢复.*重试/,
  );
  const state = await fx.service.inspect();
  assert.equal(state.launchEligible, true);
  assert.equal(state.build, 6951);
  assert.equal(state.installed, false);
  assert.equal(state.canRestore, true);
  assert.equal((await fx.record()).lease.files.length, 1);
  assert.equal(await f.exists(fx.target(0)), true);
  for (let index = 1; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  const service = fx.reopen();
  await service.restore();
  await service.prepare();
  assert.equal((await service.inspect()).installed, true);
  assert.equal((await service.inspect()).baselineMatched, false);
  await service.restore();
  await fx.verifyOriginals(true);
});

test("client, server and source numbers are metadata rather than permission, including absent or ambiguous fields", async (t) => {
  for (const source of [
    inf.replace(`ClientVersion=${BUILD}`, "ClientVersion=9001"),
    inf.replace(`ServerVersion=${BUILD}`, "ServerVersion=9002"),
    inf.replace("SourceRevision=11085649", "SourceRevision=22000000"),
    "appID=570\nVersionDate=unknown\n",
    inf + "ClientVersion=9001\nSourceRevision=22000000\n",
  ]) {
    const fx = await fixture(t);
    await fs.writeFile(path.join(fx.root, "game/dota/steam.inf"), source);
    const state = await fx.service.inspect();
    assert.equal(state.launchEligible, true);
    assert.equal(state.compatible, true);
    assert.equal(state.baselineMatched, false);
    assert.equal(state.issue, null);
    await fx.service.prepare();
    assert.equal((await fx.service.inspect()).installed, true);
    assert.equal((await fx.record()).lease.build, BUILD);
    await fx.service.restore();
    await fx.verifyOriginals(true);
  }
});

test("steam.inf byte changes do not invalidate intact tool files even when the numeric baseline matches", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  await fs.writeFile(
    path.join(fx.root, "game/dota/steam.inf"),
    inf + "ProductName=dota2\nInformationalField=updated by Steam\n",
  );
  const state = await fx.reopen().inspect();
  assert.equal(state.installed, true);
  assert.equal(state.launchEligible, true);
  assert.equal(state.baselineMatched, true);
  assert.equal(state.issue, null);
  await fx.reopen().prepare();
  assert.equal(fx.names.mock.callCount(), 1);
  await fx.reopen().restore();
  await fx.verifyOriginals(true);
});

test("removing version gates never permits a wrong or ambiguous AppID", async (t) => {
  for (const source of [
    inf.replace("appID=570", "appID=440"),
    inf.replace("appID=570\n", ""),
    inf + "appID=570\n",
  ]) {
    const fx = await fixture(t);
    await fs.writeFile(path.join(fx.root, "game/dota/steam.inf"), source);
    const state = await fx.service.inspect();
    assert.equal(state.launchEligible, false);
    assert.equal(state.compatible, false);
    assert.equal(state.installed, false);
    assert.match(state.issue, /AppID 570/);
    await assert.rejects(fx.service.prepare(), /AppID 570/);
    await assert.rejects(fx.service.launch("menu"), /先准备工具/);
    assert.equal((await fx.record()).lease, null);
    assert.equal(fx.spawning.mock.callCount(), 0);
    await fx.verifyOriginals(true);
  }
});

test("AppID replacement during preparation still refuses installation while Steam version updates are allowed", async (t) => {
  const fx = await fixture(t);
  fx.names.mock.mockImplementation(async () => {
    await fs.writeFile(
      path.join(fx.root, "game/dota/steam.inf"),
      inf.replace("appID=570", "appID=440"),
    );
    return indexBytes;
  });
  await assert.rejects(fx.service.prepare(), /AppID 570/);
  assert.equal((await fx.record()).lease, null);
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals(true);
});

test("a verified external Dota installation blocks writes, restore and new launch without termination", async (t) => {
  const fx = await fixture(t);
  const external = await fx.syntheticGame(
    "dota",
    true,
    inf.replaceAll("6944", "6951"),
  );
  await fx.service.prepare();
  const before = await fs.readFile(fx.stateFile),
    hashes = await Promise.all(
      LEASE_TARGETS.map((_, index) => f.hash(fx.target(index))),
    );
  fx.games(() => [external.row]);
  const state = await fx.service.inspect();
  assert.equal(state.gameRunning, true);
  assert.equal(state.ownedRunning, false);
  await assert.rejects(fx.service.prepare(), /退出 DOTA2/);
  await assert.rejects(fx.service.restore(), /不会关闭外部游戏/);
  await assert.rejects(fx.service.launch("match"), /已运行/);
  assert.deepEqual(await fs.readFile(fx.stateFile), before);
  assert.deepEqual(
    await Promise.all(
      LEASE_TARGETS.map((_, index) => f.hash(fx.target(index))),
    ),
    hashes,
  );
  assert.equal(fx.spawning.mock.callCount(), 0);
  assert.equal(fx.identity.mock.callCount(), 0);
  await fx.verifyOriginals();
});

test("another Source game's hl2.exe does not block first preparation, synthetic launch or restoration", async (t) => {
  const fx = await fixture(t),
    sourceGame = {
      Name: "hl2.exe",
      ProcessId: 9002,
      ExecutablePath: path.join(fx.temp, "Half-Life 2/hl2.exe"),
      CreatedUtc: "2026-01-01T00:00:00Z",
    };
  fx.games(() => [sourceGame]);
  assert.equal((await fx.service.inspect()).gameRunning, false);
  await fx.service.prepare();
  assert.equal((await fx.service.inspect()).installed, true);
  allowSyntheticLaunch(fx, [sourceGame]);
  await fx.service.launch("menu");
  assert.equal((await fx.service.inspect()).ownedRunning, true);
  fx.games(() => [sourceGame]);
  await fx.service.restore();
  assert.equal((await fx.service.inspect()).canRestore, false);
  assert.equal(fx.spawning.mock.callCount(), 1);
  await fx.verifyOriginals();
});

for (const source2 of [true, false]) {
  test(`a valid non-Dota AppID exempts an external ${source2 ? "dota2.exe" : "dota.exe"} from concurrency protection`, async (t) => {
    const fx = await fixture(t),
      external = await fx.syntheticGame("other-app", source2, "appID=220\n");
    fx.games(() => [external.row]);
    const state = await fx.service.inspect();
    assert.equal(state.gameRunning, false);
    assert.equal(state.issue, null);
    await fx.service.prepare();
    allowSyntheticLaunch(fx, [external.row]);
    await fx.service.launch("menu");
    fx.games(() => [external.row]);
    await fx.service.restore();
    assert.equal((await fx.service.inspect()).canRestore, false);
    assert.equal(await fs.readFile(external.infFile, "utf8"), "appID=220\n");
    await fx.verifyOriginals();
  });
}

test("a historical Source 1 Dota with AppID 570 still protects against concurrent preparation, launch and recovery", async (t) => {
  const fx = await fixture(t),
    historical = await fx.syntheticGame(
      "historical",
      false,
      "ClientVersion=40\nappID=570\n",
    );
  fx.games(() => [historical.row]);
  assert.equal((await fx.service.inspect()).gameRunning, true);
  await assert.rejects(fx.service.prepare(), /退出 DOTA2/);
  assert.equal((await fx.record()).lease, null);
  fx.games(() => []);
  await fx.service.prepare();
  fx.games(() => [historical.row]);
  assert.equal((await fx.service.inspect()).issue, null);
  await assert.rejects(fx.service.launch("menu"), /已运行/);
  await assert.rejects(fx.service.restore(), /不会关闭外部游戏/);
  assert.equal(fx.spawning.mock.callCount(), 0);
  assert.equal(
    await fs.readFile(historical.infFile, "utf8"),
    "ClientVersion=40\nappID=570\n",
  );
  await fx.verifyOriginals();
});

test("external 32-bit Source 2 Dota is recognized by its own metadata rather than the selected root", async (t) => {
  const fx = await fixture(t),
    external = await fx.syntheticGame("win32"),
    exe = path.join(
      path.dirname(path.dirname(external.row.ExecutablePath)),
      "win32/dota2.exe",
    );
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.rename(external.row.ExecutablePath, exe);
  fx.games(() => [{ ...external.row, ExecutablePath: exe }]);
  assert.equal((await fx.service.inspect()).gameRunning, true);
  assert.equal((await fx.service.inspect()).issue, null);
  await assert.rejects(fx.service.prepare(), /退出 DOTA2/);
  await fx.verifyOriginals();
});

test("the selected executable keeps write protection when its AppID metadata is replaced or missing", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  fx.games(() => [
    {
      Name: "DOTA2.EXE",
      ProcessId: 9001,
      ExecutablePath: path
        .join(fx.root, "game/bin/win64/dota2.exe")
        .toUpperCase(),
    },
  ]);
  const infFile = path.join(fx.root, "game/dota/steam.inf");
  await fs.writeFile(infFile, "appID=220\n");
  assert.equal((await fx.service.inspect()).gameRunning, true);
  await assert.rejects(fx.service.restore(), /不会关闭外部游戏/);
  await fs.unlink(infFile);
  assert.equal((await fx.service.inspect()).gameRunning, true);
  await assert.rejects(fx.service.restore(), /不会关闭外部游戏/);
  await fs.writeFile(infFile, inf);
  await fx.verifyOriginals();
});

for (const name of ["dota2.exe", "dota.exe"]) {
  test(`a ${name} process with an inaccessible executable path fails closed without terminating it`, async (t) => {
    const fx = await fixture(t);
    await fx.service.prepare();
    const before = await fs.readFile(fx.stateFile);
    fx.games(() => [{ Name: name, ProcessId: 9001, ExecutablePath: null }]);
    const state = await fx.service.inspect();
    assert.equal(state.gameRunning, true);
    assert.equal(state.ownedRunning, false);
    assert.match(state.issue, /无法核实.*路径或 AppID/);
    await assert.rejects(fx.service.prepare(), /无法核实/);
    await assert.rejects(fx.service.restore(), /无法核实/);
    await assert.rejects(fx.service.launch("menu"), /已运行/);
    assert.deepEqual(await fs.readFile(fx.stateFile), before);
    for (let index = 0; index < LEASE_TARGETS.length; index++)
      assert.equal(await f.exists(fx.target(index)), true);
    assert.equal(fx.spawning.mock.callCount(), 0);
    assert.equal(fx.identity.mock.callCount(), 0);
    await fx.verifyOriginals();
  });
}

for (const metadata of [
  "appID=570\nappID=220\n",
  "appID=570\nappID=invalid\n",
  "appID=invalid\n",
  "appID=570\n" + "x".repeat(64 * 1024),
]) {
  test(`ambiguous, invalid or oversized external Dota metadata cannot bypass concurrency protection (${metadata.length} bytes)`, async (t) => {
    const fx = await fixture(t),
      external = await fx.syntheticGame("uncertain", true, metadata);
    fx.games(() => [external.row]);
    const state = await fx.service.inspect();
    assert.equal(state.gameRunning, true);
    assert.match(state.issue, /无法核实/);
    await assert.rejects(fx.service.prepare(), /无法核实/);
    assert.equal((await fx.record()).lease, null);
    assert.equal(await fs.readFile(external.infFile, "utf8"), metadata);
    await fx.verifyOriginals();
  });
}

test("missing or permission-denied external Dota metadata fails closed while preserving its files", async (t) => {
  const fx = await fixture(t),
    external = await fx.syntheticGame("permission-denied"),
    readFile = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === external.infFile)
      throw Object.assign(Error("synthetic access denied"), { code: "EACCES" });
    return readFile(file, ...args);
  });
  fx.games(() => [external.row]);
  assert.equal((await fx.service.inspect()).gameRunning, true);
  await assert.rejects(fx.service.prepare(), /无法核实/);
  await fs.unlink(external.infFile);
  assert.equal((await fx.service.inspect()).gameRunning, true);
  await assert.rejects(fx.service.restore(), /无法核实/);
  assert.equal((await fx.record()).lease, null);
  await fx.verifyOriginals();
});

test("a game appearing during preparation stops before the first tool write and leaves a recoverable empty intent", async (t) => {
  const fx = await fixture(t);
  let count = 0;
  fx.games(() =>
    ++count >= 3
      ? [{ Name: "dota2.exe", ProcessId: 9001, ExecutablePath: null }]
      : [],
  );
  await assert.rejects(fx.service.prepare(), /准备期间启动/);
  assert.equal((await fx.record()).lease.files.length, 0);
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  fx.games(() => []);
  await fx.reopen().restore();
  assert.equal((await fx.reopen().inspect()).canRestore, false);
  await fx.verifyOriginals();
});

test("a game appearing during restore prevents subsequent deletions and a fresh service resumes after exit", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  let count = 0;
  fx.games(() =>
    ++count >= 3
      ? [{ Name: "dota2.exe", ProcessId: 9001, ExecutablePath: null }]
      : [],
  );
  await assert.rejects(fx.service.restore(), /恢复期间启动/);
  assert.equal(await f.exists(fx.target(0)), false);
  for (let index = 1; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), true);
  assert.equal((await fx.record()).lease.files[0].restored, true);
  fx.games(() => []);
  await fx.reopen().restore();
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), false);
  await fx.verifyOriginals();
});

for (const [name, mutate, pattern] of [
  [
    "target traversal",
    (manifest) => {
      manifest.files[0].target = "../outside.lua";
    },
    /资源路径/,
  ],
  [
    "source traversal",
    (manifest) => {
      manifest.files[0].source =
        "../" + path.posix.basename(manifest.files[0].target);
    },
    /资源路径/,
  ],
  [
    "duplicate target",
    (manifest) => {
      manifest.files[1] = { ...manifest.files[0] };
    },
    /资源路径/,
  ],
  [
    "wrong resource digest",
    (manifest) => {
      manifest.files[0].sha256 = "f".repeat(64);
    },
    /资源损坏/,
  ],
  [
    "unknown tool payload baseline",
    (manifest) => {
      manifest.clientBuild = BUILD + 1;
    },
    /资源清单/,
  ],
])
  test("manifest rejects " + name + " before any tool write", async (t) => {
    const fx = await fixture(t);
    mutate(fx.manifest);
    await fx.writeManifest();
    await assert.rejects(fx.service.prepare(), pattern);
    assert.equal((await fx.record()).lease, null);
    for (let index = 0; index < LEASE_TARGETS.length; index++)
      assert.equal(await f.exists(fx.target(index)), false);
    await fx.verifyOriginals();
  });

test("empty generated localization is rejected before installation", async (t) => {
  const fx = await fixture(t);
  fx.names.mock.mockImplementation(async () => Buffer.alloc(0));
  await assert.rejects(fx.service.prepare(), /名称索引无效/);
  assert.equal((await fx.record()).lease, null);
  await fx.verifyOriginals();
});

test("non-file executable is not marked compatible and cannot prepare", async (t) => {
  const fx = await fixture(t),
    exe = path.join(fx.root, "game/bin/win64/dota2.exe");
  await fs.unlink(exe);
  await fs.mkdir(exe);
  assert.equal((await fx.service.inspect()).compatible, false);
  await assert.rejects(fx.service.prepare(), /普通文件/);
  assert.equal((await fx.record()).lease, null);
  assert.equal(fx.spawning.mock.callCount(), 0);
});

test("malformed restoration manifest cannot delete unlisted user files", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  const userFile = path.join(fx.root, "game/dota/user.txt");
  await fs.writeFile(userFile, "external user data");
  record.lease.files[0].target = "game/dota/user.txt";
  record.lease.files[0].sha = sha("external user data");
  await fx.writeRecord(record);
  await assert.rejects(fx.reopen().restore(), /非工具文件/);
  assert.equal(await fs.readFile(userFile, "utf8"), "external user data");
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), true);
  await fx.verifyOriginals();
});

test("restoration lease requires an explicit boolean completion state", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  delete record.lease.restored;
  await fx.writeRecord(record);
  await assert.rejects(fx.reopen().restore(), /安装清单无效/);
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), true);
  await fx.verifyOriginals();
});

test("target directory junction is rejected and outside sentinel remains untouched", async (t) => {
  const fx = await fixture(t),
    parent = path.dirname(fx.target(1)),
    outside = path.join(fx.temp, "outside");
  await fs.mkdir(path.dirname(parent), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "sentinel.txt"), "external sentinel");
  await fs.symlink(
    outside,
    parent,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(fx.service.prepare(), /符号链接|目录联接/);
  assert.equal((await fx.record()).lease, null);
  assert.equal(
    await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"),
    "external sentinel",
  );
  assert.equal(
    await f.exists(path.join(outside, path.basename(fx.target(1)))),
    false,
  );
  await fx.verifyOriginals();
});

test("absolute data/payload roots are required independently of process working directory", () => {
  assert.throws(
    () => createService({ data: "relative", payload: "relative" }),
    /绝对路径/,
  );
});

test("ownedRunning requires PID, executable and creation time; a reused PID is treated as external", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  record.game = {
    pid: 7001,
    exe: path.join(fx.root, "game/bin/win64/dota2.exe"),
    createdUtc: "2026-01-01T00:00:00Z",
    mode: "menu",
  };
  await fx.writeRecord(record);
  fx.games(() => [
    {
      ProcessId: record.game.pid,
      ExecutablePath: record.game.exe,
      CreatedUtc: "2026-01-01T01:00:00Z",
    },
  ]);
  const state = await fx.reopen().inspect();
  assert.equal(state.gameRunning, true);
  assert.equal(state.ownedRunning, false);
  await fx.verifyOriginals();
});

test("launch uses only three fixed native modes without stopping processes or claiming GUI ready", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const launches = [];
  const row = {
    ProcessId: 7100,
    ExecutablePath: path.join(fx.root, "game/bin/win64/dota2.exe"),
    CreatedUtc: "2026-01-01T00:00:00Z",
  };
  fx.identity.mock.mockImplementation(async (pid) => {
    assert.equal(pid, row.ProcessId);
    return row;
  });
  fx.spawning.mock.mockImplementation((exe, args, options) => {
    assert.equal(exe, row.ExecutablePath);
    assert.equal(options.windowsHide, true);
    assert.equal(options.detached, true);
    launches.push(args);
    fx.games(() => [row]);
    const child = Object.assign(new EventEmitter(), {
      pid: row.ProcessId,
      unref() {},
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await assert.rejects(fx.service.launch("skills"), /无效启动方式/);
  for (const mode of ["menu", "demo", "match"]) {
    fx.games(() => []);
    await fx.service.launch(mode);
    const state = await fx.service.inspect();
    assert.equal(state.ownedRunning, true);
    assert.equal(state.phase, "游戏运行中");
  }
  for (const args of launches) {
    assert.ok(args.includes("-console"));
    assert.ok(args.includes("-insecure"));
    assert.ok(args.includes("-vconsole"));
    assert.equal(
      args.filter((argument) => argument === "+sv_cheats").length,
      1,
      "each tool mode enables its local cheat environment exactly once",
    );
    assert.equal(args[args.indexOf("+sv_cheats") + 1], "1");
    assert.equal(args[args.indexOf("-netconport") + 1], "39001");
    const password = args[args.indexOf("-netconpassword") + 1];
    assert.match(password, /^[a-f0-9]{64}$/);
    assert.equal(
      (await fs.readFile(fx.stateFile, "utf8")).includes(password),
      false,
    );
    assert.doesNotMatch(args.join(" "), /script_reload_code|condebug/);
  }
  assert.equal(launches[0].includes("+map"), false);
  assert.equal(launches[1].includes("+map"), false);
  assert.ok(launches[2].includes("+map"));
  await fx.verifyOriginals();
});

test("installed files alone do not claim a connected editor or authorize editing manually started games", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const state = await fx.service.inspect();
  assert.equal(state.editorConnected, false);
  assert.equal(state.editorReady, false);
  assert.equal(state.editable, false);
  await assert.rejects(fx.service.edit({ action: "snapshot" }), /由本工具启动/);
  fx.games(() => [
    {
      ProcessId: 7901,
      ExecutablePath: path.join(fx.root, "game/bin/win64/dota2.exe"),
      CreatedUtc: "2026-01-01T00:00:00Z",
    },
  ]);
  await assert.rejects(fx.service.edit({ action: "snapshot" }), /由本工具启动/);
  assert.equal(fx.transportEdit.mock.callCount(), 0);
  await fx.verifyOriginals();
});

test("only a matching owned game and an intact capability lease can request snapshots, and readiness clears after exit", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  record.game = {
    pid: 7901,
    exe: path.join(fx.root, "game/bin/win64/dota2.exe"),
    createdUtc: "2026-01-01T00:00:00Z",
    port: 39001,
    sealedPassword: "synthetic",
    mode: "match",
  };
  await fx.writeRecord(record);
  const row = {
    ProcessId: record.game.pid,
    ExecutablePath: record.game.exe,
    CreatedUtc: record.game.createdUtc,
  };
  fx.games(() => [row]);
  const value = {
    ok: true,
    hero: { unitName: "npc_dota_hero_synthetic" },
    skills: [],
    catalog: { items: [] },
  };
  fx.transportEdit.mock.mockImplementation(
    async (game, capability, payload) => {
      assert.deepEqual(game, record.game);
      assert.match(capability, /^[a-f0-9]{64}$/);
      assert.deepEqual(payload, { action: "snapshot" });
      return value;
    },
  );
  const service = fx.reopen();
  assert.deepEqual(await service.edit({ action: "snapshot" }), value);
  const ready = await service.inspect();
  assert.equal(ready.editorConnected, true);
  assert.equal(ready.editorReady, true);
  assert.equal(ready.editable, true);
  assert.equal(JSON.stringify(ready).includes("sealedPassword"), false);
  fx.games(() => []);
  const stopped = await service.inspect();
  assert.equal(stopped.editorConnected, false);
  assert.equal(stopped.editorReady, false);
  assert.equal(stopped.editable, false);
  assert.equal(
    stopped.installed,
    true,
    "closing a game does not implicitly remove persistent tools",
  );
  for (let index = 0; index < LEASE_TARGETS.length; index++)
    assert.equal(await f.exists(fx.target(index)), true);
  await assert.rejects(service.edit({ action: "snapshot" }), /由本工具启动/);
  assert.equal(fx.transportEdit.mock.callCount(), 1);
  await fx.verifyOriginals();
});

test("editor connection failure clears mutation readiness without deleting persistent tools or stopping the game", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  record.game = {
    pid: 7901,
    exe: path.join(fx.root, "game/bin/win64/dota2.exe"),
    createdUtc: "2026-01-01T00:00:00Z",
    port: 39001,
    sealedPassword: "synthetic",
    mode: "match",
  };
  await fx.writeRecord(record);
  fx.games(() => [
    {
      ProcessId: record.game.pid,
      ExecutablePath: record.game.exe,
      CreatedUtc: record.game.createdUtc,
    },
  ]);
  fx.transportEdit.mock.mockImplementation(async () => {
    throw Error("synthetic owner channel unavailable");
  });
  const service = fx.reopen();
  await assert.rejects(service.edit({ action: "snapshot" }), /unavailable/);
  const state = await service.inspect();
  assert.equal(state.ownedRunning, true);
  assert.equal(state.editorConnected, false);
  assert.equal(state.editable, false);
  assert.equal(state.installed, true);
  await fx.verifyOriginals();
});

test("altered capability file blocks editor control and is preserved by later explicit recovery", async (t) => {
  const fx = await fixture(t);
  await fx.service.prepare();
  const record = await fx.record();
  record.game = {
    pid: 7901,
    exe: path.join(fx.root, "game/bin/win64/dota2.exe"),
    createdUtc: "2026-01-01T00:00:00Z",
    port: 39001,
    sealedPassword: "synthetic",
    mode: "match",
  };
  await fx.writeRecord(record);
  fx.games(() => [
    {
      ProcessId: record.game.pid,
      ExecutablePath: record.game.exe,
      CreatedUtc: record.game.createdUtc,
    },
  ]);
  const capabilityFile = path.join(fx.root, SESSION_TARGET);
  await fs.writeFile(capabilityFile, "external capability replacement");
  const service = fx.reopen();
  await assert.rejects(service.edit({ action: "snapshot" }), /由本工具启动/);
  assert.equal(fx.transportEdit.mock.callCount(), 0);
  fx.games(() => []);
  await assert.rejects(service.restore(), /外部修改/);
  assert.equal(
    await fs.readFile(capabilityFile, "utf8"),
    "external capability replacement",
  );
  await fx.verifyOriginals();
});
