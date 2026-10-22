let guardians = [
  { name: "Alex Morgan", email: "alex@example.test", initials: "A", tone: "avatar-rose", yours: true },
  { name: "Jordan Morgan", email: "jordan@example.test", initials: "J", tone: "avatar-blue" },
  { name: "Casey Morgan", email: "casey@example.test", initials: "C", tone: "avatar-gold" },
];

const recordings = [
  { title: "Front porch · Morning", when: "Today · 10:42 AM", source: "Front door camera", duration: "00:18", tone: "tone-porch" },
  { title: "Garden · Movement detected", when: "Today · 9:16 AM", source: "Back garden camera", duration: "00:34", tone: "tone-garden" },
  { title: "Driveway · Visitor", when: "Today · 8:03 AM", source: "Driveway camera", duration: "00:12", tone: "tone-drive" },
  { title: "Front entry · Package delivered", when: "Yesterday · 4:28 PM", source: "Front door camera", duration: "00:26", tone: "tone-entry" },
  { title: "Back garden · Evening", when: "Yesterday · 7:51 PM", source: "Back garden camera", duration: "00:41", tone: "tone-evening" },
  { title: "Driveway · Car arrived", when: "Yesterday · 6:12 PM", source: "Driveway camera", duration: "00:09", tone: "tone-drive" },
];

let requests = [];
let viewRequests = [];
let activeRepository = null;
let currentSubject = null;
let liveMode = false;
let repositories = [];
const formSection = document.getElementById("form-section");
const previewBanner = document.getElementById("mode-banner");
const connectionError = document.getElementById("connection-error");
const connectionErrorMessage = document.getElementById("connection-error-message");
const uploadDialog = document.getElementById("upload-dialog");
const requestDialog = document.getElementById("request-dialog");
const videoDialog = document.getElementById("video-dialog");
const videoPlayer = document.getElementById("video-player");
const videoCaption = document.getElementById("video-caption");
const fileInput = document.getElementById("video-file");
const filePrompt = document.getElementById("file-prompt");
const fileHint = document.getElementById("file-hint");
const uploadMessage = document.getElementById("upload-message");
const requestMessage = document.getElementById("request-message");
const createRepositoryDialog = document.getElementById("create-repository-dialog");

