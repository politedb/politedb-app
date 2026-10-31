import { v4 as uuid } from "uuid";
import type { ProfileSaveAndConnectResult } from "src/lib/tauri/types";
import { seedSqliteTemplateDemo } from "src/lib/sqliteTemplateSeed";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { type ProfileTab, useScreenStore } from "src/stores/screen";

/**
 * The tab of a just-created SQLite template connection, seeded with the
 * demo tables. The tab owns its connection before anything runs on it, so
 * the seed goes through the same tab guard as any other work (plan
 * tab-database-reconnect R4, D3). A failed seed leaves an empty database.
 */
export async function openSqliteTemplateTab(
  saved: ProfileSaveAndConnectResult
): Promise<ProfileTab> {
  const tab: ProfileTab = {
    id: `tab-${uuid()}`,
    label: saved.profile.label || "Hello World",
    profileId: saved.profile.id,
    engine: saved.profile.engine,
    runtimeConnectionId: saved.connection.id,
    target: { kind: "default" },
    profileTags: saved.profile.input?.tags ?? [],
  };
  // This tab acquired the connection and alone may remove it (R4).
  useRuntimeTargetsStore
    .getState()
    .register(saved.connection.id, saved.connection.target, tab.id);
  useScreenStore.getState().addTab(tab);

  try {
    await seedSqliteTemplateDemo(saved.connection.id);
  } catch (seedErr) {
    console.warn("[sqlite template] demo seed failed:", seedErr);
  }
  return tab;
}
