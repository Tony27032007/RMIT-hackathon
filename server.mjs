import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const publicRoot = resolve("public");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const relayPath = /^\/tide_dpop\/iss\/[a-f\d]+\/aud\/[a-f\d]+\/tide_dpop_auth\.html$/i;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }

  const isRelay = relayPath.test(pathname);
  const filePath = resolve(publicRoot, `.${isRelay ? "/tide_dpop_auth.html" : pathname === "/" ? "/index.html" : pathname}`);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const headers = {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
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
