import { useEffect, useRef } from "preact/hooks";
import { MainLayout } from "./layout";
import { runRuntimeUpdaterCheck } from "src/lib/updater/runtimeUpdater";

export default function App() {
  const updaterCheckedRef = useRef(false);

  useEffect(() => {
    if (updaterCheckedRef.current) return;
    updaterCheckedRef.current = true;

    void (async () => {
      try {
        await runRuntimeUpdaterCheck();
      } catch (err) {
        // Best-effort updater check; do not block app startup on failures.
        console.warn("Runtime updater check failed:", err);
      }
    })();
  }, []);

  return <MainLayout />;
}
