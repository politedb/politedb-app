import {
  ChatPlusIcon,
  ClockIcon,
  CloudOffIcon,
  DatabaseIcon,
  DownloadIcon,
  HeartIcon,
  KeyboardIcon,
  KeyIcon,
  LightBulbIcon,
  SettingsIcon,
  ShieldAnalyticsIcon,
  SparklesIcon,
} from "src/components/icons";
import type { NavId, NavItem } from "src/types";
import { useAppUpdater } from "src/hooks/useAppUpdater";
import { formatLicensePlanLabel, licenseOpenExternalUrl } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import { Dropdown } from "src/components/common/Dropdown";
import {
  SettingsDialog,
  type SettingsDialogSection,
} from "src/components/modal/SettingsDialog";
import { useState } from "preact/hooks";
import { useLicenseStore } from "src/stores/license";
import { cn } from "src/utils/cn";

const SPONSOR_URL = "https://github.com/sponsors/tonyphamvn";
const REQUEST_FEATURE_URL =
  "https://github.com/politedb/PoliteDB/issues/new?template=feature_request.md";
const BUG_REPORT_URL =
  "https://github.com/politedb/PoliteDB/issues/new?template=bug_report.md";

const NAV_ITEMS: NavItem[] = [
  {
    id: "connections",
    label: "Connections",
    icon: <DatabaseIcon className="size-4" />,
  },
  { id: "keychain", label: "Keychain", icon: <KeyIcon className="size-4" /> },
  { id: "logs", label: "Logs", icon: <ClockIcon className="size-4" /> },
];

