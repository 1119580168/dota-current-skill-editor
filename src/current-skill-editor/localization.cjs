const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { inside, noLinks } = require("../backend/files.cjs");
const { languageCode } = require("../backend/languages.cjs");

const TARGET = "game/dota/scripts/npc/current_skill_localization_v1.txt";
const MAX_TREE = 64 * 1024 ** 2;
const MAX_SOURCE = 8 * 1024 ** 2;
const MAX_OUTPUT = 2 * 1024 ** 2;
const MAX_NAMES = 20000;
const MAX_HERO_FILES = 129;
const MAX_TOTAL_SOURCE = 64 * 1024 ** 2;
const NAME = /^[a-z0-9_]{1,160}$/;
const LOCALIZATIONS = Object.freeze([
  "resource/localization/abilities_english.txt",
  "resource/localization/abilities_schinese.txt",
  "resource/localization/items_english.txt",
  "resource/localization/items_schinese.txt",
]);
const DEFINITIONS = Object.freeze([
  "scripts/npc/npc_abilities.txt",
  "scripts/npc/items.txt",
  "scripts/npc/npc_heroes.txt",
]);
const ALLOWED_ENTRIES = new Set([...LOCALIZATIONS, ...DEFINITIONS]);
const HERO_SOURCE =
  /^scripts\/npc\/heroes\/npc_dota_hero_[a-z0-9_]{1,96}\.txt$/;
const HERO_BASE = /^heroes\/npc_dota_hero_[a-z0-9_]{1,96}\.txt$/;
const allowed = (name) => ALLOWED_ENTRIES.has(name) || HERO_SOURCE.test(name);

async function readAt(handle, position, length, message) {
  const stat = await handle.stat();
  if (
    !stat.isFile() ||
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    position + length > stat.size
  )
    throw Error(message);
  const bytes = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const next = await handle.read(
      bytes,
      count,
      length - count,
      position + count,
    );
    if (!next.bytesRead) throw Error(message);
    count += next.bytesRead;
  }
  return bytes;
}

function safeTreePart(value, directory = false) {
  if (value === " ") return;
  if (
    !value ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    (!directory && value.includes("/")) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("VPK 目录含不安全的资源路径");
}

function parseTree(tree, wanted) {
  let position = 0;
  const entries = new Map();
  const string = () => {
    const end = tree.indexOf(0, position);
    if (end < position || end - position > 4096)
      throw Error("VPK 目录字符串损坏");
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      tree.subarray(position, end),
    );
    position = end + 1;
    return value;
  };
  for (let extension; (extension = string());) {
    safeTreePart(extension);
    for (let directory; (directory = string());) {
      safeTreePart(directory, true);
      for (let name; (name = string());) {
        safeTreePart(name);
        if (
          position + 18 > tree.length ||
          tree.readUInt16LE(position + 16) !== 65535
        )
          throw Error("VPK 目录条目损坏");
        const preloadSize = tree.readUInt16LE(position + 4);
        const entry = {
          archive: tree.readUInt16LE(position + 6),
          offset: tree.readUInt32LE(position + 8),
          length: tree.readUInt32LE(position + 12),
        };
        position += 18;
        if (position + preloadSize > tree.length)
          throw Error("VPK 预载数据截断");
        const relative =
          (directory === " " ? "" : directory + "/") +
          name +
          (extension === " " ? "" : "." + extension);
        if (wanted.has(relative)) {
          if (entries.has(relative)) throw Error("VPK 技能名称资源重复");
          if (entry.length + preloadSize > MAX_SOURCE || entry.archive > 0x7fff)
            throw Error("VPK 技能名称资源大小或分块无效");
          entry.preload = tree.subarray(position, position + preloadSize);
          entries.set(relative, entry);
        }
        position += preloadSize;
      }
    }
  }
  if (position !== tree.length) throw Error("VPK 目录存在多余或截断数据");
  return entries;
}

