import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./app/App.tsx";
import { logCaughtError } from "./scene/failure.ts";
import { installSceneLogCapture } from "./scene/sceneLog.ts";

// Keeps the last 20 [scene] console lines for "Copy error details" (DR14).
installSceneLogCapture();

createRoot(document.getElementById("root")!, { onCaughtError: logCaughtError }).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
