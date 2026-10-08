// Verify checked-in original resources without invoking Valve's compiler.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const base = path.join(root, "resources/current-skill-editor/6944");
const manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
assert.equal(manifest.schema, 1);
assert.equal(manifest.clientBuild, 6944);
assert.equal(manifest.files.length, 4);
const targets = new Set();
for (const entry of manifest.files) {
  assert.equal(typeof entry.source, "string");
  const file = path.resolve(base, entry.source);
  const relative = path.relative(base, file);
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  assert.ok(fs.lstatSync(file).isFile());
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!targets.has(entry.target));
  targets.add(entry.target);
  const bytes = fs.readFileSync(file);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  if (entry.source === "current_skill_editor_v1.lua") {
    assert.deepEqual(bytes, fs.readFileSync(path.join(root, "tools/current-ability/current_skill_editor_v1.lua")));
  }
}
console.log("Four original editor resources match their SHA-256 manifest.");
