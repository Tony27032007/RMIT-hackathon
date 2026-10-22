import { IAMService } from "@tidecloak/js";

const iam = IAMService;
const status = document.getElementById("auth-status");
const loginButton = document.getElementById("login-btn");
const logoutButton = document.getElementById("logout-btn");
const userInfo = document.getElementById("user-info");
let available = false;
let initialized = false;

function setStatus(message, state = "ready") {
  status.textContent = message;
  status.dataset.state = state;
}

function notifyChange() {
  window.dispatchEvent(new CustomEvent("homelock-auth-changed"));
}

function updateAuthUi() {
  const authenticated = available && iam.isLoggedIn();
  loginButton.hidden = authenticated || !available;
  logoutButton.hidden = !authenticated;
  const username = authenticated && iam.getValueFromIdToken("preferred_username");
  userInfo.textContent = username ? `Signed in as ${username}` : authenticated ? "Signed in" : "";
  if (authenticated) setStatus("Signed in with TideCloak.");
  notifyChange();
}

export async function initializeTide() {
  if (initialized) return;
  initialized = true;
  let initializationError = null;
  let authenticationError = null;

  try {
    const apiConfigResponse = await fetch("/api/config", { cache: "no-store" });
    const apiConfig = await apiConfigResponse.json();
    if (!apiConfigResponse.ok || !apiConfig.authConfigured) {
      setStatus(apiConfig.authIssue || "Server-side TideCloak verification is not configured.", "error");
      loginButton.hidden = true;
      return;
    }

    const response = await fetch("/tidecloak.json", { cache: "no-store" });
    if (!response.ok) {
      setStatus("The public TideCloak adapter could not be loaded.", "error");
      loginButton.hidden = true;
      return;
    }

    const config = await response.json();
    iam.on("initError", (_event, error) => {
      initializationError = true;
      available = false;
      setStatus(`TideCloak initialization failed: ${error?.message || "check the adapter and callback configuration."}`, "error");
      updateAuthUi();
    });
    iam.on("authError", () => {
      authenticationError = true;
      setStatus("TideCloak could not complete authentication. Please try again.", "error");
    });
    iam.on("tokenExpired", () => {
      setStatus("Your TideCloak session expired. Sign in again to continue.", "error");
      updateAuthUi();
    });
    const initAuthenticated = await iam.initIAM({
      ...config,
      redirectUri: `${window.location.origin}/auth/redirect`,
      silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
      useDPoP: { mode: "strict", alg: "ES256" },
    });
    if (initializationError) {
      loginButton.hidden = true;
      return;
    }
    available = true;
    iam.on("authRefreshSuccess", updateAuthUi);
    iam.on("authRefreshError", () => {
      setStatus("Your TideCloak session expired. Sign in again to continue.", "error");
      updateAuthUi();
    });
    iam.on("authSuccess", updateAuthUi);
    iam.on("logout", updateAuthUi);
    updateAuthUi();
    if (!initAuthenticated && !iam.isLoggedIn() && !authenticationError) {
      setStatus("Sign in with TideCloak to continue.");
    }
  } catch (error) {
    setStatus(`TideCloak initialization failed: ${error.message}`, "error");
    loginButton.hidden = true;
  }
}

export function isAuthenticated() {
  return available && iam.isLoggedIn();
}

export async function secureApiFetch(path, options = {}) {
  if (!isAuthenticated()) throw new Error("Sign in with TideCloak before continuing.");
  if (typeof iam.secureFetch !== "function") {
    throw new Error("This TideCloak SDK does not expose secureFetch; protected API calls are disabled.");
  }
  return iam.secureFetch(new URL(path, window.location.origin).href, options);
}

loginButton.addEventListener("click", async () => {
  if (!available) return;
  loginButton.disabled = true;
  setStatus("Opening TideCloak sign-in…");
  try {
    await iam.doLogin("/");
  } catch (error) {
    setStatus(`Could not start TideCloak sign-in: ${error.message}`, "error");
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  if (!available) return;
  logoutButton.disabled = true;
  try {
    await iam.doLogout();
  } catch (error) {
    setStatus(`Could not sign out of TideCloak: ${error.message}`, "error");
    logoutButton.disabled = false;
  }
});

void initializeTide();
