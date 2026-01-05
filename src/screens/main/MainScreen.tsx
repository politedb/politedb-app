import { useEffect, useMemo, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/SelectConnEngineModal";
import { ConnectionFormDialog } from "src/components/connection-form/ConnectionFormDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";

import { useScreenStore, Tab } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { GroupsSection } from "./GroupsSection";
import { ConnectionsSection } from "./ConnectionsSection";

import { filterConnections, groupConnections } from "src/utils/connection";
import type { NavId, ViewMode } from "src/types";

export function MainScreen() {
  const { addTab, setActiveScreen } = useScreenStore();

  const {
    loadProfiles,
    getProfileById,

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
    if (!selectedProfileId) return null;
    return getProfileById(selectedProfileId) ?? null;
  }, [selectedProfileId, getProfileById]);

  const filteredProfiles = useMemo(
    () => filterConnections(profiles, searchQuery),
    [profiles, searchQuery]
  );

  const profileGroups = useMemo(
    () => groupConnections(filteredProfiles),
    [filteredProfiles]
  );

  async function handleProfileSaved() {
    await loadProfiles();
    closeNew();
    closeEdit();
    setShowDatabaseForm(false);
    selectProfile(null);
  }

  function openProfileInTab(profileId: string) {
    const found = getProfileById(profileId);
    if (!found) return;

    const newTab: Tab = {
      id: `tab-${uuid()}`,
      label: found.label || "Unnamed Connection",
      profileId,
      runtimeConnectionId: undefined,
    };

    addTab(newTab);
    setActiveScreen(newTab.id);
    closeEdit();
  }

  return (
    <div class="flex h-full flex-col bg-neutral-50">
      <div class="flex flex-1 overflow-hidden">
        <LeftNav active={activeNav} onChange={setActiveNav} />

        <div class="flex flex-1 flex-col overflow-hidden">
          <TopBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onNew={openNew}
            viewMode={viewMode}
            onViewMode={setViewMode}
          />

          <div class="flex-1 overflow-y-auto bg-neutral-100">
            {activeNav === "connections" ? (
              <div class="p-6">
                <GroupsSection
                  groups={profileGroups}
                  viewMode={viewMode}
                  onPickTag={(tag) => setSearchQuery(tag)}
                />

                <ConnectionsSection
                  profiles={filteredProfiles}
                  selectedId={selectedProfileId}
                  viewMode={viewMode}
                  searchQuery={searchQuery}
                  onCreate={openNew}
                  onOpen={(id) => {
                    selectProfile(id);
                    openProfileInTab(id);
                  }}
                  onEdit={(id) => {
                    selectProfile(id);
                    openEdit(id);
                  }}
                />
              </div>
            ) : (
              <div class="p-6">
                <div class="py-12 text-center">
                  <p class="text-slate-500">Keychain feature coming soon</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {showNewConnection ? (
          <ConnectionModal
            onSaved={handleProfileSaved}
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
            onSaved={handleProfileSaved}
            onClose={closeEdit}
            initialData={selectedProfile as any}
          />
        </OverlayModal>
      </div>
    </div>
  );
}
