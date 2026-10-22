export function getCurrentAccount(_request, response, claims) {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    subject: claims.sub,
    username: typeof claims.preferred_username === "string" ? claims.preferred_username : null,
  }));
}
