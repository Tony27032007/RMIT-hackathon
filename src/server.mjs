import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { AuthenticationError, TideConfigurationError } from "./auth/tide-auth.mjs";
import { ApiError } from "./errors.mjs";
import { openDatabase } from "./db/database.mjs";
import { createApiRouter } from "./routes/api-routes.mjs";
import { StorageConfigurationError } from "./storage/local-storage.mjs";

const publicRoot = resolve("public");
const tideModuleRoots = new Map([
  ["@tidecloak/js", resolve("node_modules/@tidecloak/js")],
  ["@tideorg/js", resolve("node_modules/@tideorg/js")],
  ["heimdall-tide", resolve("node_modules/heimdall-tide")],
]);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const relayPath = /^\/tide_dpop\/iss\/[a-f\d]+\/aud\/[a-f\d]+\/tide_dpop_auth\.html$/i;
const db = await openDatabase();
const routeApi = createApiRouter({ db });
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const staticAliases = new Map([
  ["/auth/redirect", "/auth/redirect.html"],
]);

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host ?? "localhost"}`).pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname.startsWith("/api/")) {
    try {
      if (await routeApi(request, response, pathname)) return;
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (
        error instanceof AuthenticationError
        || error instanceof TideConfigurationError
        || error instanceof ApiError
        || error instanceof StorageConfigurationError
      ) {
        response.writeHead(error.status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error.message }));
        return;
      }
      console.error("API request failed:", error);
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Internal server error" }));
      return;
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const isRelay = relayPath.test(pathname);
  let filePath;
  if (pathname.startsWith("/node_modules/")) {
    const packagePath = pathname.slice("/node_modules/".length);
    const packageName = packagePath.startsWith("@")
      ? packagePath.split("/").slice(0, 2).join("/")
      : packagePath.split("/")[0];
    const packageRoot = tideModuleRoots.get(packageName);
    if (!packageRoot) {
      response.writeHead(404).end("Not found");
      return;
    }
    const relativePath = packagePath.slice(packageName.length).replace(/^\/+/, "");
    filePath = resolve(packageRoot, relativePath);
    if (filePath !== packageRoot && !filePath.startsWith(`${packageRoot}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!extname(filePath)) {
      for (const candidate of [`${filePath}.js`, resolve(filePath, "index.js")]) {
        try {
          if (!(await stat(candidate)).isFile()) continue;
          const modulePath = relative(resolve("node_modules"), candidate)
            .split(sep)
            .map(encodeURIComponent)
            .join("/");
          response.writeHead(302, { Location: `/node_modules/${modulePath}` }).end();
          return;
        } catch (error) {
          if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
        }
      }
    }
  } else {
    const staticPath = isRelay
      ? "/tide_dpop_auth.html"
      : staticAliases.get(pathname) ?? (pathname === "/" ? "/index.html" : pathname);
    filePath = resolve(publicRoot, `.${staticPath}`);
  }
  if (!pathname.startsWith("/node_modules/") && filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const headers = {
      "Content-Type": contentTypes[extname(filePath)]
        ?? (pathname.startsWith("/node_modules/") && !extname(filePath) ? "application/javascript; charset=utf-8" : "application/octet-stream"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    };

    if (isRelay) {
      headers["Content-Security-Policy"] = "default-src 'self'; script-src 'unsafe-inline'";
      headers["Allow-CSP-From"] = "*";
    }

    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error.code === "ENOENT") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    console.error("Unable to serve request:", error);
    response.writeHead(500).end("Internal server error");
  }
});

server.listen(port, () => {
  console.log(`Hearth is available at http://localhost:${port}`);
});
