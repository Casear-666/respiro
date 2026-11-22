import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAccountStore } from "./accounts.js";
import { passwordError } from "../shared/auth.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const username = process.argv[2];
const password = process.env.CALENDAR_ADMIN_PASSWORD;
const dataDir = path.resolve(process.env.CALENDAR_DATA_DIR || path.join(root, "data"));

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!username) fail("用法：npm run server:create-user -- <用户名>");
if (passwordError(password)) fail(`请在环境变量 CALENDAR_ADMIN_PASSWORD 中提供密码：${passwordError(password)}`);

const store = openAccountStore(path.join(dataDir, "accounts.sqlite"));
try {
  const user = await store.createUser(username, password);
  console.log(`已创建账号：${user.username}`);
} catch (error) {
  console.error(`创建账号失败：${error.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
