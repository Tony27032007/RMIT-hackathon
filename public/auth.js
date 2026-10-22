// Tide auth initialization using IAMService.
//
// IAMService is the shipped singleton and supports DPoP. DPoP is OPT-IN on the client: without
// `useDPoP` in the config the SDK issues plain bearer tokens and says nothing, and a realm that
// requires bound tokens (the pack's template does) then fails login with "DPoP proof is missing".
// There is no enableDpop flag. See canon/framework-matrix.md.

import { IAMService } from "@tidecloak/js";

// IAMService is a pre-instantiated singleton — use it directly.
// Do NOT call IAMService.getInstance() — it does not exist. (AP-51)
const iam = IAMService;

// Initialize from adapter JSON — pass the FULL config object, not {url, realm, clientId}. (AP-52)
const configRes = await fetch("/tidecloak.json");
if (!configRes.ok) {
  throw new Error(`The TideCloak adapter request returned HTTP ${configRes.status}.`);
}
const config = await configRes.json();
const redirectUri = new URL("/auth/redirect", window.location.origin).href;
const silentCheckSsoRedirectUri = new URL("/silent-check-sso.html", window.location.origin).href;

const initConfig = {
  ...config,
  redirectUri,
  silentCheckSsoRedirectUri,
  useDPoP: { mode: "strict", alg: "ES256" },
};

// UI bindings
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userInfo = document.getElementById("user-info");
const formSection = document.getElementById("form-section");

function updateUI() {
  const authenticated = iam.isLoggedIn();
  loginBtn.style.display = authenticated ? "none" : "inline";
  logoutBtn.style.display = authenticated ? "inline" : "none";
  formSection.style.display = authenticated ? "block" : "none";

  if (authenticated) {
    // IAMService has no getUserInfo(); read identity from the ID token's claims.
    const username = iam.getValueFromIDToken("preferred_username");
    userInfo.textContent = `Logged in as: ${username || "unknown"}`;
  } else {
    userInfo.textContent = "";
  }
  window.dispatchEvent(new CustomEvent("tide-auth-updated", { detail: { authenticated } }));
}

function reportAuthError(eventName, error) {
  const message = error instanceof Error ? error.message : String(error || "Unknown authentication error.");
  console.error(`[Hearth] Tide ${eventName}:`, error);
  window.dispatchEvent(new CustomEvent("tide-auth-error", {
    detail: { eventName, message },
  }));
}

function startLogin() {
  return iam.doLogin();
}

loginBtn.addEventListener("click", () => {
  Promise.resolve()
    .then(startLogin)
    .catch((error) => reportAuthError("login", error));
});

logoutBtn.addEventListener("click", () => {
  iam.doLogout();  // takes no arguments
});

// Listen to auth events
iam.on("initError", (_event, error) => reportAuthError("initialization", error));
iam.on("authError", (_event, error) => reportAuthError("authentication", error));
iam.on("authSuccess", updateUI);
iam.on("logout", updateUI);
iam.on("authRefreshSuccess", updateUI);
iam.on("authRefreshError", (_event, error) => {
  reportAuthError("token refresh", error);
  Promise.resolve()
    .then(startLogin)
    .catch((loginError) => reportAuthError("login", loginError));
});
iam.on("tokenExpired", () => {
  iam.updateIAMToken()
    .then(updateUI)
    .catch((error) => {
      reportAuthError("expired token", error);
      return startLogin();
    });
});

await iam.initIAM(initConfig);

// Initial state
updateUI();

// Export for use by form.js
window.__tideIAM = iam;
window.dispatchEvent(new CustomEvent("tide-auth-ready", {
  detail: { authenticated: iam.isLoggedIn() },
}));
