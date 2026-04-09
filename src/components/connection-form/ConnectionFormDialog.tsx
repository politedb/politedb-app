import { useMemo } from "preact/hooks";
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
import { trackEvent } from "src/lib/analytics";

export function ConnectionFormDialog({
  onClose,
  onSaved,
  initialData,
  engine,
}: {
  onSaved?: (v?: ConnectionProfile) => void;
  onClose?: () => void;
  initialData?: ConnectionProfile;
  engine: DatabaseEngine;
}) {
  const { addTab, setActiveProfileScreen } = useScreenStore();

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
  const requiredOk = useMemo(() => {
    const host = v.host?.trim();
    const user = v.user?.trim();
    const database = v.database?.trim();
    const port = v.port;

    const hostOk = !!host && Number.isFinite(Number(port));

    if (v.engine === "sqlite") {
      return !!database;
    }

    if (v.engine === "redis" || v.engine === "mongo") {
      // Redis: only host + port are required; user/password/db are optional
      return hostOk;
    }

    return hostOk && !!user && !!database;
  }, [v]);

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
    setConnecting();
    try {
      const connectionInput = buildConnectionInput(v);

      const action = profileId
        ? ({ mode: "update", profileId } as const)
        : ({ mode: "create" } as const);

      const res = await profileSaveAndConnect({
        ...action,

        // FE-only
        storeKeychain: v.storeKeychain,
        password: v.password,
        ssh_password: v.sshPassword, // FE-only if SSH auth=password

        ...connectionInput,
      } as SaveAndConnectInput & SaveAndConnectAction);

      setSuccess(`Connected ✅ ${res.profile.label}`);

      const newTab: ProfileTab = {
        id: `tab-${uuid()}`,
        label:
          res.profile.label || connectionInput.label || "Unnamed Connection",
        engine: connectionInput.engine,
        runtimeConnectionId: res.connection.id,
        profileId: res.profile.id,
      };

      addTab(newTab);
      setActiveProfileScreen(newTab.id);
      onSaved?.();
      onClose?.();
      trackEvent("connection_connect_success", {
        engine: connectionInput.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
      });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      setError(msg);
      trackEvent("connection_connect_error", {
        engine: v.engine,
        mode: profileId ? "update" : "create",
        duration_ms: Date.now() - startedAt,
        error: msg.slice(0, 240),
      });
    }
  });

  return (
    <div class="mx-auto flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
      <div class="relative shrink-0 border-b border-slate-200 px-6 py-4">
        <div class="text-center">
          <div class="text-lg font-semibold text-slate-900">
            {SUPPORTED_DATABASES.find((d) => d.engine === engine)?.label}{" "}
            Connection
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

      <div class="min-h-0 flex-1 overflow-y-auto bg-slate-50">
        <div class="h-full overflow-y-auto p-6">
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
        </div>
      </div>

      <div class="shrink-0 border-t border-slate-200 bg-slate-50 px-6 py-4">
        <ConnectionFooter
          status={status}
          requiredOk={requiredOk}
          storeKeychain={v.storeKeychain}
          requiredHint={
            v.engine === "sqlite"
              ? "Required: Database file path."
              : "Required: Host, Port, Database, User."
          }
          onTest={onTest}
          onSave={onSave}
          onConnect={onConnect}
        />
      </div>
    </div>
  );
}
