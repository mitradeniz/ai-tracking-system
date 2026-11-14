import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktop } from "./api.ts";
import { App } from "./App.tsx";
import { markDesktop } from "./appearance.ts";
import { EyeApp } from "./Eye.tsx";
import { MiniApp } from "./Mini.tsx";
import "./styles.css";

const query = new URLSearchParams(window.location.search);
const isMini = query.get("mini") === "1";
const isEye = query.get("eye") === "1";
markDesktop();

// Animations stop while the window is hidden or in the background, so an idle window draws nothing.
// The desktop app reports its windows' focus itself; a browser tab uses focus and visibility.
let active: boolean | null = null;
const markInactive = () =>
  document.documentElement.toggleAttribute("data-inactive", document.hidden || (active === null ? !document.hasFocus() : !active));
desktop?.onActive?.((value) => {
  active = value;
  markInactive();
});
window.addEventListener("focus", markInactive);
window.addEventListener("blur", markInactive);
document.addEventListener("visibilitychange", markInactive);
markInactive();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{isEye ? <EyeApp /> : isMini ? <MiniApp /> : <App />}</StrictMode>);
}
