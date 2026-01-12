import "./monacoEnv";

import { render } from "preact";
import App from "./App";
import "./styles.css";
import { operationBus } from "./lib/tauri/operationBus";

function isTauriRuntime() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

async function boot() {
  if (isTauriRuntime()) {
    // ✅ init op bus early (prevents missing done/meta)
    await operationBus.ensureInit();

    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      const p = await platform(); // ✅ await
      document.documentElement.dataset.platform = p;
    } catch {
      // ignore
    }
  } else {
    document.documentElement.dataset.platform = "web";
  }

  window.addEventListener("unhandledrejection", (e) => {
    const r: any = e.reason;
    const msg = String(r?.message ?? r ?? "");
    if (msg.includes("Canceled") || msg.includes("Cancelled")) {
      e.preventDefault();
    }
  });

  render(<App />, document.getElementById("root")!);
}

void boot();
