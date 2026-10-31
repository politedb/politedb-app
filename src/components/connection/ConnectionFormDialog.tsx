import { useMemo } from "preact/hooks";
import { useForm } from "react-hook-form";
import { v4 as uuid } from "uuid";

import {
  ConnectionProfile,
  connectionTest,
  profileConnectTest,
  profileSave,
  SaveAndConnectAction,
  SaveAndConnectInput,
} from "src/lib/tauri";

import { XIcon } from "src/components/icons";
import { ProfileTab, TabTarget, useScreenStore } from "src/stores/screen";
import {
  connectTabOnce,
  PROFILE_TABS_HAVE_CHANGES,
  profileTabsWithChanges,
  tabLabelFor,
} from "src/lib/runtimeConnection";
import {
  overrideMirror,
  supportsDatabaseOverride,
} from "src/lib/tabs/tabTarget";
import { Button } from "src/components/common/Button";

import { ConnectionBasicsSection } from "./ConnectionBasicsSection";
import { IdentitySection } from "./IdentitySection";
import { SSHSection } from "./SshSection";
import { ConnectionFooter } from "./ConnectionFooter";

import {
  buildConnectionInput,
  makeDefaultValues,
  type FormValues,
} from "./connectionForm.utils";
import { useConnectionStatus } from "./useConnectionStatus";
import { DatabaseEngine } from "src/types";
import { SUPPORTED_DATABASES } from "src/constant";
import { trackEvent } from "src/lib/analytics";
import { cn } from "src/utils/cn";
import {
  getConnectionFormEngineConfig,
  hasRequiredConnectionFields,
} from "./engineFormConfig";
import { OverlayScrollArea } from "../common/OverlayScrollArea";

