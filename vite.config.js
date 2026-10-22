import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "public");

export default defineConfig({
  root,
  publicDir: false,
  base: "/",
  build: {
    target: "esnext",
    outDir: resolve(root, "../dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(root, "index.html"),
        redirect: resolve(root, "auth/redirect.html"),
        silentSso: resolve(root, "silent-check-sso.html"),
      },
    },
  },
});
