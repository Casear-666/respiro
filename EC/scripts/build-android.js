import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const android = join(project, "android");
const bundle = process.argv.includes("--bundle");
const task = bundle ? ":app:bundleRelease" : ":app:assembleDebug";
const windows = process.platform === "win32";
const runner = windows ? (process.env.ComSpec || "cmd.exe") : "sh";
const args = windows ? ["/d", "/c", "gradlew.bat", task] : ["./gradlew", task];
const result = spawnSync(runner, args, { cwd: android, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const { version } = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
const output = join(project, "artifacts", "android");
mkdirSync(output, { recursive: true });
const signed = Boolean(process.env.CALENDAR_ANDROID_KEYSTORE);
const source = bundle ? "bundle/release/app-release.aab" : "apk/debug/app-debug.apk";
const flavor = bundle ? (signed ? "release" : "unsigned") : "debug";
const artifact = join(output, `EnergyCalendar-${version}-${flavor}.${bundle ? "aab" : "apk"}`);
copyFileSync(join(android, "app", "build", "outputs", source), artifact);
console.log(artifact);
