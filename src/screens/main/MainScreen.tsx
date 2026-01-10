import { useEffect, useMemo, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/SelectConnEngineModal";
import { ConnectionFormDialog } from "src/components/connection-form/ConnectionFormDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";

import { useScreenStore, type Tab } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { ConnectionsSection } from "./ConnectionsSection";

import { filterConnections } from "src/utils/connection";
import type { DatabaseEngine, NavId, ViewMode } from "src/types";
import type { ConnectionProfile } from "src/lib/tauri";

export function MainScreen() {
  const { addTab, setActiveScreen } = useScreenStore();

  const {
    loadProfiles,
    saveProfile,

    selectedProfileId,
    selectProfile,

    showNewConnection,
    showEditProfile,
    showDatabaseForm,
    setShowDatabaseForm,

    openNew,
    closeNew,
    openEdit,
    closeEdit,
  } = useProfileStore();

  const profiles = useProfileStore((s) => s.profiles);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState<NavId>("connections");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const selectedProfile = useMemo(() => {
    if (!selectedProfileId) return undefined;
    return profiles.find((p) => p.id === selectedProfileId);
  }, [profiles, selectedProfileId]);

  const filteredProfiles = useMemo(
    () => filterConnections(profiles, searchQuery),
    [profiles, searchQuery]
  );

  async function handleProfileSaved(v?: ConnectionProfile) {
    if (!v) return;

    await saveProfile(v);

    closeNew();
    closeEdit();
    setShowDatabaseForm(undefined);
    selectProfile(undefined);
  }

  async function handleNewProfile() {
    await loadProfiles();
    closeNew();
    closeEdit();
    setShowDatabaseForm(undefined);
    selectProfile(undefined);
  }

  function openProfileInTab(profileId: string) {
    const found = profiles.find((p) => p.id === profileId);
    if (!found) return;

    const newTab: Tab = {
      id: `tab-${uuid()}`,
      label: found.label || "Unnamed Connection",
      profileId,
      engine: found.engine,
      runtimeConnectionId: undefined,
    };

    addTab(newTab);
    setActiveScreen(newTab.id);
  }

  return (
    <div class="flex h-full flex-col bg-neutral-50">
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <LeftNav active={activeNav} onChange={setActiveNav} />

        {/* Main column */}
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* TopBar: pinned */}
          <div class="shrink-0 border-b border-slate-200 bg-white">
            <div class="px-3 py-2">
              <TopBar
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onNew={openNew}
                viewMode={viewMode}
                onViewMode={setViewMode}
              />
            </div>
          </div>

          {/* Content canvas (scroll only here) */}
          <div class="min-h-0 flex-1 overflow-y-auto bg-neutral-100">
            {activeNav === "connections" ? (
              <div class="px-4 py-4">
                {/* Centered canvas */}
                <div class="mx-auto w-full max-w-400">
                  <ConnectionsSection
                    profiles={filteredProfiles}
                    selectedId={selectedProfileId}
                    viewMode={viewMode}
                    searchQuery={searchQuery}
                    onCreate={openNew}
                    onOpen={(id) => {
                      // optional: keep selection in sync when opening
                      // selectProfile(id);
                      openProfileInTab(id);
                      closeEdit();
                    }}
                    onEdit={(id) => {
                      selectProfile(id);
                      openEdit(id);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div class="px-4 py-6">
                <div class="mx-auto w-full max-w-3xl">
                  <div class="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
                    <p class="text-sm font-medium text-slate-700">Keychain</p>
                    <p class="mt-1 text-sm text-slate-500">
                      Keychain feature coming soon
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modals */}
        {showNewConnection ? (
          <ConnectionModal
            onSaved={handleNewProfile}
            onClose={closeNew}
            showDatabaseForm={showDatabaseForm}
            setShowDatabaseForm={setShowDatabaseForm}
          />
        ) : null}

        <OverlayModal
          open={!!(showEditProfile && selectedProfile)}
          onClose={closeEdit}
        >
          <ConnectionFormDialog
            onSaved={selectedProfile ? handleProfileSaved : handleNewProfile}
            onClose={closeEdit}
            initialData={selectedProfile}
            engine={
              selectedProfile
                ? selectedProfile.engine
                : (showDatabaseForm as DatabaseEngine)
            }
          />
        </OverlayModal>
      </div>
    </div>
  );
}
