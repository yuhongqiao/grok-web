import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "highlight.js/styles/github-dark.css";
import "./app.css";

const CodexApp = lazy(() => import("./codex/CodexApp.jsx"));
const codex = /^\/codex(?:\/|$)/.test(window.location.pathname);
if (!codex) document.title = "grok web";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Suspense fallback={<div className="loading">正在打开工作台…</div>}>
      {codex ? <CodexApp /> : <App />}
    </Suspense>
  </StrictMode>,
);
