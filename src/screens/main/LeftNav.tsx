import { DatabaseIcon, KeyIcon, SettingsIcon } from "src/components/icons";
import type { NavId, NavItem } from "src/types";
import { useAppUpdater } from "src/hooks/useAppUpdater";
import { useLicenseStore } from "src/stores/license";
import { Button } from "src/components/common/Button";
import { Dropdown } from "../../components/common/Dropdown";
import { useMemo, useState } from "preact/hooks";
import { TagChips } from "../../components/common/TagChips";

const NAV_ITEMS: NavItem[] = [
  {
    id: "connections",
    label: "Connections",
    icon: <DatabaseIcon className="size-4" />,
  },
  { id: "keychain", label: "Keychain", icon: <KeyIcon className="size-4" /> },
];

export function LeftNav(props: {
  active: NavId;
  onChange: (id: NavId) => void;
  onOpenLicense: () => void;
  onOpenPrivacy: () => void;
  onOpenKeyboardShortcuts: () => void;
}) {
  const {
    active,
    onChange,
    onOpenLicense,
    onOpenPrivacy,
    onOpenKeyboardShortcuts,
  } = props;

  const { appVersion, updateAvailable, installUpdate, isInstallingUpdate } =
    useAppUpdater();
  const licenseState = useLicenseStore((s) => s.state);
  const [openSettings, setOpenSettings] = useState(false);

  const envSuffix = import.meta.env.DEV ? "-dev" : "";
  const isLicenseActive =
    String(licenseState?.status ?? "").toLowerCase() === "active";
  const licensePlanLabel = useMemo(() => {
    if (isLicenseActive) {
      return `${licenseState?.plan_name?.trim() || "Licensed"} plan`;
    }

    const trialExpiresAt =
      typeof licenseState?.trial_expires_at === "number"
        ? licenseState.trial_expires_at
        : null;

    if (!trialExpiresAt) {
      return "Free trial";
    }

    const remainingMs = trialExpiresAt - Date.now();
    if (remainingMs <= 0) {
      return "Free trial expired";
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const daysLeft = Math.ceil(remainingMs / dayMs);

    return daysLeft <= 1
      ? "Free trial (1 days left)"
      : `Free trial (${daysLeft} days left)`;
  }, [
    isLicenseActive,
    licenseState?.plan_name,
    licenseState?.trial_expires_at,
  ]);

  return (
    <aside
      class="flex shrink-0 flex-col border-r border-slate-200 bg-slate-50"
      style={{ width: "var(--sidebar-width)" }}
    >
      {/* Top padding / subtle header */}
      <div class="p-3">
        <div class="text-[11px] font-semibold tracking-wide text-slate-500">
          NAVIGATION
        </div>
      </div>

      <nav class="px-2 pb-3">
        <div class="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = active === item.id;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange(item.id)}
                class={[
                  "group w-full",
                  "flex items-center gap-2.5",
                  "rounded-xl px-2.5 py-2",
                  "text-left",
                  "transition-colors",
                  isActive
                    ? "bg-white text-slate-900 shadow-[0_1px_0_rgba(0,0,0,0.04)] ring-1 ring-slate-200"
                    : "text-slate-700 hover:bg-white/60 hover:text-slate-900",
                ].join(" ")}
                aria-current={isActive ? "page" : undefined}
              >
                {/* Icon pill */}
                <span
                  class={[
                    "flex h-8 w-8 items-center justify-center rounded-lg",
                    isActive
                      ? "bg-slate-100 text-slate-700"
                      : "bg-transparent text-slate-500 group-hover:bg-slate-100/70",
                    "transition-colors",
                  ].join(" ")}
                >
                  {item.icon}
                </span>

                <div class="min-w-0 flex-1">
                  <div class="truncate text-[13px] leading-tight font-semibold">
                    {item.label}
                  </div>
                  {/* optional small description line (comment out if you don’t want it) */}
                  <div class="mt-0.5 truncate text-[11px] text-slate-500">
                    {item.id === "connections"
                      ? "Saved profiles"
                      : "Secrets & keychain"}
                  </div>
                </div>

                {/* Active marker (subtle) */}
                {isActive ? (
                  <span class="h-2 w-2 rounded-full bg-blue-500" />
                ) : (
                  <span class="h-2 w-2 rounded-full bg-transparent" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Bottom spacer */}
      <div class="mt-auto space-y-2.5 px-3 pb-3">
        <div class="rounded-xl border border-slate-200 bg-white/60 px-3 py-2 text-[11px] text-slate-600">
          <div>Tip: Right-click a connection for actions.</div>
        </div>
        {updateAvailable && (
          <Button
            onClick={() => void installUpdate()}
            disabled={isInstallingUpdate}
            class="w-full rounded-xl text-sm disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isInstallingUpdate ? "Installing update..." : "Update"}
          </Button>
        )}

        <Dropdown
          open={openSettings}
          onOpenChange={setOpenSettings}
          positions={["top", "left"]}
          align="start"
          trigger={
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                className="w-full justify-between gap-2 rounded-xl px-2 py-1 text-sm"
                title="Settings"
                onClick={() => setOpenSettings((v) => !v)}
              >
                <div className="flex items-center gap-3">
                  <SettingsIcon className="size-4.5" />
                  Settings
                </div>
                {!isLicenseActive && (
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenLicense();
                    }}
                  >
                    <TagChips
                      className="[&>span]:capitalize"
                      tags="Upgrade"
                      size="md"
                    />
                  </div>
                )}
              </Button>
            </div>
          }
          itemClassName="py-1"
          items={[
            {
              label: `About PoliteDB (v${appVersion}${envSuffix})`,
              disabled: true,
            },
            {
              label: licensePlanLabel,
              disabled: true,
            },
            {
              separatorBefore: true,
              label: "Privacy & Analytics",
              onSelect: onOpenPrivacy,
            },
            {
              label: "License key",
              onSelect: onOpenLicense,
            },
            {
              separatorBefore: true,
              label: "Keyboard shortcuts",
              onSelect: onOpenKeyboardShortcuts,
            },
          ]}
        />
      </div>
    </aside>
  );
}
