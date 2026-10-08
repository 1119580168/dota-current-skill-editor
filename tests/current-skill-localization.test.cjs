const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  generate,
  TARGET,
} = require("../src/current-skill-editor/localization.cjs");
const heroRoot = "scripts/npc/npc_heroes.txt";
const heroFile = "scripts/npc/heroes/npc_dota_hero_synthetic.txt";
const localFile = "resource/localization/abilities_english.txt";
const utf8 = (text, bom = true) =>
  Buffer.concat([
    bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
    Buffer.from(text),
  ]);

function sources(bom = true) {
  return [
    [
      localFile,
      utf8(
        '"lang" { "Tokens" {\n' +
          '"DOTA_Tooltip_ability_synthetic_skill" "Synthetic Storm"\n' +
          '"DOTA_Tooltip_ability_skill_description" "Legitimate suffix name"\n' +
          '"DOTA_Tooltip_ability_generic_def" "Generic Test"\n' +
          '"DOTA_Tooltip_ability_only_loose" "Loose Definition"\n' +
          '"DOTA_Tooltip_ability_synthetic_skill_description" "IGNORE DESCRIPTION"\n' +
          '"DOTA_Tooltip_ability_synthetic_skill_damage" "IGNORE PARAMETER"\n' +
          '"DOTA_Tooltip_ability_synthetic_skill_lore" "IGNORE LORE"\n' +
          '"DOTA_Tooltip_ability_damage" "IGNORE NESTED KEY"\n' +
          '"DOTA_Tooltip_ability_bogus_from_slot" "IGNORE SLOT REFERENCE"\n' +
          '"DOTA_Tooltip_ability_comment_only" "IGNORE COMMENT"\n' +
          "} }",
        bom,
      ),
    ],
    [
      "resource/localization/abilities_schinese.txt",
      utf8(
        '"lang" { "Tokens" {\n"DOTA_Tooltip_ability_synthetic_skill" "测试技能"\n} }',
        bom,
      ),
    ],
    [
      "resource/localization/items_english.txt",
      utf8('"DOTA_Tooltip_Ability_item_synthetic" "Synthetic Item"\n', bom),
    ],
    [
      "resource/localization/items_schinese.txt",
      utf8(
        '"DOTA_Tooltip_Ability_item_synthetic_description" "IGNORE ITEM DESCRIPTION"\n',
        bom,
      ),
    ],
    [
      "scripts/npc/npc_abilities.txt",
      utf8(
        '"DOTAAbilities" { // #base "../ignore.txt"\n' +
          '"generic_def" { "DisplayName" "#Local_Token" "QuotedBraces" "{ ignored }" ' +
          '"AbilityValues" { "damage" "1" } } /* "comment_only" { } */ }',
        bom,
      ),
    ],
    [
      "scripts/npc/items.txt",
      utf8('"DOTAAbilities" { "item_synthetic" { "MaxLevel" "1" } }', bom),
    ],
    [
      heroRoot,
      utf8('#base "heroes/npc_dota_hero_synthetic.txt"\n"DOTAHeroes" {}', bom),
    ],
    [
      heroFile,
      utf8(
        '"DOTAHeroes" { "npc_dota_hero_synthetic" {\n' +
          '"AbilityDefinitions" { "synthetic_skill" { "MaxLevel" "4" ' +
          '"AbilityValues" { "damage" "1" } } "skill_description" { "MaxLevel" "1" } }\n' +
          '"Ability1" "bogus_from_slot" "Facets" { "1" { "AbilityDefinitions" ' +
          '{ "damage" { "Value" "999" } } } } } }',
        bom,
      ),
    ],
  ];
}