export function LeftNav(props: {
  active: NavId;
  onChange: (id: NavId) => void;
}) {
  const { active, onChange } = props;

  const { updateAvailable, isUpdating, installUpdate } = useAppUpdater();
  const planLabel = useLicenseStore((s) =>
    formatLicensePlanLabel(s.state?.plan_name)
  );
  const [openSettings, setOpenSettings] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsDialogSection>("appearance");

  async function handleSponsor() {
    await openExternalUrl(SPONSOR_URL);
  }

  async function openExternalUrl(url: string) {
    try {
      await licenseOpenExternalUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function openSettingsSection(section: SettingsDialogSection) {
    setSettingsInitialSection(section);
    setSettingsDialogOpen(true);
  }

  return (
    <>
      <aside
        data-density-region="sidebar"
        class="flex shrink-0 flex-col border-r border-slate-200 bg-slate-50"
        style={{ width: "var(--sidebar-width)" }}
      >
        <div data-density-sidebar-header class="p-3">
          <div class="text-[11px] font-semibold tracking-wide text-slate-500 dark:text-slate-400">
            EXPLORER
          </div>
        </div>

        <nav class="px-2 pb-3">
          <div class="space-y-1">
            {NAV_ITEMS.map((item) => {
              const isActive = active === item.id;

              return (
                <button
                  data-density-item
                  key={item.id}
                  type="button"
                  onClick={() => onChange(item.id)}
                  class={cn(
                    "group flex w-full items-center gap-2.5",
                    "rounded-xl px-2.5 py-2 text-left transition-colors",
                    isActive
                      ? "bg-white text-slate-900 shadow-[0_1px_0_rgba(0,0,0,0.04)] ring-1 ring-slate-200 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700"
                      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100"
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  {/* Icon pill */}
                  <span
                    data-density-icon
                    class={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg",
                      "bg-slate-100",
                      isActive
                        ? "text-slate-700"
                        : "text-slate-500 group-hover:bg-slate-100/70",
                      "transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>

                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm leading-tight font-semibold">
                      {item.label}
                    </div>
                    {/* optional small description line (comment out if you don’t want it) */}
                    <div class="mt-0.5 truncate text-[11px] text-slate-500">
                      {item.id === "connections"
                        ? "Saved profiles"
                        : item.id === "logs"
                          ? "Open sessions"
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
          <div
            class={cn(
              "rounded-xl p-2 text-xs text-blue-600",
              "border border-blue-300 bg-blue-100",
              "shadow-md"
            )}
          >
            <div class="flex items-center gap-1">
              <LightBulbIcon className="inline-block size-4" />
              <span>Tips:</span>
            </div>
            <ul class="list-disc pl-5">
              <li>Right-click a connection for actions.</li>
              <li>Double-click a connection to open it.</li>
              <li>Pin connections to keep it at the top.</li>
            </ul>
          </div>
          <Dropdown
            widthClassName="w-64 px-2!"
            open={openSettings}
            onOpenChange={setOpenSettings}
            positions={["top", "left"]}
            align="start"
            trigger={
              <div className="flex w-full items-center gap-2">
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-between gap-2 rounded-xl px-2 py-1 text-sm",
                    "hover:border-slate-100 hover:bg-slate-100",
                    "dark:text-slate-300 dark:hover:border-slate-800 dark:hover:bg-slate-900"
                  )}
                  title="Settings"
                  onClick={() => setOpenSettings((v) => !v)}
                >
                  <div className="flex items-center gap-3">
                    <SettingsIcon className="size-4.5" />
                    Settings
                  </div>
                </Button>

                {updateAvailable ? (
                  <Button
                    class={cn("rounded-full p-1", isUpdating && "py-0.5")}
                    title={isUpdating ? "Installing..." : "Download"}
                    aria-label={isUpdating ? "Installing" : "Download"}
                    disabled={isUpdating}
                    onClick={(e) => {
                      e.stopPropagation();
                      void installUpdate();
                    }}
                  >
                    {isUpdating ? (
                      <span class="px-1 text-[11px]">Installing</span>
                    ) : (
                      <DownloadIcon className="size-3.5" />
                    )}
                  </Button>
                ) : null}
              </div>
            }
            items={[
              {
                label: (
                  <div className="flex w-full items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold tracking-tight text-slate-800">
                        Personal
                      </span>
                      <CloudOffIcon className="size-4 text-slate-400" />
                    </div>

                    <span className="text-slate-500">{planLabel}</span>
                  </div>
                ),
                className:
                  "pointer-events-none mb-0.5 p-2 hover:bg-transparent!",
              },
              {
                separatorBefore: true,
                icon: <SettingsIcon className="size-5" />,
                label: "Preferences...",
                onSelect: () => openSettingsSection("appearance"),
                className: "text-slate-900",
              },
              {
                icon: <ShieldAnalyticsIcon className="size-5" />,
                label: "Privacy & Analytics",
                onSelect: () => openSettingsSection("analytics"),
                className: "text-slate-900",
              },
              {
                icon: <KeyIcon className="size-5" />,
                label: "License key",
                onSelect: () => openSettingsSection("license"),
                className: "text-slate-900",
              },
              {
                icon: <KeyboardIcon className="size-5" />,
                label: "Keyboard shortcuts",
                onSelect: () => openSettingsSection("keyboard"),
                rightSlot: <span className="text-slate-400">⌘ K</span>,
                className: "text-slate-900",
              },
              {
                separatorBefore: true,
                icon: <SparklesIcon className="size-5" />,
                label: "Request feature",
                onSelect: () => void openExternalUrl(REQUEST_FEATURE_URL),
                className: "text-slate-900",
              },
              {
                icon: <ChatPlusIcon className="size-5" />,
                label: "Bug report",
                onSelect: () => void openExternalUrl(BUG_REPORT_URL),
                className: "text-slate-900",
              },
              {
                icon: <HeartIcon className="size-5 text-rose-500" />,
                label: "Github Sponsor",
                onSelect: handleSponsor,
                className:
                  "my-1 border border-rose-200 bg-rose-50/80 py-1.25 font-semibold text-rose-500 hover:bg-rose-50! dark:border-rose-500/40 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-900/40!",
              },
            ]}
          />
        </div>
      </aside>

      <SettingsDialog
        open={settingsDialogOpen}
        onClose={() => setSettingsDialogOpen(false)}
        initialSection={settingsInitialSection}
      />
    </>
  );
}