async function api(path, options = {}) {
  const iam = window.__tideIAM;
  const token = await iam?.getToken();
  if (!token) throw new Error("Sign in again before using the repository.");

  const headers = new Headers(options.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  let body = options.body;
  if (body !== undefined && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  const response = await iam.secureFetch(new URL(path, location.origin), {
    ...options,
    headers,
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  }
  return payload;
}

function shortSubject(subject) {
  return subject.length > 18 ? `${subject.slice(0, 8)}…${subject.slice(-6)}` : subject;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

function setMessage(node, message) {
  node.textContent = message;
}

function showAppMessage(message) {
  const notice = document.getElementById("app-message");
  notice.replaceChildren(element("span", "notice-dot"), document.createTextNode(message));
  notice.hidden = false;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function recordingCard(recording) {
  const card = element("article", "recording-card");
  const thumbnail = element("div", `recording-thumb ${recording.tone}`);
  thumbnail.setAttribute("aria-label", "Recording preview");
  thumbnail.append(element("span", "thumb-sun"), element("span", "thumb-house"));

  const playButton = element("button", "thumb-play");
  playButton.type = "button";
  playButton.setAttribute("aria-label", `Open ${recording.title}`);
  playButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5 12 8l-7 4.5v-9Z" /></svg>';
  playButton.addEventListener("click", () => openRecording(recording));
  thumbnail.append(playButton);

  const duration = element("span", "recording-duration", recording.duration || "NEW");
  thumbnail.append(duration);

  const details = element("div", "recording-details");
  details.append(element("h3", "recording-name", recording.title));
  const subtitle = element("div", "recording-subtitle");
  subtitle.append(element("span", "recording-source", recording.when));
  subtitle.append(element("span", "", recording.source));
  details.append(subtitle);
  card.append(thumbnail, details);
  return card;
}

function renderRecordings() {
  const recent = document.getElementById("recent-recordings");
  const all = document.getElementById("all-recordings");
  const emptyMessage = liveMode ? "No recordings have been added to this repository yet." : "No recordings are available.";
  const recentCards = recordings.slice(0, 3).map(recordingCard);
  const allCards = recordings.map(recordingCard);
  if (recordings.length === 0) {
    recentCards.push(element("p", "empty-state", emptyMessage));
    allCards.push(element("p", "empty-state", emptyMessage));
  }
  recent.replaceChildren(...recentCards);
  all.replaceChildren(...allCards);

  const count = recordings.length;
  document.getElementById("recording-count").textContent = String(count).padStart(2, "0");
  document.getElementById("repository-recordings").textContent = String(count);
  document.getElementById("recordings-total").textContent = String(count);
}

async function openRecording(recording) {
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  videoPlayer.hidden = true;
  videoCaption.textContent = liveMode
    ? "Checking this recording’s guardian approvals…"
    : recording.url
      ? `${recording.title} · ${recording.when} · ${recording.source}`
      : `${recording.title} · Sample archive entry — no video file is included in this prototype.`;

  if (!liveMode) {
    videoPlayer.hidden = !recording.url;
    if (recording.url) videoPlayer.src = recording.url;
    videoDialog.showModal();
    return;
  }

  videoDialog.showModal();
  try {
    await refreshRepositoryRequests();
    const existing = viewRequests.find((request) => (
      request.recording_id === recording.id
      && request.requester_subject_id === currentSubject
      && ["pending", "approved"].includes(request.status)
    ));
    if (existing?.status === "approved") {
      const access = await api(`/api/view-requests/${existing.id}/access`);
      videoPlayer.src = access.url;
      videoPlayer.hidden = false;
      videoCaption.textContent = `${recording.title} · Approved access expires in ${access.expiresInSeconds} seconds.`;
    } else if (existing) {
      videoCaption.textContent = `${recording.title} · Waiting for every active guardian, including you, to approve.`;
    } else {
      await api(`/api/recordings/${recording.id}/view-requests`, { method: "POST", body: {} });
      await refreshRepositoryRequests();
      videoCaption.textContent = `${recording.title} · View request submitted. Every active guardian, including you, must approve before playback.`;
      setView("guardians");
    }
  } catch (error) {
    videoCaption.textContent = error instanceof Error ? error.message : "Could not request recording access.";
  }
}

function renderGuardians() {
  const list = document.getElementById("guardian-list");
  if (liveMode) {
    const tones = ["avatar-rose", "avatar-blue", "avatar-gold"];
    document.getElementById("guardian-count").textContent = String(guardians.length);
    document.getElementById("repository-guardians").textContent = String(guardians.length);
    list.replaceChildren(...guardians.map((guardian, index) => {
      const label = shortSubject(guardian.subject_id);
      const row = element("div", "guardian-row");
      row.append(element("span", `guardian-avatar ${tones[index % tones.length]}`, label.slice(0, 1).toUpperCase()));
      const details = element("div", "guardian-details");
      const name = element("div", "guardian-name", `Account ${label}`);
      if (guardian.subject_id === currentSubject) name.append(element("span", "you-pill", "You"));
      details.append(name, element("small", "", `Joined ${formatDate(guardian.joined_at)}`));
      row.append(details, element("span", "guardian-role", guardian.role));
      return row;
    }));
    renderRequests();
    return;
  }

  list.replaceChildren(
    ...guardians.map((guardian) => {
      const row = element("div", "guardian-row");
      row.append(element("span", `guardian-avatar ${guardian.tone}`, guardian.initials));

      const details = element("div", "guardian-details");
      const name = element("div", "guardian-name");
      name.append(document.createTextNode(guardian.name));
      if (guardian.yours) name.append(element("span", "you-pill", "You"));
      details.append(name, element("small", "", guardian.email));

      row.append(details, element("span", "guardian-role", "Guardian"));
      return row;
    }),
  );
  renderRequests();
}

function renderRequests() {
  const section = document.getElementById("requests-section");
  const list = document.getElementById("request-list");
  section.hidden = requests.length === 0;

  if (liveMode) {
    list.replaceChildren(...requests.map((request) => {
      const card = element("article", "request-card");
      const heading = element("div", "request-row");
      const summary = element("div", "guardian-details");
      summary.append(
        element("div", "request-email", `Account ${shortSubject(request.requester_subject_id)}`),
        element(
          "small",
          "request-status",
          request.status === "cancelled"
            ? request.cancellation_reason || "Request canceled."
            : `${request.approved_count} of ${request.required_approvals} approvals recorded`,
        ),
      );
      heading.append(summary, element("span", "you-pill", request.status === "cancelled" ? "Canceled" : "Pending"));
      card.append(heading);

      if (request.status === "cancelled") {
        return card;
      }
      if (request.my_decision) {
        heading.append(element("span", "you-pill", request.my_decision === "approve" ? "You approved" : "You rejected"));
      } else {
        for (const decision of ["approve", "reject"]) {
          const button = element("button", "approve-button", decision === "approve" ? "Approve request" : "Reject request");
          button.type = "button";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await api(`/api/membership-requests/${request.id}/decision`, { method: "POST", body: { decision } });
              await loadRepository(activeRepository);
            } catch (error) {
              showAppMessage(error instanceof Error ? error.message : "Could not record the decision.");
            } finally {
              button.disabled = false;
            }
          });
          heading.append(button);
        }
      }
      return card;
    }));
    renderViewRequests();
    return;
  }

  list.replaceChildren(
    ...requests.map((request) => {
      const card = element("article", "request-card");
      const heading = element("div", "request-row");
      const summary = element("div", "guardian-details");
      summary.append(element("div", "request-email", request.email));

      const approvedCount = request.approvals.filter(Boolean).length;
      const unanimous = approvedCount === guardians.length;
      const status = unanimous
        ? "All approvals shown in this preview — no account was actually added."
        : `Waiting for all guardians · ${approvedCount} of ${guardians.length} approvals shown`;
      summary.append(element("small", `request-status${unanimous ? " is-approved" : ""}`, status));
      heading.append(summary, element("span", "you-pill", unanimous ? "Preview complete" : "Pending"));
      card.append(heading);

      guardians.forEach((guardian, index) => {
        const approvalRow = element("div", "request-row request-approval-row");
        approvalRow.append(element("span", `guardian-avatar ${guardian.tone}`, guardian.initials));
        const approver = element("div", "guardian-details");
        approver.append(
          element("div", "guardian-name", guardian.name),
          element("small", "", "Adult family subscriber"),
        );

        const approveButton = element(
          "button",
          "approve-button",
          request.approvals[index] ? "Approval shown" : "Record approval",
        );
        approveButton.type = "button";
        approveButton.disabled = request.approvals[index];
        approveButton.setAttribute("aria-label", `${request.approvals[index] ? "Approval recorded for" : "Record preview approval for"} ${guardian.name}`);
        approveButton.addEventListener("click", () => {
          request.approvals[index] = true;
          renderRequests();
        });
        approvalRow.append(approver, approveButton);
        card.append(approvalRow);
      });

      return card;
    }),
  );
}

function renderViewRequests() {
  const section = document.getElementById("view-requests-section");
  const list = document.getElementById("view-request-list");
  const visible = viewRequests.filter((request) => ["pending", "cancelled"].includes(request.status));
  section.hidden = visible.length === 0;
  list.replaceChildren(...visible.map((request) => {
    const card = element("article", "request-card");
    const heading = element("div", "request-row");
    const summary = element("div", "guardian-details");
    const requestedBy = request.requester_subject_id === currentSubject ? "You requested" : `Account ${shortSubject(request.requester_subject_id)}`;
    summary.append(
      element("div", "request-email", `${requestedBy} · ${request.filename}`),
      element(
        "small",
        "request-status",
        request.status === "cancelled"
          ? request.cancellation_reason || "Request canceled."
          : `${request.approved_count} of ${request.required_approvals} guardian approvals recorded`,
      ),
    );
    heading.append(summary);

    if (request.status === "cancelled") {
      heading.append(element("span", "you-pill", "Canceled"));
    } else if (request.my_decision) {
      heading.append(element("span", "you-pill", request.my_decision === "approve" ? "You approved" : "You rejected"));
    } else {
      for (const decision of ["approve", "reject"]) {
        const button = element("button", "approve-button", decision === "approve" ? "Approve view" : "Reject view");
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await api(`/api/view-requests/${request.id}/decision`, { method: "POST", body: { decision } });
            await refreshRepositoryRequests();
          } catch (error) {
            showAppMessage(error instanceof Error ? error.message : "Could not record the decision.");
          } finally {
            button.disabled = false;
          }
        });
        heading.append(button);
      }
    }
    card.append(heading);
    return card;
  }));
}

