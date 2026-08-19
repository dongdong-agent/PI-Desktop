import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorHooks } from "./app/errorHooks";

// 全局错误转发（WebView console → Rust 日志）
installGlobalErrorHooks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);