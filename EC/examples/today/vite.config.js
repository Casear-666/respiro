import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// The demo lives in examples/today but imports the real domain model two
// folders up, so the dev server must be allowed to read the EC root.
const root = fileURLToPath(new URL(".", import.meta.url));
export default {
  root,
  plugins: [react()],
  server: {
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
};
