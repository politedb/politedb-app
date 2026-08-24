import {
  ChatPlusIcon,
  ClockIcon,
  DatabaseIcon,
  DownloadIcon,
  HeartIcon,
  KeyboardIcon,
  KeyIcon,
  SettingsIcon,
  ShieldAnalyticsIcon,
  SparklesIcon,
} from "src/components/icons";
import type { NavId, NavItem } from "src/types";
import { useAppUpdater } from "src/hooks/useAppUpdater";
import { licenseOpenExternalUrl } from "src/lib/tauri";
import { Button } from "src/components/common/Button";
import { Dropdown } from "src/components/common/Dropdown";
import {
  SettingsDialog,
  type SettingsDialogSection,
} from "src/components/modal/SettingsDialog";
import { useState } from "preact/hooks";

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

  const { appVersion, updateAvailable, isInstallingUpdate, installUpdate } =
    useAppUpdater();
  const [openSettings, setOpenSettings] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsDialogSection>("analytics");

  const envSuffix = import.meta.env.DEV ? "-dev" : "";

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
                      : "text-slate-700 hover:bg-slate-100 hover:text-slate-900",
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
          <div class="rounded-xl border border-slate-200 bg-white/60 p-2 text-xs text-slate-600">
            <div>
              Tips:
              <ul class="list-decimal pl-4.5">
                <li>Right-click a connection for actions.</li>
                <li>Double-click a connection to open it.</li>
                <li>Pin connections to keep it at the top.</li>
              </ul>
            </div>
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
                  className="w-full justify-between gap-2 rounded-xl px-2 py-1 text-sm hover:border-slate-100 hover:bg-slate-100"
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
                    class="rounded-full p-1"
                    title={isInstallingUpdate ? "Installing..." : "Download"}
                    aria-label={isInstallingUpdate ? "Installing" : "Download"}
                    disabled={isInstallingUpdate}
                    onClick={(e) => {
                      e.stopPropagation();
                      void installUpdate();
                    }}
                  >
                    {isInstallingUpdate ? (
                      <span class="px-1">Installing</span>
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
                    <span className="text-[13.5px] font-bold tracking-tight text-slate-600">
                      PoliteDB
                    </span>
                    <span className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-500 shadow-sm">
                      v{appVersion}
                      {envSuffix}
                    </span>
                  </div>
                ),
                className:
                  "pointer-events-none mb-0.5 p-2 hover:bg-transparent!",
              },
              {
                separatorBefore: true,
                icon: <SettingsIcon className="size-5" />,
                label: "Preferences...",
                onSelect: () => openSettingsSection("analytics"),
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
                  "font-semibold my-1 py-1.25 bg-rose-50/80 hover:bg-rose-50! text-rose-500 border border-rose-200 bg-rose-50/80",
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
