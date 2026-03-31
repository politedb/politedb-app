import { useEffect, useMemo, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/SelectConnEngineModal";
import { ConnectionFormDialog } from "src/components/connection-form/ConnectionFormDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { PrivacyDialog } from "src/components/modal/PrivacyDialog";

import { ProfileTab, useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { ConnectionsSection } from "./ConnectionsSection";
import { KeychainSection } from "./KeychainSection";

import { filterConnections } from "src/utils/connection";
import type { DatabaseEngine, NavId, ViewMode } from "src/types";
import type { ConnectionProfile } from "src/lib/tauri";
import { needsTelemetryConsent } from "src/lib/analytics";

export function MainScreen() {
  const { addTab, setActiveProfileScreen } = useScreenStore();

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
  const [keychainNewSignal, setKeychainNewSignal] = useState(0);
  const [keychainEditorOpen, setKeychainEditorOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(needsTelemetryConsent());

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

    const newTab: ProfileTab = {
      id: `tab-${uuid()}`,
      label: found.label || "Unnamed Connection",
      profileId,
      engine: found.engine,
      runtimeConnectionId: undefined,
    };

    addTab(newTab);
    setActiveProfileScreen(newTab.id);
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
                mode={activeNav}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onNew={() => {
                  if (activeNav === "connections") {
                    openNew();
                  } else {
                    setKeychainEditorOpen(true);
                    setKeychainNewSignal((n) => n + 1);
                  }
                }}
                onPrivacy={() => setPrivacyOpen(true)}
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
              <KeychainSection
                searchQuery={searchQuery}
                viewMode={viewMode}
                newSignal={keychainNewSignal}
                editorOpen={keychainEditorOpen}
                onEditorOpenChange={setKeychainEditorOpen}
              />
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

        <PrivacyDialog open={privacyOpen} onClose={() => setPrivacyOpen(false)} />
      </div>
    </div>
  );
}
