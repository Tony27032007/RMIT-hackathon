import { isAuthenticated, secureApiFetch } from "./auth.js";

const signedOutPanel = document.getElementById("signed-out-panel");
const authenticatedPanel = document.getElementById("authenticated-panel");
const repositoryForm = document.getElementById("repository-form");
const repositoryForms = document.getElementById("repository-forms");
const repositoryList = document.getElementById("repository-list");
const repositoryCount = document.getElementById("repository-count");
const formStatus = document.getElementById("form-status");
const joinStatus = document.getElementById("join-status");
const originConfiguration = document.getElementById("origin-configuration");
const repositoryDetail = document.getElementById("repository-detail");
const repositoryDetailTitle = document.getElementById(
  "repository-detail-title",
);
const repositoryDetailDescription = document.getElementById(
  "repository-detail-description",
);
const repositoryIdValue = document.getElementById("repository-id-value");
const repositoryFilesList = document.getElementById("repository-files-list");
const repositoryGuardiansList = document.getElementById(
  "repository-guardians-list",
);
const repositoryRequestsList = document.getElementById(
  "repository-requests-list",
);
const workflowStatus = document.getElementById("workflow-status");
let selectedRepositoryId = null;
let currentUserId = null;

async function loadOriginConfiguration() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (config.authConfigured && !config.clientOriginAuthConfigured) {
      originConfiguration.textContent = `The adapter is not signed for ${window.location.origin}. Re-export it with this app origin before using Tide/ORK cryptographic operations.`;
      originConfiguration.hidden = false;
    }
  } catch (error) {
    originConfiguration.textContent = `HomeLock could not check the app-origin configuration: ${error.message}`;
    originConfiguration.hidden = false;
  }
}

function setStatus(element, message, state = "ready") {
  element.textContent = message;
  element.dataset.state = state;
}

