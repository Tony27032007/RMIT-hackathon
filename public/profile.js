import { isAuthenticated, secureApiFetch } from "./auth.js";

const profileButton = document.getElementById("profile-btn");
const profilePage = document.getElementById("profile-page");
const workspace = document.getElementById("workspace");
const profileBack = document.getElementById("profile-back");
const profileForm = document.getElementById("profile-form");
const displayNameInput = document.getElementById("profile-display-name");
const userIdInput = document.getElementById("profile-user-id");
const avatarInput = document.getElementById("avatar-input");
const avatarImage = document.getElementById("profile-avatar");
const avatarFallback = document.getElementById("avatar-fallback");
const removeAvatarButton = document.getElementById("remove-avatar");
const profileStatus = document.getElementById("profile-status");
const avatarStatus = document.getElementById("avatar-status");
let avatarUrl = null;

function setStatus(element, message, state = "ready") {
  element.textContent = message;
  element.dataset.state = state;
}

async function profileRequest(path, options = {}) {
  const response = await secureApiFetch(path, options);
  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : null;
    const error = new Error(data?.message || `The server returned ${response.status}.`);
    error.statusCode = response.status;
    throw error;
  }
  return response;
}

function setAvatar(blob) {
  if (avatarUrl) URL.revokeObjectURL(avatarUrl);
  avatarUrl = blob ? URL.createObjectURL(blob) : null;
  avatarImage.hidden = !avatarUrl;
  avatarFallback.hidden = Boolean(avatarUrl);
  avatarImage.src = avatarUrl || "";
  removeAvatarButton.hidden = !avatarUrl;
}

function updateAvatarFallback() {
  const firstCharacter = displayNameInput.value.trim().charAt(0);
  avatarFallback.textContent = firstCharacter ? firstCharacter.toUpperCase() : "H";
}

function showHome() {
  profilePage.hidden = true;
  workspace.hidden = false;
}

async function loadAvatar() {
  try {
    const response = await profileRequest("/api/profile/avatar");
    setAvatar(await response.blob());
    setStatus(avatarStatus, "");
  } catch (error) {
    if (error.statusCode === 404) {
      setAvatar(null);
      setStatus(avatarStatus, "");
      return;
    }
    setStatus(avatarStatus, error.message, "error");
  }
}

async function openProfile() {
  if (!isAuthenticated()) return;
  workspace.hidden = true;
  profilePage.hidden = false;
  profilePage.classList.remove("page-enter");
  requestAnimationFrame(() => profilePage.classList.add("page-enter"));
  setStatus(profileStatus, "Loading your profile…");
  setStatus(avatarStatus, "");

  try {
    const response = await profileRequest("/api/profile");
    const profile = await response.json();
    displayNameInput.value = profile.displayName;
    userIdInput.textContent = profile.userId;
    updateAvatarFallback();
    setStatus(profileStatus, "");
    await loadAvatar();
  } catch (error) {
    setStatus(profileStatus, error.message, "error");
  }
}

profileButton.addEventListener("click", () => void openProfile());
profileBack.addEventListener("click", showHome);
displayNameInput.addEventListener("input", updateAvatarFallback);

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = profileForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setStatus(profileStatus, "Saving your changes…");
  try {
    await profileRequest("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: displayNameInput.value,
      }),
    });
    setStatus(profileStatus, "Your profile is up to date.");
  } catch (error) {
    setStatus(profileStatus, error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

avatarInput.addEventListener("change", async () => {
  const image = avatarInput.files[0];
  if (!image) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(image.type)) {
    setStatus(avatarStatus, "Choose a JPEG, PNG, or WebP image.", "error");
    avatarInput.value = "";
    return;
  }
  if (image.size > 3 * 1024 * 1024) {
    setStatus(avatarStatus, "Choose an image smaller than 3 MB.", "error");
    avatarInput.value = "";
    return;
  }
  setStatus(avatarStatus, "Uploading your picture…");
  try {
    await profileRequest("/api/profile/avatar", {
      method: "PUT",
      headers: { "Content-Type": image.type },
      body: image,
    });
    setAvatar(image);
    setStatus(avatarStatus, "Profile picture updated.");
  } catch (error) {
    setStatus(avatarStatus, error.message, "error");
  } finally {
    avatarInput.value = "";
  }
});

removeAvatarButton.addEventListener("click", async () => {
  removeAvatarButton.disabled = true;
  setStatus(avatarStatus, "Removing your picture…");
  try {
    await profileRequest("/api/profile/avatar", { method: "DELETE" });
    setAvatar(null);
    setStatus(avatarStatus, "Profile picture removed.");
  } catch (error) {
    setStatus(avatarStatus, error.message, "error");
  } finally {
    removeAvatarButton.disabled = false;
  }
});

window.addEventListener("homelock-auth-changed", () => {
  if (!isAuthenticated()) {
    showHome();
    setAvatar(null);
    profileForm.reset();
  }
});