function setView(viewName) {
  document.querySelectorAll(".view-panel").forEach((panel) => {
    const active = panel.id === `view-${viewName}`;
    panel.hidden = !active;
    panel.classList.toggle("is-current", active);
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.view === viewName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  const titles = { overview: "Overview", recordings: "Recordings", guardians: "Guardians" };
  document.getElementById("page-title").textContent = titles[viewName];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showConnectionError(message) {
  document.getElementById("app-shell").hidden = true;
  connectionErrorMessage.textContent = message;
  connectionError.hidden = false;
}

async function refreshRepositoryRequests() {
  if (!activeRepository) return;
  const [membershipData, viewData] = await Promise.all([
    api(`/api/repositories/${activeRepository.id}/membership-requests`),
    api(`/api/repositories/${activeRepository.id}/view-requests`),
  ]);
  requests = membershipData.requests;
  viewRequests = viewData.requests;
  renderRequests();
}

async function loadRepository(repository) {
  activeRepository = repository;
  const card = document.querySelector(".repository-card");
  const empty = document.getElementById("empty-repository");
  const copyButton = document.getElementById("repository-id-copy");
  const leaveButton = document.getElementById("leave-repository");
  const uploadButtons = document.querySelectorAll(".upload-open");
  const selector = document.getElementById("repository-select");
  selector.value = repository?.id ?? "";
  card.hidden = !repository;
  empty.hidden = Boolean(repository);
  copyButton.hidden = !repository;
  leaveButton.hidden = !liveMode || !repository;
  uploadButtons.forEach((button) => { button.hidden = !repository; });

  if (!repository) {
    recordings = [];
    guardians = [];
    requests = [];
    viewRequests = [];
    document.getElementById("repository-name").textContent = "No repository selected";
    document.getElementById("recordings-repository-name").textContent = "selected repository";
    document.getElementById("repository-description").textContent = "";
    document.getElementById("governance-note").textContent = "Create a repository or request to join one using an ID shared by a subscriber.";
    renderRecordings();
    renderGuardians();
    return;
  }

  document.getElementById("repository-name").textContent = repository.name;
  document.getElementById("recordings-repository-name").textContent = repository.name;
  document.getElementById("repository-description").textContent = `Shared archive · ${shortSubject(repository.id)}`;
  document.getElementById("governance-note").textContent =
    "Unanimous approvals are enforced by this application’s SQLite backend, not by an ORK-enforced cryptographic policy. S3 server-side encryption is enabled; video is not end-to-end encrypted.";

  const [recordingData, memberData] = await Promise.all([
    api(`/api/repositories/${repository.id}/recordings`),
    api(`/api/repositories/${repository.id}/members`),
  ]);
  recordings = recordingData.recordings.map((recording) => ({
    id: recording.id,
    title: recording.filename,
    when: formatDate(recording.completed_at),
    source: `Uploaded by ${shortSubject(recording.uploader_subject_id)}`,
    duration: "",
    tone: "tone-upload",
  }));
  guardians = memberData.members;
  await refreshRepositoryRequests();
  renderRecordings();
  renderGuardians();
}

async function initializeLiveWorkspace() {
  const iam = window.__tideIAM;
  if (!iam?.isAuthenticated()) return;
  liveMode = true;
  previewBanner.hidden = true;
  formSection.style.display = "block";
  document.getElementById("upload-note").textContent =
    "Video is uploaded directly to the configured private S3 bucket with server-side encryption. The video is not end-to-end encrypted.";
  document.getElementById("request-note").textContent =
    "The authenticated Tide account is the applicant; all current subscribers must approve in the app.";
  document.querySelector(".secure-indicator").lastChild.textContent = " Connected archive";

  const [account, repositoryData] = await Promise.all([
    api("/api/me"),
    api("/api/repositories"),
  ]);
  currentSubject = account.subject;
  repositories = repositoryData.repositories;
  const selector = document.getElementById("repository-select");
  selector.replaceChildren(...repositories.map((repository) => {
    const option = document.createElement("option");
    option.value = repository.id;
    option.textContent = repository.name;
    return option;
  }));
  document.getElementById("family-switcher").hidden = repositories.length === 0;
  await loadRepository(repositories[0] ?? null);
}

async function initializeAccess() {
  try {
    const response = await fetch("/tidecloak.json");
    if (response.status === 404) {
      formSection.style.display = "block";
      previewBanner.hidden = false;
      return;
    }
    if (!response.ok) {
      throw new Error(`The TideCloak configuration check returned HTTP ${response.status}.`);
    }

    await import("/auth.js");
    if (window.__tideIAM?.isAuthenticated()) {
      await initializeLiveWorkspace();
    } else {
      previewBanner.hidden = false;
      previewBanner.querySelector("span:last-child").textContent =
        "Sign in to load your authenticated repositories. Sample content is hidden while TideCloak is configured.";
    }
  } catch (error) {
    showConnectionError(
      `TideCloak setup could not be verified. ${error instanceof Error ? error.message : "Unknown connection error."}`,
    );
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.go));
});

document.querySelectorAll(".upload-open").forEach((button) => {
  button.addEventListener("click", () => {
    uploadMessage.textContent = "";
    uploadDialog.showModal();
  });
});

document.getElementById("request-open").addEventListener("click", () => {
  requestMessage.textContent = "";
  requestDialog.showModal();
});

document.getElementById("repository-select").addEventListener("change", async (event) => {
  const selected = repositories.find((repository) => repository.id === event.target.value);
  try {
    await loadRepository(selected ?? null);
  } catch (error) {
    showConnectionError(error instanceof Error ? error.message : "Could not load this repository.");
  }
});

document.getElementById("repository-id-copy").addEventListener("click", async (event) => {
  if (!activeRepository) return;
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(activeRepository.id);
    button.textContent = "Repository ID copied";
    window.setTimeout(() => { button.textContent = "Copy repository ID"; }, 1800);
  } catch {
    showAppMessage(`Copy and share this repository ID: ${activeRepository.id}`);
  }
});