export function ConnectionFormDialog({
  onClose,
  onSaved,
  initialData,
  engine,
  /** When set, Connect updates this tab instead of opening a new one. */
  reuseTabId,
}: {
  onSaved?: (v?: ConnectionProfile) => void;
  onClose?: () => void;
  initialData?: ConnectionProfile;
  engine: DatabaseEngine;
  reuseTabId?: string;
}) {
  const { addTab, updateTab, setActiveProfileScreen } = useScreenStore();

  const profileId = initialData?.id ?? undefined;

  const {
    status,
    setIdleIfFinal,
    setTesting,
    setConnecting,
    setSuccess,
    setError,
  } = useConnectionStatus();

  const {
    handleSubmit,
    watch,
    formState: { errors },
    control,
  } = useForm<FormValues>({
    mode: "onSubmit",
    defaultValues: makeDefaultValues(initialData, engine),
  });

  function onDirty() {
    setIdleIfFinal();
  }

  const v = watch();
  const engineConfig = useMemo(
    () => getConnectionFormEngineConfig(v.engine),
    [v.engine]
  );
  const requiredOk = useMemo(() => hasRequiredConnectionFields(v), [v]);
  const engineLabel =
    SUPPORTED_DATABASES.find((database) => database.engine === engine)?.label ??
    engine;

  const onTest = handleSubmit(async (v) => {
    const startedAt = Date.now();
    setTesting();
    try {
      const input = buildConnectionInput(v);

      if (profileId) {
        // Profile exists: backend reads profile + resolves keychain
        await profileConnectTest(profileId, input, {
          dbPassword: v.password,
          sshPassword: v.sshPassword,
        });
      } else {
        // No profile yet: supply plaintext secrets (never stored)
        await connectionTest(input, {
          db_password: v.password,
          ssh_password: v.sshPassword,
        });
      }

      setSuccess("Test OK");
      trackEvent("connection_test_success", {
        engine: input.engine,
        has_profile: Boolean(profileId),
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      trackEvent("connection_test_error", {
        engine: v.engine,
        has_profile: Boolean(profileId),
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    }
  });

  const onSave = handleSubmit(async (v) => {
    const startedAt = Date.now();
    // Settings change under no tab's unsaved changes (R21).
    if (profileId && profileTabsWithChanges(profileId).length) {
      setError(PROFILE_TABS_HAVE_CHANGES);
      return;
    }
    // Save profile only (no connect)
    setConnecting(); // reuse spinner state; or create setSaving() if you want distinct
    try {
      const connectionInput = buildConnectionInput(v);

      const action = profileId
        ? ({ mode: "update", profileId } as const)
        : ({ mode: "create" } as const);

      const savedProfile = await profileSave({
        ...action,

        // FE-only
        storeKeychain: v.storeKeychain,
        password: v.password,
        ssh_password: v.sshPassword, // FE-only: used for keychain persist when SSH auth=password

        ...connectionInput,
      } as SaveAndConnectInput & SaveAndConnectAction);

      setSuccess(`Saved ✅ ${savedProfile.label}`);
      onSaved?.(savedProfile);
      trackEvent("connection_save_success", {
        engine: connectionInput.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      trackEvent("connection_save_error", {
        engine: v.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    }
  });

  const onConnect = handleSubmit(async (v) => {
    const startedAt = Date.now();
    // Settings change under no tab's unsaved changes (R21).
    if (profileId && profileTabsWithChanges(profileId).length) {
      setError(PROFILE_TABS_HAVE_CHANGES);
      return;
    }
    setConnecting();
    try {
      const connectionInput = buildConnectionInput(v);

      const action = profileId
        ? ({ mode: "update", profileId } as const)
        : ({ mode: "create" } as const);

      // Save first (its own step), then connect the tab on what it was
      // opened on (R6): never the profile's own database for a tab opened
      // on another one.
      const profile = await profileSave({
        ...action,

        // FE-only
        storeKeychain: v.storeKeychain,
        password: v.password,
        ssh_password: v.sshPassword, // FE-only if SSH auth=password

        ...connectionInput,
      } as SaveAndConnectInput & SaveAndConnectAction);

      const reused = reuseTabId
        ? useScreenStore.getState().profileTabs.find((t) => t.id === reuseTabId)
        : undefined;
      // A tab keeps the database it was opened on while the engine can still
      // open one; otherwise its target is unknown (R6).
      let target: TabTarget = reused?.target ?? { kind: "default" };
      if (
        target.kind === "override" &&
        !supportsDatabaseOverride(profile.engine)
      ) {
        target = { kind: "unknown" };
      }
      const tabPatch: Partial<ProfileTab> = {
        label: tabLabelFor(
          profile.label || connectionInput.label || "Unnamed Connection",
          target
        ),
        engine: connectionInput.engine,
        profileId: profile.id,
        target,
        databaseOverride: overrideMirror(target),
      };

      let connectedTab: ProfileTab;

      if (reused) {
        updateTab(reused.id, tabPatch);
        setActiveProfileScreen(reused.id);
        connectedTab =
          useScreenStore
            .getState()
            .profileTabs.find((t) => t.id === reused.id) ??
          ({ ...reused, ...tabPatch } as ProfileTab);
      } else {
        connectedTab = {
          id: `tab-${uuid()}`,
          ...tabPatch,
          profileTags: profile.input?.tags ?? [],
        } as ProfileTab;

        addTab(connectedTab);
        setActiveProfileScreen(connectedTab.id);
      }

      // The saved profile is published before connecting, so a failed
      // connect still leaves the new settings (and the stale connection
      // blocked by the backend).
      onSaved?.(profile);
      await connectTabOnce(connectedTab.id, { force: true });
      setSuccess(`Connected ✅ ${profile.label}`);

      void import("src/stores/connectionLog").then(
        ({ recordConnectionSessionOpened }) =>
          recordConnectionSessionOpened(connectedTab)
      );

      onClose?.();
      trackEvent("connection_connect_success", {
        engine: connectionInput.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      const failedTab: ProfileTab = {
        id: reuseTabId ?? `failed-${uuid()}`,
        profileId: profileId ?? initialData?.id ?? "",
        label: v.name?.trim() || initialData?.label || "Unnamed Connection",
        engine: v.engine,
      };
      void import("src/stores/connectionLog").then(
        ({ recordConnectionSessionFailed }) =>
          recordConnectionSessionFailed(failedTab, msg, initialData)
      );
      trackEvent("connection_connect_error", {
        engine: v.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    }
  });

  return (
    <div
      class={cn(
        "mx-auto flex max-h-[85vh] min-h-0 w-full max-w-5xl flex-col overflow-hidden",
        "rounded-2xl border border-neutral-200 bg-white shadow-2xl"
      )}
    >
      <div class="relative shrink-0 border-b border-slate-200 px-6 py-4">
        <div class="text-center">
          <div class="text-lg font-semibold text-slate-900">
            {engineLabel} Connection
          </div>
        </div>

        <Button
          onClick={onClose}
          variant="ghost"
          className="absolute top-3 right-3 rounded-full border-none p-2 hover:bg-neutral-100"
        >
          <XIcon className="size-4 text-slate-600" />
        </Button>
      </div>

      <OverlayScrollArea
        className="min-h-0 flex-1 bg-slate-50"
        contentClassName="p-6"
        dataScrollRoot
      >
        <div class="grid grid-cols-2 gap-6">
          <ConnectionBasicsSection
            control={control}
            errors={errors}
            onDirty={onDirty}
            isCreateNewConnection={!profileId}
          />
          <div class="flex flex-1 flex-col gap-3">
            <IdentitySection control={control} onDirty={onDirty} />
            <SSHSection control={control} onDirty={onDirty} />
          </div>
        </div>
      </OverlayScrollArea>

      <div class="shrink-0 border-t border-slate-200 bg-slate-50 px-6 py-4">
        <ConnectionFooter
          status={status}
          requiredOk={requiredOk}
          storeKeychain={v.storeKeychain}
          requiredHint={engineConfig.requiredHint}
          onTest={onTest}
          onSave={onSave}
          onConnect={onConnect}
        />
      </div>
    </div>
  );
}