async function apiRequest(path, options = {}) {
  const response = await secureApiFetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok)
    throw new Error(data?.message || `The server returned ${response.status}.`);
  return data;
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function createButton(text, action, variant = "quiet") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button button-${variant} button-sm`;
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

function repositoryCard(repository) {
  const card = document.createElement("article");
  card.className = "repository-card";
  const title = document.createElement("h3");
  title.textContent = repository.name;
  const description = document.createElement("p");
  description.textContent = repository.description || "No description added.";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = "App-managed votes";
  const openButton = createButton(
    "Open",
    () => void openRepository(repository.id),
    "dark",
  );
  const actions = document.createElement("div");
  actions.className = "repository-card-actions";
  actions.append(badge, openButton);
  card.append(title, description, actions);
  return card;
}

function showRepositoryList() {
  selectedRepositoryId = null;
  currentUserId = null;
  repositoryDetail.hidden = true;
  repositoryForms.hidden = false;
  repositoryList.hidden = false;
}

function shortId(userId) {
  return userId.length > 12 ? `${userId.slice(0, 8)}…` : userId;
}

function personLabel(userId) {
  return userId === currentUserId ? "You" : `Guardian ${shortId(userId)}`;
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "empty-note";
  note.textContent = text;
  return note;
}

function cardHeader(titleText, badgeText, status) {
  const header = document.createElement("div");
  header.className = "workflow-card-header";
  const title = document.createElement("span");
  title.className = "workflow-card-title";
  title.textContent = titleText;
  header.append(title);
  if (badgeText) {
    const badge = document.createElement("span");
    badge.className = "badge";
    if (status) badge.dataset.status = status;
    badge.textContent = badgeText;
    header.append(badge);
  }
  return header;
}

function sizeLabel(size) {
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

async function viewApprovedVideo(file, viewRequestId, item) {
  try {
    setStatus(workflowStatus, "Loading approved video…");
    const response = await secureApiFetch(
      `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/files/${encodeURIComponent(file.id)}/content?requestId=${encodeURIComponent(viewRequestId)}`,
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(
        error?.message || `The server returned ${response.status}.`,
      );
    }
    const encrypted = await response.arrayBuffer();
    const rawKey = decodeBase64Url(
      response.headers.get("x-homelock-encryption-key") || "",
    );
    const iv = decodeBase64Url(
      response.headers.get("x-homelock-encryption-iv") || "",
    );
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plainBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted,
    );
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = URL.createObjectURL(
      new Blob([plainBytes], {
        type:
          response.headers.get("x-homelock-content-type") || file.contentType,
      }),
    );
    video.setAttribute("aria-label", file.name);
    item.append(video);
    setStatus(
      workflowStatus,
      "Video decrypted in your browser after the required approvals.",
    );
  } catch (error) {
    setStatus(workflowStatus, error.message, "error");
  }
}

async function createRequest(type, details = {}) {
  await apiRequest(
    `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/requests`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...details }),
    },
  );
  await openRepository(selectedRepositoryId);
}

function renderFiles(files, requests) {
  if (files.length === 0) {
    repositoryFilesList.replaceChildren(emptyNote("No videos uploaded yet."));
    return;
  }

  const items = files.map((file) => {
    const item = document.createElement("article");
    item.className = "workflow-card";
    const header = cardHeader(file.name);
    const details = document.createElement("p");
    details.className = "subtle";
    const uploader =
      file.uploadedBy === currentUserId
        ? "you"
        : `guardian ${shortId(file.uploadedBy)}`;
    details.textContent = [
      sizeLabel(file.sizeBytes),
      dateLabel(file.createdAt),
      `Uploaded by ${uploader}`,
    ]
      .filter(Boolean)
      .join(" · ");
    details.title = `Uploader ID: ${file.uploadedBy}`;
    const actions = document.createElement("div");
    actions.className = "workflow-actions";
    const activeViewRequest = requests.find(
      (request) =>
        request.type === "view" &&
        request.fileId === file.id &&
        request.actorUserId === currentUserId &&
        request.status === "approved" &&
        !request.consumedAt &&
        String(request.membershipVersion) ===
          repositoryDetail.dataset.membershipVersion,
    );
    if (activeViewRequest) {
      actions.append(
        createButton(
          "Play video",
          () => {
            void viewApprovedVideo(file, activeViewRequest.id, item);
          },
          "dark",
        ),
      );
    } else {
      actions.append(
        createButton(
          "Request to view",
          async () => {
            try {
              await createRequest("view", { fileId: file.id });
              setStatus(
                workflowStatus,
                "View request sent. Every other guardian must approve.",
              );
            } catch (error) {
              setStatus(workflowStatus, error.message, "error");
            }
          },
          "dark",
        ),
      );
    }
    actions.append(
      createButton("Request to delete", async () => {
        try {
          await createRequest("delete", { fileId: file.id });
          setStatus(
            workflowStatus,
            "Delete request sent. Every guardian, including you, must approve.",
          );
        } catch (error) {
          setStatus(workflowStatus, error.message, "error");
        }
      }),
    );
    item.append(header, details, actions);
    return item;
  });
  repositoryFilesList.replaceChildren(...items);
}

const REQUEST_STATUS_LABELS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};

function requestLabel(request, files) {
  const fileName =
    files.find((file) => file.id === request.fileId)?.name || "a video";
  const actor = personLabel(request.actorUserId);
  const target = request.targetUserId ? personLabel(request.targetUserId) : "";
  const names = {
    "guardian-invite": `${actor} invited ${target === "You" ? "you" : target.replace("Guardian", "user")}`,
    join: `${target === "You" ? "You" : target.replace("Guardian", "User")} asked to join`,
    view: `${actor} asked to view ${fileName}`,
    delete: `${actor} asked to delete ${fileName}`,
  };
  return names[request.type] || request.type;
}

function renderRequests(requests, files = []) {
  if (requests.length === 0) {
    repositoryRequestsList.replaceChildren(emptyNote("No requests yet."));
    return;
  }
  const cards = requests.map((request) => {
    const card = document.createElement("article");
    card.className = "workflow-card";
    const header = cardHeader(
      requestLabel(request, files),
      REQUEST_STATUS_LABELS[request.status] || request.status,
      request.status,
    );
    const count = document.createElement("p");
    count.className = "subtle";
    const approvals = request.approvals || 0;
    const rejections = request.rejections || 0;
    count.textContent = [
      `${approvals} of ${request.requiredApprovals} approvals`,
      `${rejections} ${rejections === 1 ? "rejection" : "rejections"}`,
      dateLabel(request.createdAt),
    ]
      .filter(Boolean)
      .join(" · ");
    const actions = document.createElement("div");
    actions.className = "workflow-actions";
    if (request.status === "pending" && request.canVote && !request.myVote) {
      actions.append(
        createButton("Approve", () => void vote(request.id, "approve"), "dark"),
        createButton("Reject", () => void vote(request.id, "reject")),
      );
    } else if (request.myVote) {
      const voteLabel = document.createElement("span");
      voteLabel.className = "subtle";
      voteLabel.textContent =
        request.myVote === "approve"
          ? "You approved this request."
          : "You rejected this request.";
      actions.append(voteLabel);
    }
    card.append(header, count, actions);
    return card;
  });
  repositoryRequestsList.replaceChildren(...cards);
}

async function vote(requestId, decision) {
  try {
    await apiRequest(
      `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/requests/${encodeURIComponent(requestId)}/votes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    );
    setStatus(
      workflowStatus,
      decision === "approve"
        ? "Your approval was recorded."
        : "Your rejection was recorded.",
    );
    await openRepository(selectedRepositoryId);
  } catch (error) {
    setStatus(workflowStatus, error.message, "error");
  }
}

