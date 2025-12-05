import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Overlay from "./Overlay";
import "./index.css";

// Determine which component to render based on window label
async function init() {
  const currentWindow = getCurrentWindow();
  const label = currentWindow.label;

  // Enable dark mode globally
  document.documentElement.classList.add("dark");

  const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement
  );

  if (label === "overlay") {
    // Overlay window - transparent, minimal UI
    // Set inline styles directly (highest CSS priority)
    document.documentElement.style.cssText = "background: transparent !important; background-color: transparent !important;";
    document.body.style.cssText = "background: transparent !important; background-color: transparent !important; margin: 0; padding: 0; overflow: hidden;";
    const rootEl = document.getElementById("root");
    if (rootEl) {
      rootEl.style.cssText = "background: transparent !important; background-color: transparent !important;";
    }
    root.render(
      <React.StrictMode>
        <Overlay />
      </React.StrictMode>
    );
  } else {
    // Main window - full settings UI
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
}

init();

