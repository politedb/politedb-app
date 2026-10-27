import { v4 as uuid } from "uuid";
import type { ConnectionProfile } from "src/lib/tauri";
import { type ProfileTab, useScreenStore } from "src/stores/screen";

/** Opens a saved connection in a new connection tab and switches to it. */
export function openProfileTab(profile: ConnectionProfile): ProfileTab {
  const tab: ProfileTab = {
    id: `tab-${uuid()}`,
    label: profile.label || "Unnamed Connection",
    profileId: profile.id,
    engine: profile.engine,
    runtimeConnectionId: undefined,
    profileTags: profile.input?.tags ?? [],
  };
  const { addTab, setActiveProfileScreen } = useScreenStore.getState();
  addTab(tab);
  setActiveProfileScreen(tab.id);
  return tab;
}
