import { getCurrentAccount } from "../controllers/account-controller.mjs";
import { getHealth } from "../controllers/health-controller.mjs";
import { authenticateRequest, loadTideConfig } from "../auth/tide-auth.mjs";
import { ApiError } from "../errors.mjs";
import { createRecordingController } from "../controllers/recording-controller.mjs";
import { createDeletionController } from "../controllers/deletion-controller.mjs";
import { createMembershipController } from "../controllers/membership-controller.mjs";
import { createRepositoryController } from "../controllers/repository-controller.mjs";
import { createViewController } from "../controllers/view-controller.mjs";
import { createSqliteJtiStore } from "../db/database.mjs";
import { requireGuardianQuorumPolicy } from "../security/guardian-policy.mjs";
import { createLocalStorage, StorageConfigurationError } from "../storage/local-storage.mjs";

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
  const deletionController = createDeletionController({ db });
  let storage;
  let recordingController;
  let viewController;
  const getStorage = () => {
    if (!storage) storage = createLocalStorage({ env });
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

    const repositoryDeletionRequests = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/deletion-requests$/i);
    if (repositoryDeletionRequests && request.method === "GET") {
      const claims = await authenticate(request);
      deletionController.listDeletionRequests(request, response, claims, repositoryDeletionRequests[1]);
      return true;
    }

    const repositoryAuditEvents = pathname.match(/^\/api\/repositories\/([0-9a-f-]{36})\/audit-events$/i);
    if (repositoryAuditEvents && request.method === "GET") {
      const claims = await authenticate(request);
      repositoryController.listAuditEvents(request, response, claims, repositoryAuditEvents[1]);
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
    const partUpload = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/upload-parts\/([1-9]\d*)$/i);
    const uploadCompletion = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/complete$/i);
    const uploadCancellation = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/upload$/i);
    const viewRequestStart = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/view-requests$/i);
    const viewDecision = pathname.match(/^\/api\/view-requests\/([0-9a-f-]{36})\/decision$/i);
    const viewAccess = pathname.match(/^\/api\/view-requests\/([0-9a-f-]{36})\/access$/i);
    const viewRequests = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/view-requests$/i);
    const recordingContent = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/content$/i);
    const deletionRequestStart = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})\/deletion-requests$/i);
    const deletionDecision = pathname.match(/^\/api\/recording-deletion-requests\/([0-9a-f-]{36})\/decision$/i);
    const recordingDelete = pathname.match(/^\/api\/recordings\/([0-9a-f-]{36})$/i);

    if (recordingContent && request.method === "GET") {
      await getViewController().streamApprovedView(
        request,
        response,
        recordingContent[1],
        new URL(request.url, "http://localhost").searchParams.get("token"),
      );
      return true;
    }
    if (deletionRequestStart && request.method === "POST") {
      const claims = await authenticate(request);
      deletionController.requestDeletion(request, response, claims, deletionRequestStart[1]);
      return true;
    }
    if (deletionDecision && request.method === "POST") {
      const claims = await authenticate(request);
      deletionController.decideDeletion(
        request, response, claims, deletionDecision[1], await readJsonBody(request),
      );
      return true;
    }
    if (recordingDelete && request.method === "DELETE") {
      const claims = await authenticate(request);
      deletionController.deleteRecording(request, response, claims, recordingDelete[1]);
      return true;
    }

    const recordingRoute = (uploadStart && request.method === "POST")
      || (partSigning && request.method === "POST")
      || (partUpload && request.method === "PUT")
      || (uploadCompletion && request.method === "POST")
      || (uploadCancellation && request.method === "DELETE")
      || (viewRequestStart && request.method === "POST")
      || (viewRequests && request.method === "GET")
      || (viewDecision && request.method === "POST")
      || (viewAccess && request.method === "GET");

    if (recordingRoute) {
      const claims = await authenticate(request);
      if (
        (uploadStart && request.method === "POST")
        || (partSigning && request.method === "POST")
        || (partUpload && request.method === "PUT")
        || (uploadCompletion && request.method === "POST")
        || (viewAccess && request.method === "GET")
      ) {
        requireGuardianQuorumPolicy();
      }
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
        const body = request.method === "DELETE" || (partUpload && request.method === "PUT")
          ? {}
          : await readJsonBody(request);
        if (uploadStart) await controller.startUpload(request, response, claims, uploadStart[1], body);
        else if (partSigning) await controller.signUploadParts(request, response, claims, partSigning[1], body);
        else if (partUpload) await controller.uploadPart(
          request,
          response,
          claims,
          partUpload[1],
          Number(partUpload[2]),
        );
        else if (uploadCompletion) await controller.completeUpload(request, response, claims, uploadCompletion[1], body);
        else await controller.cancelUpload(request, response, claims, uploadCancellation[1]);
      }
      return true;
    }

    if (pathname.startsWith("/api/")) {
      const allowedMethods = pathname.endsWith("/upload") || pathname.endsWith("/members/me") || recordingDelete
        ? "DELETE"
        : /\/upload-parts\/\d+$/.test(pathname)
          ? "PUT"
        : "GET, POST";
      if (/\/(uploads|upload-parts|complete|upload|membership-requests|members\/me|decision|view-requests|deletion-requests|audit-events|access)$/.test(pathname)
        || /\/recording-deletion-requests\/[^/]+\/decision$/.test(pathname)
        || /\/upload-parts\/\d+$/.test(pathname)
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
