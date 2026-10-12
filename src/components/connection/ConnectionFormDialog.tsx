import { useMemo, useRef, useState } from "preact/hooks";
import { useForm } from "react-hook-form";
import { v4 as uuid } from "uuid";

import {
  ConnectionProfile,
  connectionTest,
  profileConnectTest,
  profileSave,
  profileSaveAndConnect,
  SaveAndConnectAction,
  SaveAndConnectInput,
} from "src/lib/tauri";

import { XIcon } from "src/components/icons";
import { ProfileTab, useScreenStore } from "src/stores/screen";
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
import { errorCode, trackEvent } from "src/lib/analytics";
import {
  describeFileAccessError,
  failedBeforePersistence,
  fileAccessRequests,
  isFileAccessCancelled,
  withFileAccessRecovery,
} from "src/lib/file-access";
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
  // Id for a new profile, fixed per dialog. Save-and-connect saves before it connects;
  // if the connect step then fails, later attempts update this profile instead of
  // creating a duplicate.
  const newProfileId = useRef(uuid()).current;
  const [savedNewProfileId, setSavedNewProfileId] = useState<string>();

  const {
    status,
    setStatus,
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

      // Sandboxed builds: ask for file access first, retry once if a grant went stale.
      await withFileAccessRecovery(async () => {
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
      }, fileAccessRequests(input));

      setSuccess("Test OK");
      trackEvent("connection_test_success", {
        engine: input.engine,
        has_profile: Boolean(profileId),
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      if (isFileAccessCancelled(e)) {
        setStatus({ kind: "idle" });
        return;
      }
      const msg = e?.message ? String(e.message) : String(e);
      setError(describeFileAccessError(e) ?? msg);
      trackEvent("connection_test_error", {
        engine: v.engine,
        has_profile: Boolean(profileId),
        duration_ms: Date.now() - startedAt,
        error: errorCode(msg),
      });
    }
  });

  const onSave = handleSubmit(async (v) => {
    const startedAt = Date.now();
    // Save profile only (no connect)
    setConnecting(); // reuse spinner state; or create setSaving() if you want distinct
    try {
      const connectionInput = buildConnectionInput(v);

      // One identity per dialog: update a profile this dialog already saved.
      const targetId = profileId ?? savedNewProfileId;
      const action = targetId
        ? ({ mode: "update", profileId: targetId } as const)
        : ({ mode: "create", profileId: newProfileId } as const);

      const savedProfile = await profileSave({
        ...action,

        // FE-only
        storeKeychain: v.storeKeychain,
        password: v.password,
        ssh_password: v.sshPassword, // FE-only: used for keychain persist when SSH auth=password

        ...connectionInput,
      } as SaveAndConnectInput & SaveAndConnectAction);

      if (!profileId) setSavedNewProfileId(savedProfile.id);
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
        error: errorCode(msg),
      });
    }
  });

  const onConnect = handleSubmit(async (v) => {
    const startedAt = Date.now();
    setConnecting();
    try {
      const connectionInput = buildConnectionInput(v);

      const targetId = profileId ?? savedNewProfileId;
      const action = targetId
        ? ({ mode: "update", profileId: targetId } as const)
        : ({ mode: "create", profileId: newProfileId } as const);

      // Sandboxed builds: file access is settled before anything is saved. The backend
      // re-checks before persisting, so a retry is safe only for that early refusal.
      const res = await withFileAccessRecovery(
        () =>
          profileSaveAndConnect({
            ...action,

            // FE-only
            storeKeychain: v.storeKeychain,
            password: v.password,
            ssh_password: v.sshPassword, // FE-only if SSH auth=password

            ...connectionInput,
          } as SaveAndConnectInput & SaveAndConnectAction),
        fileAccessRequests(connectionInput),
        { retryIf: failedBeforePersistence }
      );

      setSuccess(`Connected ✅ ${res.profile.label}`);

      const tabPatch: Partial<ProfileTab> = {
        label:
          res.profile.label || connectionInput.label || "Unnamed Connection",
        engine: connectionInput.engine,
        runtimeConnectionId: res.connection.id,
        profileId: res.profile.id,
      };

      let connectedTab: ProfileTab;

      if (reuseTabId) {
        updateTab(reuseTabId, tabPatch);
        setActiveProfileScreen(reuseTabId);
        connectedTab =
          useScreenStore
            .getState()
            .profileTabs.find((t) => t.id === reuseTabId) ??
          ({ id: reuseTabId, ...tabPatch } as ProfileTab);
      } else {
        connectedTab = {
          id: `tab-${uuid()}`,
          ...tabPatch,
          profileTags: res.profile.input?.tags ?? [],
        } as ProfileTab;

        addTab(connectedTab);
        setActiveProfileScreen(connectedTab.id);
      }

      void import("src/stores/connectionLog").then(
        ({ recordConnectionSessionOpened }) =>
          recordConnectionSessionOpened(connectedTab)
      );

      onSaved?.(res.profile);
      onClose?.();
      trackEvent("connection_connect_success", {
        engine: connectionInput.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      if (isFileAccessCancelled(e)) {
        setStatus({ kind: "idle" });
        return;
      }
      const msg = e?.message ? String(e.message) : String(e);
      // The backend saved the new profile before this connect failure.
      if (!profileId && /^\s*RUNTIME_CONNECT_FAILED/.test(msg)) {
        setSavedNewProfileId(newProfileId);
      }
      setError(describeFileAccessError(e) ?? msg);
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
        error: errorCode(msg),
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
          <div class="space-y-3">
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
