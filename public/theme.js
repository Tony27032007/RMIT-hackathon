const toggle = document.getElementById("theme-toggle");
const label = document.getElementById("theme-toggle-label");
const themeColor = document.querySelector('meta[name="theme-color"]');

function applyTheme(theme, persist = true) {
  const dark = theme === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  toggle.setAttribute("aria-pressed", String(dark));
  const action = dark ? "Switch to light mode" : "Switch to dark mode";
  toggle.setAttribute("aria-label", action);
  toggle.title = action;
  label.textContent = dark ? "Light mode" : "Dark mode";
  themeColor.content = dark ? "#111510" : "#f4f3ef";

  if (persist) {
    try {
      localStorage.setItem("homelock-theme", dark ? "dark" : "light");
    } catch (error) {
      console.warn("[homelock] Could not save the theme preference.", error);
    }
  }
}

applyTheme(document.documentElement.dataset.theme || "light", false);

toggle.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