async function readEntries(root, wanted) {
  for (const name of wanted)
    if (!allowed(name)) throw Error("技能名称资源超出白名单");
  if (wanted.size > MAX_HERO_FILES + ALLOWED_ENTRIES.size)
    throw Error("技能名称资源文件数量过多");
  const directory = inside(root, "game/dota/pak01_dir.vpk");
  await noLinks(directory);
  const handle = await fs.open(directory, "r");
  try {
    const first = await readAt(handle, 0, 12, "VPK 文件头截断");
    const version = first.readUInt32LE(4),
      size = first.readUInt32LE(8);
    if (
      first.readUInt32LE(0) !== 0x55aa1234 ||
      ![1, 2].includes(version) ||
      size < 1 ||
      size > MAX_TREE
    )
      throw Error("VPK 文件头、版本或目录大小无效");
    const start = version === 1 ? 12 : 28;
    const extra =
      version === 2 ? await readAt(handle, 12, 16, "VPK 文件头截断") : null;
    const tree = await readAt(handle, start, size, "VPK 目录截断");
    const entries = parseTree(tree, wanted);
    const result = new Map();
    let total = 0;
    for (const name of wanted) {
      const entry = entries.get(name);
      if (!entry) throw Error("原版 VPK 缺少技能名称或定义资源：" + name);
      total += entry.length + entry.preload.length;
      if (total > MAX_TOTAL_SOURCE) throw Error("技能名称资源总大小过大");
      let payload = Buffer.alloc(0);
      if (entry.length) {
        if (entry.archive === 0x7fff) {
          if (extra && entry.offset + entry.length > extra.readUInt32LE(0))
            throw Error("VPK 内嵌资源超出数据区");
          payload = await readAt(
            handle,
            start + size + entry.offset,
            entry.length,
            "VPK 内嵌技能名称资源截断",
          );
        } else {
          const part = inside(
            root,
            "game/dota/pak01_" +
              String(entry.archive).padStart(3, "0") +
              ".vpk",
          );
          await noLinks(part);
          const archive = await fs.open(part, "r");
          try {
            payload = await readAt(
              archive,
              entry.offset,
              entry.length,
              "VPK 分块技能名称资源截断",
            );
          } finally {
            await archive.close();
          }
        }
      }
      result.set(name, Buffer.concat([entry.preload, payload]));
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function looseSource(root, relative) {
  if (!allowed(relative)) throw Error("原版技能定义资源超出白名单");
  const file = inside(root, "game/dota/" + relative);
  await noLinks(file);
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE)
      throw Error("原版技能资源大小无效");
    return await readAt(handle, 0, stat.size, "原版技能资源截断");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readSources(root, wanted) {
  const result = new Map(),
    missing = new Set();
  let total = 0;
  for (const name of wanted) {
    const bytes = await looseSource(root, name);
    if (bytes) {
      total += bytes.length;
      if (total > MAX_TOTAL_SOURCE) throw Error("技能名称资源总大小过大");
      result.set(name, bytes);
    } else missing.add(name);
  }
  if (missing.size)
    for (const [name, bytes] of await readEntries(root, missing)) {
      total += bytes.length;
      if (total > MAX_TOTAL_SOURCE) throw Error("技能名称资源总大小过大");
      result.set(name, bytes);
    }
  return result;
}

// Parse structure, not suffix guesses: only DOTAAbilities definition blocks and
// DOTAHeroes/<hero>/AbilityDefinitions blocks contribute exact ability IDs.
// Only npc_heroes.txt may include #base, limited to its fixed heroes directory.
function definitionIds(bytes, { heroes = false, allowBases = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SOURCE)
    throw Error("原版技能定义大小无效");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw Error("原版技能定义含无效字符");
  const ids = new Set(),
    bases = new Set();
  let position = 0,
    tokens = 0;
  const next = () => {
    while (position < text.length) {
      if (/\s/.test(text[position])) {
        position++;
        continue;
      }
      if (text.startsWith("//", position)) {
        const end = text.indexOf("\n", position + 2);
        position = end < 0 ? text.length : end + 1;
        continue;
      }
      if (text.startsWith("/*", position)) {
        const end = text.indexOf("*/", position + 2);
        if (end < 0) throw Error("原版技能定义注释截断");
        position = end + 2;
        continue;
      }
      break;
    }
    if (position >= text.length) return null;
    if (++tokens > 1000000) throw Error("原版技能定义词项过多");
    const start = position,
      first = text[position++];
    if (first === "{" || first === "}") return { type: first };
    if (first === '"') {
      let value = "",
        closed = false;
      while (position < text.length) {
        const character = text[position++];
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (position >= text.length) throw Error("原版技能定义字符串截断");
          value += text[position++];
        } else value += character;
        if (value.length > 8192) throw Error("原版技能定义字符串过长");
      }
      if (!closed) throw Error("原版技能定义字符串截断");
      return { type: "value", value };
    }
    if (first === "[") {
      const end = text.indexOf("]", position);
      if (end < 0 || end - start > 128 || /[\r\n]/.test(text.slice(start, end)))
        throw Error("原版技能定义条件无效");
      position = end + 1;
      return { type: "condition" };
    }
    while (position < text.length && !/[\s{}"\[\]]/.test(text[position]))
      position++;
    if (position - start > 8192) throw Error("原版技能定义词项过长");
    return { type: "value", value: text.slice(start, position) };
  };
  const block = (stack) => {
    if (stack.length > 64) throw Error("原版技能定义嵌套过深");
    for (;;) {
      const key = next();
      if (!key) throw Error("原版技能定义未完整结束");
      if (key.type === "}") return;
      if (key.type === "condition") continue;
      if (key.type !== "value" || key.value.startsWith("#"))
        throw Error("原版技能定义键无效或含不支持的包含指令");
      const value = next();
      if (!value) throw Error("原版技能定义未完整结束");
      if (value.type === "{") {
        const isDefinition = !heroes && stack.length === 1;
        const isHeroAbility =
          heroes &&
          stack.length === 3 &&
          /^npc_dota_hero_[a-z0-9_]{1,96}$/.test(stack[1]) &&
          stack[2] === "AbilityDefinitions";
        if ((isDefinition || isHeroAbility) && NAME.test(key.value)) {
          ids.add(key.value);
          if (ids.size > MAX_NAMES) throw Error("原版技能定义数量过多");
        }
        block([...stack, key.value]);
      } else if (value.type !== "value") throw Error("原版技能定义值无效");
    }
  };
  let rootSeen = false;
  for (let token; (token = next());) {
    if (token.type === "value" && token.value === "#base") {
      const file = next();
      if (!allowBases || file?.type !== "value" || !HERO_BASE.test(file.value))
        throw Error("原版英雄包含路径超出固定 heroes 白名单");
      if (bases.has(file.value)) throw Error("原版英雄包含路径重复");
      bases.add(file.value);
      if (bases.size > MAX_HERO_FILES)
        throw Error("原版英雄包含文件数量超过 129");
      continue;
    }
    const rootName = heroes ? "DOTAHeroes" : "DOTAAbilities";
    if (
      rootSeen ||
      token.type !== "value" ||
      token.value !== rootName ||
      next()?.type !== "{"
    )
      throw Error("原版技能定义根节点无效");
    rootSeen = true;
    block([rootName]);
  }
  if (!rootSeen) throw Error("原版技能定义没有根节点");
  return { ids, bases };
}

function unescape(value) {
  return value.replace(
    /\\([\\"nrt])/g,
    (_, escaped) =>
      ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped],
  );
}

function names(bytes, ids) {
  if (bytes.length < 1 || bytes.length > MAX_SOURCE)
    throw Error("名称资源大小无效");
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "");
  if (text.includes("\0")) throw Error("名称资源含无效字符");
  const result = new Map();
  const pattern =
    /^[ \t]*"DOTA_Tooltip_ability_([a-z0-9_]{1,160})"[ \t]+"((?:\\.|[^"\\\r\n])*)"[ \t]*(?:\[[^\]\r\n]*\][ \t]*)?(?:\/\/[^\r\n]*)?\r?$/gim;
  for (let match; (match = pattern.exec(text));) {
    const id = match[1].toLowerCase();
    if (!ids.has(id)) continue;
    const value = unescape(match[2]).replace(/\s+/g, " ").trim();
    if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) continue;
    result.set(id, value);
    if (result.size > MAX_NAMES) throw Error("名称资源条目过多");
  }
  return result;
}

