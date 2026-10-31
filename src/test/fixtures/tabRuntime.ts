import { useProfileStore } from "src/stores/profile";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore, type TabTarget } from "src/stores/screen";

/**
 * A connection tab with its own runtime connection, opened on the tab's
 * target, as the execution guard (plan tab-database-reconnect D3) expects.
 */
export function seedTabRuntime(
  opts: {
    tabId?: string;
    runtimeId?: string;
    profileId?: string;
    engine?: string;
    target?: TabTarget;
  } = {}
) {
  const tabId = opts.tabId ?? "tab-1";
  const runtimeId = opts.runtimeId ?? "conn-1";
  // A tab the test already set up keeps its other fields.
  const existing = useScreenStore
    .getState()
    .profileTabs.find((t) => t.id === tabId);
  const profileId = opts.profileId ?? existing?.profileId ?? "p1";
  const engine = opts.engine ?? existing?.engine ?? "postgres";
  const target: TabTarget = opts.target ??
    (existing?.target as TabTarget | undefined) ?? { kind: "default" };
  const override = target.kind === "override" ? target.database : null;
  const tab = {
    label: tabId,
    ...existing,
    id: tabId,
    profileId,
    engine,
    target,
    runtimeConnectionId: runtimeId,
  };
  useScreenStore.setState((s) => ({
    profileTabs: existing
      ? (s.profileTabs.map((t) => (t.id === tabId ? tab : t)) as never)
      : ([...s.profileTabs, tab] as never),
  }));
  if (!useProfileStore.getState().getProfileById(profileId)) {
    useProfileStore.setState((s) => ({
      profiles: [
        ...s.profiles,
        {
          id: profileId,
          label: profileId,
          engine,
          input: { engine, [engine]: { database: "app" } },
        },
      ] as never,
    }));
  }
  useRuntimeTargetsStore.getState().register(
    runtimeId,
    {
      profile_id: profileId,
      profile_revision: "r1",
      database_override: override,
      engine: engine as never,
      display: override ?? "app",
    },
    tabId
  );
  return { tabId, runtimeId, profileId };
}

export function resetTabRuntimes() {
  useRuntimeTargetsStore.setState({ targets: {}, owners: {}, refused: {} });
  useScreenStore.setState({ profileTabs: [], tabEpoch: {} } as never);
}