// Synthetic VPK v1/v2 fixtures: no Valve data is copied into the tests.
async function writeVpk(
  root,
  { rows = sources(), version = 2, embedded = false, preload = 7, alter } = {},
) {
  const folder = path.join(root, "game/dota");
  await fs.mkdir(folder, { recursive: true });
  const groups = new Map();
  for (const [file, bytes] of rows) {
    const ext = path.posix.extname(file).slice(1),
      directory = path.posix.dirname(file);
    if (!groups.has(ext)) groups.set(ext, new Map());
    const directories = groups.get(ext);
    if (!directories.has(directory)) directories.set(directory, []);
    directories
      .get(directory)
      .push([path.posix.basename(file, "." + ext), file, bytes]);
  }
  const tree = [],
    data = [];
  let offset = 0;
  for (const [ext, directories] of groups) {
    tree.push(Buffer.from(ext + "\0"));
    for (const [directory, entries] of directories) {
      tree.push(Buffer.from(directory + "\0"));
      for (const [name, file, bytes] of entries) {
        const pre = Math.min(preload, bytes.length),
          entry = Buffer.alloc(18);
        entry.writeUInt16LE(pre, 4);
        entry.writeUInt16LE(embedded ? 0x7fff : 0, 6);
        entry.writeUInt32LE(offset, 8);
        entry.writeUInt32LE(bytes.length - pre, 12);
        entry.writeUInt16LE(65535, 16);
        alter?.(entry, file);
        tree.push(Buffer.from(name + "\0"), entry, bytes.subarray(0, pre));
        data.push(bytes.subarray(pre));
        offset += bytes.length - pre;
      }
      tree.push(Buffer.from([0]));
    }
    tree.push(Buffer.from([0]));
  }
  tree.push(Buffer.from([0]));
  const directory = Buffer.concat(tree),
    payload = Buffer.concat(data),
    header = Buffer.alloc(version === 1 ? 12 : 28);
  header.writeUInt32LE(0x55aa1234, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(directory.length, 8);
  if (version === 2) header.writeUInt32LE(embedded ? payload.length : 0, 12);
  await fs.writeFile(
    path.join(folder, "pak01_dir.vpk"),
    Buffer.concat([header, directory, embedded ? payload : Buffer.alloc(0)]),
  );
  if (!embedded)
    await fs.writeFile(path.join(folder, "pak01_000.vpk"), payload);
}

async function fixture(t, options) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "chronicle-current-names-test-"),
  );
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("chronicle-current-names-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeVpk(root, options);
  return root;
}

for (const options of [
  { label: "v2 split archive with UTF8 BOM", version: 2, preload: 7 },
  {
    label: "v2 embedded data without BOM",
    version: 2,
    embedded: true,
    preload: 3,
    rows: sources(false),
  },
  {
    label: "v1 embedded data and preload",
    version: 1,
    embedded: true,
    preload: 11,
  },
])
  test("exact modern skill names from " + options.label, async (t) => {
    const root = await fixture(t, options),
      original = await fs.readFile(path.join(root, "game/dota/pak01_dir.vpk"));
    const output = (await generate(root, "schinese")).toString("utf8");
    assert.match(output, /"synthetic_skill" "测试技能"/);
    assert.match(output, /"synthetic_skill" "Synthetic Storm 测试技能"/);
    assert.match(output, /"skill_description" "Legitimate suffix name"/);
    assert.match(output, /"item_synthetic" "Synthetic Item"/);
    assert.match(output, /"generic_def" "Generic Test"/);
    assert.doesNotMatch(
      output,
      /IGNORE|bogus_from_slot|only_loose|synthetic_skill_description|synthetic_skill_damage|synthetic_skill_lore/,
    );
    assert.deepEqual(
      await fs.readFile(path.join(root, "game/dota/pak01_dir.vpk")),
      original,
    );
    await assert.rejects(fs.access(path.join(root, TARGET)), {
      code: "ENOENT",
    });
  });

test("loose native definition takes precedence over the VPK version without accepting mere hero AbilityN references", async (t) => {
  const root = await fixture(t),
    target = path.join(root, "game/dota", heroFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    target,
    utf8(
      '"DOTAHeroes" { "npc_dota_hero_synthetic" { "Ability1" "synthetic_skill" "AbilityDefinitions" { "only_loose" { "MaxLevel" "1" } } } }',
    ),
  );
  const output = (await generate(root)).toString("utf8");
  assert.match(output, /"only_loose" "Loose Definition"/);
  assert.doesNotMatch(output, /"synthetic_skill"/);
});

for (const [label, directive] of [
  ["parent traversal", '#base "../npc_dota_hero_synthetic.txt"'],
  ["absolute path", '#base "C:/outside/npc_dota_hero_synthetic.txt"'],
  ["unrelated file", '#base "heroes/other.txt"'],
  ["nested directory", '#base "heroes/sub/npc_dota_hero_synthetic.txt"'],
])
  test("hero #base rejects " + label, async (t) => {
    const rows = sources();
    rows.find((row) => row[0] === heroRoot)[1] = utf8(
      directive + '\n"DOTAHeroes" {}',
    );
    const root = await fixture(t, { rows });
    await assert.rejects(generate(root), /固定 heroes 白名单/);
  });

