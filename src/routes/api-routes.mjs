import { getCurrentAccount } from "../controllers/account-controller.mjs";
import { getHealth } from "../controllers/health-controller.mjs";
import { authenticateRequest, loadTideConfig } from "../auth/tide-auth.mjs";
import { ApiError, createRecordingController } from "../controllers/recording-controller.mjs";
import { createMembershipController } from "../controllers/membership-controller.mjs";
import { createRepositoryController } from "../controllers/repository-controller.mjs";
import { createViewController } from "../controllers/view-controller.mjs";
import { createSqliteJtiStore } from "../db/database.mjs";
import { createS3Storage, StorageConfigurationError } from "../storage/s3-storage.mjs";

const MAX_JSON_BODY_BYTES = 64 * 1024;

async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new ApiError(415, "Content-Type must be application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) throw new ApiError(413, "JSON request body is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

function asFetchRequest(request, env) {
  const headers = {
    get(name) {
      const value = request.headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value ?? null;
    },
  };
  const host = headers.get("host") ?? "localhost";
  const forwardedProto = env.TRUST_PROXY === "true" ? headers.get("x-forwarded-proto")?.split(",")[0]?.trim() : null;
  const protocol = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).protocol.slice(0, -1) : "http";
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : `${protocol}://${host}`;

  return {
    url: new URL(request.url, origin).href,
    method: request.method,
    headers,
  };
}

export function createApiRouter({ db, env = process.env }) {
  const jtiStore = createSqliteJtiStore(db);
  const repositoryController = createRepositoryController({ db });
  const membershipController = createMembershipController({ db });
  let storage;
  let recordingController;
  let viewController;
  const getStorage = () => {
    if (!storage) storage = createS3Storage({ env });
    return storage;
  };
  const getRecordingController = () => {
    if (!recordingController) {
      recordingController = createRecordingController({
        db,
        storage: getStorage(),
      });
    }
    return recordingController;
  };
  const getViewController = () => {
    if (!viewController) viewController = createViewController({ db, storage: getStorage() });
    return viewController;
  };
  const authenticate = async (request) => {
    const tideConfig = await loadTideConfig({
      adapterPath: env.TIDECLOAK_ADAPTER_PATH ?? "public/tidecloak.json",
    });
    return authenticateRequest(asFetchRequest(request, env), {
      config: tideConfig,
      jtiStore,
      trustProxy: env.TRUST_PROXY === "true",
      publicOrigin: env.PUBLIC_ORIGIN || undefined,
    });
  };

  return async function routeApi(request, response, pathname) {
    if (pathname === "/api/health" && request.method === "GET") {
      getHealth(request, response);
      return true;
    }

    if (pathname === "/api/me" && request.method === "GET") {
      const claims = await authenticate(request);
      getCurrentAccount(request, response, claims);
      return true;
    }

    if (pathname === "/api/repositories" && request.method === "GET") {
      const claims = await authenticate(request);
      repositoryController.list(request, response, claims);
      return true;
    }
    if (pathname === "/api/repositories" && request.method === "POST") {
      const claims = await authenticate(request);
      repositoryController.create(request, response, claims, await readJsonBody(request));
      return true;
    }

    const repositoryMembershipRequest = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/membership-requests$/i);
    if (repositoryMembershipRequest && ["GET", "POST"].includes(request.method)) {
      const claims = await authenticate(request);
      if (request.method === "GET") {
        membershipController.listMembershipRequests(request, response, claims, repositoryMembershipRequest[1]);
      } else {
        membershipController.requestMembership(request, response, claims, repositoryMembershipRequest[1]);
      }
      return true;
    }

    const repositoryLeave = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/members\/me$/i);
    if (repositoryLeave && request.method === "DELETE") {
      const claims = await authenticate(request);
      membershipController.leaveRepository(request, response, claims, repositoryLeave[1]);
      return true;
    }

    const repositoryMembers = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/members$/i);
    if (repositoryMembers && request.method === "GET") {
      const claims = await authenticate(request);
      repositoryController.listMembers(request, response, claims, repositoryMembers[1]);
      return true;
    }

    const repositoryViewRequests = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/view-requests$/i);
    if (repositoryViewRequests && request.method === "GET") {
      const claims = await authenticate(request);
      getViewController().listRepositoryViewRequests(request, response, claims, repositoryViewRequests[1]);
      return true;
    }

    const membershipDecision = pathname.match(/^\/api\/membership-requests\/([0-9a-f-]{36})\/decision$/i);
    if (membershipDecision && request.method === "POST") {
      const claims = await authenticate(request);
      membershipController.decideMembership(
        request, response, claims, membershipDecision[1], await readJsonBody(request),
      );
      return true;
    }

    const repositoryRecordings = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/recordings$/i);
    if (repositoryRecordings && request.method === "GET") {
      const claims = await authenticate(request);
      repositoryController.listRecordings(request, response, claims, repositoryRecordings[1]);
      return true;
    }

    const uploadStart = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/recordings\/uploads$/i);
    const partSigning = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/upload-parts$/i);
    const uploadCompletion = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/complete$/i);
    const uploadCancellation = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/upload$/i);
    const viewRequestStart = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/view-requests$/i);
    const viewDecision = pathname.match(/^\/api\/view-requests\/([0-9a-f-]{36})\/decision$/i);
    const viewAccess = pathname.match(/^\/api\/view-requests\/([0-9a-f-]{36})\/access$/i);
    const viewRequests = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/view-requests$/i);
    const recordingRoute = (uploadStart && request.method === "POST")
      || (partSigning && request.method === "POST")
      || (uploadCompletion && request.method === "POST")
      || (uploadCancellation && request.method === "DELETE")
      || (viewRequestStart && request.method === "POST")
      || (viewRequests && request.method === "GET")
      || (viewDecision && request.method === "POST")
      || (viewAccess && request.method === "GET");

    if (recordingRoute) {
      const claims = await authenticate(request);
      if (viewRequestStart && request.method === "POST") {
        await getViewController().requestView(request, response, claims, viewRequestStart[1]);
      } else if (viewRequests && request.method === "GET") {
        getViewController().listViewRequests(request, response, claims, viewRequests[1]);
      } else if (viewDecision) {
        getViewController().decideView(request, response, claims, viewDecision[1], await readJsonBody(request));
      } else if (viewAccess) {
        await getViewController().getApprovedView(request, response, claims, viewAccess[1]);
      } else {
        const controller = getRecordingController();
        const body = request.method === "DELETE" ? {} : await readJsonBody(request);
        if (uploadStart) await controller.startUpload(request, response, claims, uploadStart[1], body);
        else if (partSigning) await controller.signUploadParts(request, response, claims, partSigning[1], body);
        else if (uploadCompletion) await controller.completeUpload(request, response, claims, uploadCompletion[1], body);
        else await controller.cancelUpload(request, response, claims, uploadCancellation[1]);
      }
      return true;
    }

    if (pathname.startsWith("/api/")) {
      const allowedMethods = pathname.endsWith("/upload") || pathname.endsWith("/members/me")
        ? "DELETE"
        : "GET, POST";
      if (/\/(uploads|upload-parts|complete|upload|membership-requests|members\/me|decision|view-requests|access)$/.test(pathname)
        || pathname === "/api/repositories") {
        response.writeHead(405, { Allow: allowedMethods, "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Method not allowed" }));
        return true;
      }
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Not found" }));
      return true;
    }

    return false;
  };
}
