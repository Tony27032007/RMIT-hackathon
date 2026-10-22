const guardians = [
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

const requests = [];
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
  recent.replaceChildren(...recordings.slice(0, 3).map(recordingCard));
  all.replaceChildren(...recordings.map(recordingCard));

  const count = recordings.length;
  document.getElementById("recording-count").textContent = String(count).padStart(2, "0");
  document.getElementById("repository-recordings").textContent = String(count);
  document.getElementById("recordings-total").textContent = String(count);
}

function openRecording(recording) {
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  videoPlayer.hidden = !recording.url;
  videoCaption.textContent = recording.url
    ? `${recording.title} · ${recording.when} · ${recording.source}`
    : `${recording.title} · Sample archive entry — no video file is included in this prototype.`;

  if (recording.url) {
    videoPlayer.src = recording.url;
  }
  videoDialog.showModal();
}

function renderGuardians() {
  const list = document.getElementById("guardian-list");
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

document.getElementById("upload-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file || !file.type.startsWith("video/")) {
    uploadMessage.textContent = "Choose a valid video file before adding it.";
    return;
  }

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
});

document.getElementById("request-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const emailInput = document.getElementById("invite-email");
  const email = emailInput.value.trim().toLowerCase();
  const exists = requests.some((request) => request.email === email);
  if (exists) {
    requestMessage.textContent = "A preview request for this email already exists.";
    return;
  }

  requests.unshift({ email, approvals: guardians.map(() => false) });
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