test("hero #base duplicate is rejected before reading additional resources", async (t) => {
  const rows = sources();
  rows.find((row) => row[0] === heroRoot)[1] = utf8(
    '#base "heroes/npc_dota_hero_synthetic.txt"\n#base "heroes/npc_dota_hero_synthetic.txt"\n"DOTAHeroes" {}',
  );
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /路径重复/);
});

test("hero #base count is bounded to the verified 129 filenames", async (t) => {
  const rows = sources();
  rows.find((row) => row[0] === heroRoot)[1] = utf8(
    Array.from(
      { length: 130 },
      (_, index) => `#base "heroes/npc_dota_hero_synthetic_${index}.txt"`,
    ).join("\n") + '\n"DOTAHeroes" {}',
  );
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /超过 129/);
});

test("included hero cannot recursively include even another matching hero filename", async (t) => {
  const rows = sources();
  rows.find((row) => row[0] === heroFile)[1] = utf8(
    '#base "heroes/npc_dota_hero_base.txt"\n"DOTAHeroes" {}',
  );
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /固定 heroes 白名单/);
});

test("missing fixed hero resource is reported without searching another directory", async (t) => {
  const root = await fixture(t, {
    rows: sources().filter((row) => row[0] !== heroFile),
  });
  await assert.rejects(generate(root), /缺少技能名称或定义资源/);
});

for (const [label, bytes, pattern] of [
  [
    "truncated block",
    utf8('"DOTAHeroes" { "npc_dota_hero_synthetic" {'),
    /未完整结束/,
  ],
  ["truncated comment", utf8('"DOTAHeroes" { /* incomplete'), /注释截断/],
  ["wrong root", utf8('"DOTAAbilities" {}'), /根节点无效/],
  [
    "excessive depth",
    utf8('"DOTAHeroes" {' + '"nested" {'.repeat(70) + "}".repeat(71)),
    /嵌套过深/,
  ],
])
  test(
    "hero parser rejects " + label + " with bounded structural parsing",
    async (t) => {
      const rows = sources();
      rows.find((row) => row[0] === heroFile)[1] = bytes;
      const root = await fixture(t, { rows });
      await assert.rejects(generate(root), pattern);
    },
  );

test("UTF16 localization is rejected rather than misread as UTF8", async (t) => {
  const rows = sources();
  rows.find((row) => row[0] === localFile)[1] = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('"Tokens" {}', "utf16le"),
  ]);
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /encoded data|UTF-8/i);
});

test("UTF8 localization containing NUL is rejected", async (t) => {
  const rows = sources();
  rows.find((row) => row[0] === localFile)[1] = utf8('"Tokens" {\0}');
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /无效字符/);
});

test("VPK duplicate fixed localization entry is rejected", async (t) => {
  const rows = sources();
  rows.push(rows.find((row) => row[0] === localFile));
  const root = await fixture(t, { rows });
  await assert.rejects(generate(root), /资源重复/);
});

test("VPK source offsets are bounded to an actual archive file", async (t) => {
  const root = await fixture(t, {
    alter: (entry, file) => {
      if (file === localFile) entry.writeUInt32LE(0xfffffff0, 8);
    },
  });
  await assert.rejects(generate(root), /资源截断/);
});

test("VPK tree size is rejected before oversized allocation", async (t) => {
  const root = await fixture(t),
    file = path.join(root, "game/dota/pak01_dir.vpk"),
    bytes = await fs.readFile(file);
  bytes.writeUInt32LE(64 * 1024 ** 2 + 1, 8);
  await fs.writeFile(file, bytes);
  await assert.rejects(generate(root), /目录大小无效/);
});

test("loose hero directory junction is rejected without reading outside client", async (t) => {
  const root = await fixture(t),
    outside = path.join(root, "synthetic-outside"),
    target = path.join(root, "game/dota/scripts/npc/heroes");
  await fs.mkdir(outside);
  await fs.writeFile(
    path.join(outside, path.basename(heroFile)),
    '"DOTAHeroes" {}',
  );
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(
    outside,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(generate(root), /符号链接|目录联接/);
});

test("relative client root is refused", async () => {
  await assert.rejects(generate("relative"), /绝对路径/);
});