function quote(value) {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function generate(root, language = "english") {
  if (typeof root !== "string" || !path.isAbsolute(root))
    throw Error("技能名称读取需要实际客户端绝对路径");
  const selectedLanguage = languageCode(language);
  await noLinks(root);
  const entries = await readSources(
    root,
    new Set([...LOCALIZATIONS, ...DEFINITIONS]),
  );
  const ids = new Set();
  for (const name of DEFINITIONS.slice(0, 2))
    for (const id of definitionIds(entries.get(name)).ids) ids.add(id);
  const heroRoot = definitionIds(entries.get(DEFINITIONS[2]), {
    heroes: true,
    allowBases: true,
  });
  for (const id of heroRoot.ids) ids.add(id);
  const heroEntries = await readSources(
    root,
    new Set([...heroRoot.bases].map((name) => "scripts/npc/" + name)),
  );
  for (const bytes of heroEntries.values())
    for (const id of definitionIds(bytes, { heroes: true }).ids) ids.add(id);
  if (!ids.size || ids.size > MAX_NAMES) throw Error("原版技能定义数量无效");
  const english = new Map(),
    schinese = new Map();
  for (const source of LOCALIZATIONS) {
    const target = source.endsWith("_schinese.txt") ? schinese : english;
    for (const [id, value] of names(entries.get(source), ids))
      target.set(id, value);
  }
  const available = [
    ...new Set([...english.keys(), ...schinese.keys()]),
  ].sort();
  if (!available.length) throw Error("原版包没有可用的技能名称");
  const tokens = [],
    searchTokens = [];
  for (const id of available) {
    const display =
      (selectedLanguage === "schinese" && schinese.get(id)) ||
      english.get(id) ||
      id;
    const search = [
      ...new Set([english.get(id), schinese.get(id)].filter(Boolean)),
    ].join(" ");
    tokens.push("\t\t" + quote(id) + " " + quote(display));
    searchTokens.push("\t\t" + quote(id) + " " + quote(search));
  }
  const bytes = Buffer.from(
    '"ChronicleSkillLocalization"\n{\n\t"Tokens"\n\t{\n' +
      tokens.join("\n") +
      '\n\t}\n\t"SearchTokens"\n\t{\n' +
      searchTokens.join("\n") +
      "\n\t}\n}\n",
    "utf8",
  );
  if (bytes.length > MAX_OUTPUT) throw Error("临时技能名称索引过大");
  return bytes;
}

module.exports = { generate, TARGET };
