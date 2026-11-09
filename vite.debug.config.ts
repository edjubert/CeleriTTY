import { defineConfig } from "vite";
import { localPty } from "./debug/pty-server";

export default defineConfig({
  root: "debug",
  plugins: [localPty()],
  server: {
    host: "127.0.0.1",
    port: 8124,
    strictPort: true,
    fs: { allow: [".."] },
  },
});
