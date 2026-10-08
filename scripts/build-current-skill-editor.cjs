// Compile only original current-client UI/Lua sources. The installed Valve
// compiler and native foundations remain external and are never distributed.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { inside, noLinks } = require("../src/backend/files.cjs");

const PROJECT = path.resolve(__dirname, "..");
const BUILD = 6944;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function main() {
  const argument = process.argv[2] || process.env.CHRONICLE_CURRENT_CLIENT;
  if (!argument || !path.isAbsolute(argument))
    throw Error("Supply an absolute local build 6944 client folder.");
  const client = path.resolve(argument);
  await noLinks(client);
  const infFile = inside(client, "game/dota/steam.inf");
  await noLinks(infFile);
  const inf = await fs.readFile(infFile, "utf8");
  if (
    !/^ClientVersion=6944\s*$/m.test(inf) ||
    !/^ServerVersion=6944\s*$/m.test(inf)
  )
    throw Error("Requires matching current-client/server build 6944 tools.");
  const compiler = inside(client, "game/bin/win64/resourcecompiler.exe");
  const compilerDll = inside(client, "game/bin/win64/resourcecompiler.dll");
  for (const file of [compiler, compilerDll]) {
    await noLinks(file);
    if (!(await fs.stat(file)).isFile()) throw Error("Compiler is not a file.");
  }
  const build = inside(PROJECT, "local/current-skill-editor-build");
  const payload = inside(PROJECT, "resources/current-skill-editor/6944");
  await noLinks(build);
  await noLinks(payload);
  // Current RC requires GAMEROOT and CONTENTROOT to be sibling directories.
  // Mount installed resources with relative search paths rather than copying them.
  const gameRoot = inside(build, "game");
  const game = inside(build, "game/dota");
  const gameInfo = inside(game, "gameinfo.gi");
  await noLinks(gameInfo);
  const installed = ["dota", "core"].map((name) => {
    const relative = path.relative(gameRoot, inside(client, "game/" + name));
    if (path.isAbsolute(relative))
      throw Error(
        "The isolated build and installed client must share a drive.",
      );
    return relative.replaceAll("\\", "/");
  });
  await fs.mkdir(game, { recursive: true });
  await fs.writeFile(
    gameInfo,
    '"GameInfo" { game "Chronicle current editor build" FileSystem { ' +
      'SteamAppId 570 SearchPaths { Game "dota" ' +
      installed.map((relative) => 'Game "' + relative + '"').join(" ") +
      ' Mod "dota" } } Engine2 { PanoramaUIClientFromClient 1 } }\n',
    "utf8",
  );
  const lua = "current_skill_editor_v1.lua";
  const luaSource = inside(PROJECT, "tools/current-ability/" + lua);
  await noLinks(luaSource);
  const luaBytes = await fs.readFile(luaSource);
  const files = [];
  for (const [kind, sourceExt, engineExt, resourceVersion] of [
    ["scripts", "js", "vjs", 4],
    ["styles", "css", "vcss", 3],
    ["layout", "xml", "vxml", 3],
  ]) {
    const base = `${kind}/custom_game/current_ability_editor`;
    const source = inside(
      PROJECT,
      `tools/current-ability/ui/${base}.${sourceExt}`,
    );
    await noLinks(source);
    const staged = inside(build, `content/dota/panorama/${base}.${engineExt}`);
    await noLinks(staged);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    await fs.copyFile(source, staged);
    // Modern layout compilation resolves the original .js/.css authoring aliases.
    const alias = inside(build, `content/dota/panorama/${base}.${sourceExt}`);
    await noLinks(alias);
    await fs.copyFile(source, alias);
    const result = spawnSync(
      compiler,
      [
        "-nop4",
        "-f",
        "-game",
        game,
        "-contentroot",
        inside(build, "content"),
        "-outroot",
        inside(build, "game"),
        "-i",
        staged,
      ],
      {
        cwd: path.dirname(compiler),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 8 * 1024 ** 2,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0)
      throw Error(result.error?.message || result.stdout + result.stderr);
    const relative = `panorama/${base}.${engineExt}_c`;
    const compiled = inside(build, "game/dota/" + relative);
    await noLinks(compiled);
    const bytes = await fs.readFile(compiled);
    if (
      bytes.length < 16 ||
      bytes.readUInt16LE(4) !== 12 ||
      bytes.readUInt16LE(6) !== resourceVersion
    )
      throw Error(`Unexpected current Panorama resource version for ${kind}.`);
    const output = inside(payload, relative);
    await noLinks(output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, bytes);
    files.push({
      source: relative,
      target: `game/dota/${relative}`,
      sha256: hash(bytes),
    });
    console.log(`Compiled ${path.basename(relative)} (${bytes.length} bytes)`);
  }
  await fs.mkdir(payload, { recursive: true });
  const outputLua = inside(payload, lua);
  await noLinks(outputLua);
  await fs.writeFile(outputLua, luaBytes);
  files.push({
    source: lua,
    target: `game/dota/scripts/vscripts/${lua}`,
    sha256: hash(luaBytes),
  });
  const manifest = inside(payload, "manifest.json");
  await noLinks(manifest);
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        schema: 1,
        clientBuild: BUILD,
        files: files.sort((a, b) => a.target.localeCompare(b.target)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Original current-client skill editor payload ready.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
