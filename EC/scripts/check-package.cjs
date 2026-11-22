const asar = require("@electron/asar");
const fs = require("node:fs");
const path = require("node:path");
process.chdir(path.resolve(__dirname, ".."));
const archive = "release/win-unpacked/resources/app.asar";
const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const checked = ["desktop", "dist", "shared"].flatMap(files);
for (const filename of checked) {
  if (!asar.extractFile(archive, path.normalize(filename)).equals(fs.readFileSync(filename)))
    throw new Error(`Packaged file differs from current source: ${filename}`);
}
const expected = require("../package.json"), actual = JSON.parse(asar.extractFile(archive, "package.json"));
if (expected.version !== actual.version || expected.main !== actual.main) throw new Error("Packaged application version differs from source");
console.log("PACKAGED_RUNTIME_MATCH", JSON.stringify({ version: actual.version, files: checked.length }));
