import { useMemo } from "preact/hooks";
import { useForm } from "react-hook-form";
import { v4 as uuid } from "uuid";

import { connectionTest, profileSaveAndConnect } from "src/lib/tauri";

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
  type ProfileConnectionData,
  type FormValues,
} from "./connectionForm.utils";
import { useConnectionStatus } from "./useConnectionStatus";

export function ConnectionFormDialog({
  onClose,
  onSaved,
  initialData,
}: {
  onSaved?: () => void;
  onClose?: () => void;
  initialData?: ProfileConnectionData;
} = {}) {
  const { addTab, setActiveScreen } = useScreenStore();

  const isEditing = !!initialData?.key;
  const profileId = initialData?.key ?? "";

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
      await connectionTest(input);
      setSuccess("Test OK");
    } catch (e: any) {
      setError(e?.message ? String(e.message) : String(e));
    }
  });

  const onConnect = handleSubmit(async (v) => {
    setConnecting();
    try {
      const connectionInput = buildConnectionInput(v);

      const action = isEditing
        ? ({
            mode: "update",
            profileId: profileId || (initialData?.key as string),
          } as const)
        : ({ mode: "create" } as const);

      const res = await profileSaveAndConnect({
        ...action,

        // FE-only
        storeKeychain: v.storeKeychain,
        password: v.password,

        ...connectionInput,
      } as any);

      setSuccess(`Connected ✅ ${res.profile.label}`);

      const newTab: Tab = {
        id: `tab-${uuid()}`,
        label:
          res.profile.label || connectionInput.label || "Unnamed Connection",
        runtimeConnectionId: res.connection.id,
        profileId,
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
          onConnect={onConnect}
        />
      </div>
    </div>
  );
}
