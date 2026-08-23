// Shared theme handling: applies persisted theme ASAP and wires the toggle button.
function setTheme(mode) {
  const html = document.documentElement;
  if (mode === "light") {
    html.classList.add("light");
  } else {
    html.classList.remove("light");
  }
  localStorage.setItem("theme", mode);
}

const savedTheme = localStorage.getItem("theme");
if (savedTheme) setTheme(savedTheme);

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const isLight = document.documentElement.classList.contains("light");
    setTheme(isLight ? "dark" : "light");
  });
});