document.getElementById("create-repository").addEventListener("click", () => {
  document.getElementById("create-repository-message").textContent = "";
  createRepositoryDialog.showModal();
});

document.getElementById("leave-repository").addEventListener("click", async () => {
  if (!activeRepository || !window.confirm(`Leave ${activeRepository.name}? Pending requests that require your approval will be canceled.`)) return;
  const repositoryId = activeRepository.id;
  try {
    await api(`/api/repositories/${repositoryId}/members/me`, { method: "DELETE" });
    const result = await api("/api/repositories");
    repositories = result.repositories;
    const selector = document.getElementById("repository-select");
    selector.replaceChildren(...repositories.map((repository) => {
      const option = document.createElement("option");
      option.value = repository.id;
      option.textContent = repository.name;
      return option;
    }));
    await loadRepository(repositories[0] ?? null);
    showAppMessage("You left the repository. Pending requests requiring your approval were canceled.");
    setView("guardians");
  } catch (error) {
    showAppMessage(error instanceof Error ? error.message : "Could not leave the repository.");
  }
});

document.getElementById("create-repository-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const nameInput = document.getElementById("new-repository-name");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/repositories", { method: "POST", body: { name: nameInput.value.trim() } });
    const result = await api("/api/repositories");
    repositories = result.repositories;
    const selector = document.getElementById("repository-select");
    selector.replaceChildren(...repositories.map((repository) => {
      const option = document.createElement("option");
      option.value = repository.id;
      option.textContent = repository.name;
      return option;
    }));
    document.getElementById("family-switcher").hidden = false;
    createRepositoryDialog.close();
    await loadRepository(repositories.at(-1));
  } catch (error) {
    setMessage(
      document.getElementById("create-repository-message"),
      error instanceof Error ? error.message : "Could not create the repository.",
    );
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.close).close();
  });
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  uploadMessage.textContent = "";
  if (!file) {
    filePrompt.textContent = "Choose a video file";
    fileHint.textContent = "MP4, MOV, WebM and other video formats";
    return;
  }
  if (!file.type.startsWith("video/")) {
    uploadMessage.textContent = "Please choose a video file.";
    fileInput.value = "";
    return;
  }

  filePrompt.textContent = file.name;
  fileHint.textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to add`;
});

document.getElementById("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || !file.type.startsWith("video/")) {
    uploadMessage.textContent = "Choose a valid video file before adding it.";
    return;
  }

  if (!liveMode) {
    recordings.unshift({
      title: file.name,
      when: "Just now",
      source: "This device · Preview only",
      duration: "NEW",
      tone: "tone-upload",
      url: URL.createObjectURL(file),
    });
    renderRecordings();
    uploadDialog.close();
    document.getElementById("upload-form").reset();
    filePrompt.textContent = "Choose a video file";
    fileHint.textContent = "MP4, MOV, WebM and other video formats";
    return;
  }

  if (!activeRepository) {
    uploadMessage.textContent = "Create a repository or select one before uploading.";
    return;
  }

  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  let recordingId = null;
  try {
    setMessage(uploadMessage, "Preparing secure multipart upload…");
    const upload = await api(`/api/repositories/${activeRepository.id}/recordings/uploads`, {
      method: "POST",
      body: { filename: file.name, contentType: file.type, sizeBytes: file.size },
    });
    recordingId = upload.recordingId;
    const parts = [];
    const parallelParts = 3;

    for (let start = 1; start <= upload.partCount; start += parallelParts) {
      const partNumbers = Array.from(
        { length: Math.min(parallelParts, upload.partCount - start + 1) },
        (_, index) => start + index,
      );
      const signed = await api(`/api/recordings/${recordingId}/upload-parts`, {
        method: "POST",
        body: { partNumbers },
      });
      const uploaded = await Promise.all(signed.parts.map(async ({ partNumber, url }) => {
        const offset = (partNumber - 1) * upload.partSizeBytes;
        const response = await fetch(url, {
          method: "PUT",
          body: file.slice(offset, Math.min(offset + upload.partSizeBytes, file.size)),
        });
        if (!response.ok) throw new Error(`S3 rejected video part ${partNumber} with HTTP ${response.status}.`);
        const etag = response.headers.get("ETag");
        if (!etag) throw new Error("S3 did not expose the part ETag. Configure bucket CORS to expose ETag.");
        return { PartNumber: partNumber, ETag: etag };
      }));
      parts.push(...uploaded);
      setMessage(uploadMessage, `Uploading video · ${Math.min(start + parallelParts - 1, upload.partCount)} of ${upload.partCount} parts`);
    }

    parts.sort((left, right) => left.PartNumber - right.PartNumber);
    await api(`/api/recordings/${recordingId}/complete`, { method: "POST", body: { parts } });
    await loadRepository(activeRepository);
    uploadDialog.close();
    document.getElementById("upload-form").reset();
    filePrompt.textContent = "Choose a video file";
    fileHint.textContent = "MP4, MOV, WebM and other video formats";
  } catch (error) {
    let message = error instanceof Error ? error.message : "Upload failed.";
    if (recordingId) {
      try {
        await api(`/api/recordings/${recordingId}/upload`, { method: "DELETE" });
      } catch (cancelError) {
        message += ` Upload cleanup also failed: ${cancelError instanceof Error ? cancelError.message : "unknown error"}`;
      }
    }
    setMessage(uploadMessage, message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const repositoryId = document.getElementById("repository-id").value.trim();
  if (liveMode) {
    try {
      const result = await api(`/api/repositories/${repositoryId}/membership-requests`, { method: "POST", body: {} });
      setMessage(requestMessage, `Request submitted (${result.requestId}). It is pending approval from every active subscriber.`);
    } catch (error) {
      setMessage(requestMessage, error instanceof Error ? error.message : "Could not submit membership request.");
    }
    return;
  }

  const exists = requests.some((request) => request.email === repositoryId);
  if (exists) {
    requestMessage.textContent = "A preview request for this repository already exists.";
    return;
  }
  requests.unshift({ email: repositoryId, approvals: guardians.map(() => false) });
  document.getElementById("request-form").reset();
  requestDialog.close();
  renderRequests();
  setView("guardians");
});

videoDialog.addEventListener("close", () => {
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
});

renderRecordings();
renderGuardians();
initializeAccess();
