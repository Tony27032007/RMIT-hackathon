import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = resolve(root, "public");
const distDir = resolve(root, "dist");

for (const name of ["tide_dpop_auth.html", "tidecloak.json"]) {
  const source = resolve(publicDir, name);
  if (existsSync(source)) copyFileSync(source, resolve(distDir, name));
}
