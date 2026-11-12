import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { markDesktop } from "./appearance.ts";
import { MiniApp } from "./Mini.tsx";
import "./styles.css";

const isMini = new URLSearchParams(window.location.search).get("mini") === "1";
markDesktop();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{isMini ? <MiniApp /> : <App />}</StrictMode>);
}
