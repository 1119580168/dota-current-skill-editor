// Build only redistributable local font assets. No game client is read.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const fonts = path.join(root, "src/ui/assets/fonts");
const notices = path.join(root, "resources/licenses");
fs.mkdirSync(fonts, { recursive: true });
fs.mkdirSync(notices, { recursive: true });
let css = "";
for (const [pkg, files] of [
  ["noto-sans-sc", ["400.css"]],
  ["noto-serif-sc", ["600.css"]],
  ["cinzel", ["latin-700.css"]],
  ["barlow-condensed", ["latin-600.css", "latin-700.css"]],
]) {
  const dir = path.dirname(require.resolve(`@fontsource/${pkg}/package.json`));
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    css +=
      text.replace(/url\((['"]?)([^)'"\s]+)\1\)/g, (_m, _q, url) => {
        const name = path.basename(url);
        fs.copyFileSync(path.resolve(dir, url), path.join(fonts, name));
        return "url(./" + name + ")";
      }) + "\n";
  }
  fs.copyFileSync(path.join(dir, "LICENSE"), path.join(notices, pkg + "-OFL.txt"));
}
fs.writeFileSync(path.join(fonts, "fonts.css"), css);
console.log("Offline font assets and four OFL notices ready.");
