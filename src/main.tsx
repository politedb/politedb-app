import { render } from "preact";
import App from "./App";
import "./styles.css";
import { initAnalytics, trackAppLifecycle } from "./lib/analytics";
import { operationBus } from "./lib/tauri/operationBus";
import { gcSqlDrafts } from "./lib/tauri/sql";
import { usePersistentStore } from "src/stores/persistentStore";
import {
  applyStoredThemePreference,
  installSystemThemeListener,
} from "src/lib/theme";
import { applyStoredUiFontPreference } from "src/lib/uiFont";
import { applyStoredUiDensityPreference } from "src/lib/density";
import { restoreLegacyWebStorage } from "src/lib/legacyWebStorage";
import { readLegacyWebStorage } from "src/lib/tauri/legacyWebStorage";
// Registers the tab execution guard (plan tab-database-reconnect D3) and
// the stale-connection handler before any command can reach a connection.
import "src/lib/runtimeConnection";

function isTauriRuntime() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

async function boot() {
  // Before anything reads localStorage: restore what the pre-1.5 store held. The
  // web build has no old store; it only records that there is nothing to do.
  const outcome = await restoreLegacyWebStorage({
    read: isTauriRuntime()
      ? readLegacyWebStorage
      : async () => ({ entries: [] }),
    storage: () => window.localStorage,
  });
  if (outcome === "restored") {
    // Some modules read localStorage when imported; restart from restored values.
    window.location.reload();
    return;
  }

  applyStoredThemePreference();
  applyStoredUiFontPreference();
  applyStoredUiDensityPreference();
  installSystemThemeListener();
  initAnalytics();

  document.documentElement.setAttribute("autocapitalize", "off");
  document.documentElement.setAttribute("autocorrect", "off");
  document.documentElement.setAttribute("spellcheck", "false");
  document.body?.setAttribute("autocapitalize", "off");
  document.body?.setAttribute("autocorrect", "off");
  document.body?.setAttribute("spellcheck", "false");

  if (isTauriRuntime()) {
    // Keep native context menu in dev for debugging; disable it in production.
    if (!import.meta.env.DEV) {
      window.addEventListener("contextmenu", (e) => {
        e.preventDefault();
      });
    }

    // ✅ init op bus early (prevents missing done/meta)
    await operationBus.ensureInit();
    await gcSqlDrafts({ ttlDays: 14, maxFiles: 200 });

    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      const p = platform();
      document.documentElement.dataset.platform = p;
    } catch {
      // ignore
    }

    // ✅ Restore persisted layout BEFORE first render
    const persistent = usePersistentStore.getState();
    await persistent.restore();

    // ✅ Start autosave AFTER restore (avoid overwriting with empty state)
    persistent.install();
  } else {
    document.documentElement.dataset.platform = "web";
  }

  trackAppLifecycle({
    runtime: isTauriRuntime() ? "tauri" : "web",
    mode: import.meta.env.DEV ? "dev" : "prod",
  });

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