async function openRepository(repositoryId) {
  if (!isAuthenticated()) return;
  repositoryCount.textContent = "Loading repository…";
  try {
    const data = await apiRequest(
      `/api/repositories/${encodeURIComponent(repositoryId)}`,
    );
    selectedRepositoryId = data.repository.id;
    currentUserId = data.currentUserId;
    repositoryDetail.dataset.membershipVersion = String(
      data.repository.membershipVersion,
    );
    repositoryDetailTitle.textContent = data.repository.name;
    repositoryDetailDescription.textContent =
      data.repository.description || "No description added.";
    repositoryIdValue.textContent = data.repository.id;
    renderFiles(data.files, data.requests);
    repositoryGuardiansList.replaceChildren(
      ...data.guardians.map((guardian) => {
        const item = document.createElement("article");
        item.className = "workflow-card";
        const isYou = guardian.userId === currentUserId;
        const userId = document.createElement("code");
        userId.textContent = guardian.userId;
        item.append(
          cardHeader(
            isYou ? "You" : "Guardian",
            isYou ? "Signed in" : "",
            "approved",
          ),
          userId,
        );
        return item;
      }),
    );
    renderRequests(data.requests, data.files);
    repositoryForms.hidden = true;
    repositoryList.hidden = true;
    repositoryDetail.hidden = false;
    repositoryCount.textContent = `${data.guardians.length} ${data.guardians.length === 1 ? "guardian" : "guardians"}`;
  } catch (error) {
    repositoryCount.textContent = error.message;
  }
}

async function loadRepositories() {
  if (!isAuthenticated()) {
    signedOutPanel.hidden = false;
    authenticatedPanel.hidden = true;
    repositoryDetail.hidden = true;
    repositoryCount.textContent = "Sign in to manage repositories.";
    return;
  }
  signedOutPanel.hidden = true;
  authenticatedPanel.hidden = false;
  if (selectedRepositoryId) {
    void openRepository(selectedRepositoryId);
    return;
  }
  showRepositoryList();
  repositoryCount.textContent = "Loading your repositories…";
  try {
    const { repositories } = await apiRequest("/api/repositories");
    repositoryList.replaceChildren(...repositories.map(repositoryCard));
    repositoryCount.textContent =
      repositories.length === 1
        ? "1 repository"
        : `${repositories.length} repositories`;
    if (repositories.length === 0) {
      repositoryList.append(
        emptyNote(
          "No repositories yet. Create one or request to join an existing one.",
        ),
      );
    }
  } catch (error) {
    repositoryCount.textContent = error.message;
  }
}

document
  .getElementById("back-to-repositories")
  .addEventListener("click", () => {
    showRepositoryList();
    void loadRepositories();
  });

document
  .getElementById("copy-repository-id")
  .addEventListener("click", async () => {
    if (!selectedRepositoryId) return;
    try {
      await navigator.clipboard.writeText(selectedRepositoryId);
      setStatus(
        workflowStatus,
        "Repository ID copied. Share it with the person who wants to join.",
      );
    } catch (error) {
      setStatus(
        workflowStatus,
        `Could not copy repository ID: ${error.message}`,
        "error",
      );
    }
  });

document
  .getElementById("file-upload-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = document.getElementById("repository-files").files[0];
    if (!file || !selectedRepositoryId) return;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      if (file.size > 50 * 1024 * 1024 - 16)
        throw new Error("Choose a video smaller than 50 MB.");
      setStatus(workflowStatus, "Encrypting video in your browser…");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"],
      );
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        await file.arrayBuffer(),
      );
      const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      await apiRequest(
        `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/files`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name),
            "X-File-Content-Type": file.type,
            "X-Encryption-IV": encodeBase64Url(iv),
            "X-Encryption-Key": encodeBase64Url(rawKey),
          },
          body: encrypted,
        },
      );
      form.reset();
      setStatus(workflowStatus, "Video encrypted and uploaded.");
      await openRepository(selectedRepositoryId);
    } catch (error) {
      setStatus(workflowStatus, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

document
  .getElementById("guardian-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await createRequest("guardian-invite", {
        userId: document.getElementById("guardian-identity").value.trim(),
      });
      form.reset();
      setStatus(
        workflowStatus,
        "Invite sent. Every guardian, including you, must approve.",
      );
    } catch (error) {
      setStatus(workflowStatus, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

document
  .getElementById("join-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const repositoryId = document
        .getElementById("join-repository-id")
        .value.trim();
      await apiRequest(
        `/api/repositories/${encodeURIComponent(repositoryId)}/requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "join" }),
        },
      );
      form.reset();
      setStatus(joinStatus, "Join request sent. Every guardian must approve.");
    } catch (error) {
      setStatus(joinStatus, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

document
  .getElementById("leave-repository")
  .addEventListener("click", async () => {
    if (
      !selectedRepositoryId ||
      !window.confirm(
        "Leave this repository? All pending requests will expire.",
      )
    )
      return;
    try {
      await apiRequest(
        `/api/repositories/${encodeURIComponent(selectedRepositoryId)}/members/me`,
        { method: "DELETE" },
      );
      showRepositoryList();
      await loadRepositories();
    } catch (error) {
      setStatus(workflowStatus, error.message, "error");
    }
  });

repositoryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = repositoryForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setStatus(formStatus, "Creating repository…");
  try {
    const { repository } = await apiRequest("/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("repository-name").value,
        description: document.getElementById("repository-description").value,
      }),
    });
    repositoryForm.reset();
    selectedRepositoryId = repository.id;
    await loadRepositories();
  } catch (error) {
    setStatus(formStatus, error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

window.addEventListener("homelock-auth-changed", () => {
  void loadRepositories();
  void loadOriginConfiguration();
});

void loadRepositories();
