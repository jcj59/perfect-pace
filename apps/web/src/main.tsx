import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { captureErrors } from "./report/errors.ts";
import "./styles.css";

// First, so errors while the app starts are kept for "Report a problem" too.
captureErrors();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
