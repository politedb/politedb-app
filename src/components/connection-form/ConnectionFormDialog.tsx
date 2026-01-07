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

import { X } from "../icons";
import { Tab, useScreenStore } from "src/stores/screen";
import { Button } from "../common/Button";

import { ConnectionBasicsSection } from "./ConnectionBasicsSection";
import { IdentitySection } from "./IdentitySection";
import { SecuritySection } from "./SecuritySection";
import { SSHSection } from "./SshSection";
import { ConnectionFooter } from "./ConnectionFooter";

import {
  buildConnectionInput,
  makeDefaultValues,
  type FormValues,
} from "./connectionForm.utils";
import { useConnectionStatus } from "./useConnectionStatus";

export function ConnectionFormDialog({
  onClose,
  onSaved,
  initialData,
}: {
  onSaved?: (v?: ConnectionProfile) => void;
  onClose?: () => void;
  initialData?: ConnectionProfile;
} = {}) {
  const { addTab, setActiveScreen } = useScreenStore();

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
    defaultValues: makeDefaultValues(initialData),
  });

  function onDirty() {
    setIdleIfFinal();
  }

  const requiredOk = useMemo(() => {
    const v = watch();
    const host = v.host?.trim();
    const user = v.user?.trim();
    const database = v.database?.trim();
    const port = v.port;
    return !!host && !!user && !!database && Number.isFinite(Number(port));
  }, [watch]);

  const onTest = handleSubmit(async (v) => {
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
    } catch (e: any) {
      console.log(e);
      setError(e?.message ? String(e.message) : String(e));
    }
  });

  const onSave = handleSubmit(async (v) => {
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
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    }
  });

  const onConnect = handleSubmit(async (v) => {
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

      const newTab: Tab = {
        id: `tab-${uuid()}`,
        label:
          res.profile.label || connectionInput.label || "Unnamed Connection",
        runtimeConnectionId: res.connection.id,
        profileId: res.profile.id,
      };

      addTab(newTab);
      setActiveScreen(newTab.id);
      onSaved?.();
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    }
  });

  const v = watch();

  return (
    <div class="mx-auto w-full max-w-5xl overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]">
      <div class="relative border-b border-slate-200 px-6 py-4">
        <div class="text-center">
          <div class="text-lg font-semibold text-slate-900">
            PostgreSQL Connection
          </div>
        </div>

        <Button
          onClick={onClose}
          variant="ghost"
          className="absolute top-3 right-3 rounded-full p-2"
        >
          <X className="size-4 text-slate-600" />
        </Button>
      </div>

      <div class="bg-slate-50 p-6">
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ConnectionBasicsSection
            control={control}
            errors={errors}
            onDirty={onDirty}
            isCreateNewConnection={!profileId}
          />

          <IdentitySection control={control} onDirty={onDirty} />
          <SecuritySection control={control} onDirty={onDirty} />
          <SSHSection control={control} onDirty={onDirty} />
        </div>

        <ConnectionFooter
          status={status}
          requiredOk={requiredOk}
          storeKeychain={v.storeKeychain}
          onTest={onTest}
          onSave={onSave}
          onConnect={onConnect}
        />
      </div>
    </div>
  );
}
