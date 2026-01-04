import { useEffect, useMemo, useState } from "preact/hooks";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/ConnectionModal";
import { ConnectionFormDialog } from "src/components/ConnectionFormDialog";
import { Tab, useScreenStore } from "src/stores/screen";
import {
  ConnectionCreateInput,
  ConnectionProfile,
  profileList,
} from "src/lib/tauri";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { GroupsSection } from "./GroupsSection";
import { ConnectionsSection } from "./ConnectionsSection";
import { filterConnections, groupConnections } from "src/utils/connection";
import type { NavId, ViewMode } from "src/types";
import { OverlayModal } from "src/components/modal/OverlayModal";

export function MainScreen() {
  const { tabs, addTab, setActiveScreen } = useScreenStore();

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null
  );
  const [selectedProfile, setSelectedProfile] =
    useState<ConnectionProfile | null>(null);

  const [showNewConnection, setShowNewConnection] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showDatabaseForm, setShowDatabaseForm] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState<NavId>("connections");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  useEffect(() => {
    void reloadProfiles();
  }, []);

  async function reloadProfiles() {
    try {
      const list = await profileList();
      setProfiles(list);
    } catch (err) {
      console.error("Failed to load profiles", err);
    }
  }

  const filteredProfiles = useMemo(
    () => filterConnections(profiles, searchQuery),
    [profiles, searchQuery]
  );

  const profileGroups = useMemo(
    () => groupConnections(filteredProfiles),
    [filteredProfiles]
  );

  function resetSelection() {
    setSelectedProfileId(null);
    setSelectedProfile(null);
  }

  function handleNewConnection() {
    setShowNewConnection(true);
    setShowDatabaseForm(false);
    resetSelection();
  }

  function handleProfileSaved() {
    void reloadProfiles();
    setShowNewConnection(false);
    setShowProfileModal(false);
    setShowDatabaseForm(false);
    resetSelection();
  }

  function handleEditProfile(profileId: string) {
    const found = profiles.find((p) => p.id === profileId) ?? null;
    if (!found) return;

    setSelectedProfileId(profileId);
    setSelectedProfile(found);
    setShowProfileModal(true);
    setShowNewConnection(false);
  }

  function openProfileInTab(profileId: string) {
    const found = profiles.find((p) => p.id === profileId);
    if (!found) return;

    const existing = tabs.find((t) => t.profileId === profileId);
    if (existing) {
      setActiveScreen(existing.id);
      return;
    }

    const newTab: Tab = {
      id: `tab-${uuid()}`,
      label: found.label || "Unnamed Connection",
      profileId,
      runtimeConnectionId: undefined,
    };

    addTab(newTab);
    setActiveScreen(newTab.id);
    setShowProfileModal(false);
  }

  return (
    <div class="h-full flex flex-col bg-neutral-50">
      <div class="flex-1 flex overflow-hidden">
        <LeftNav active={activeNav} onChange={setActiveNav} />

        <div class="flex-1 flex flex-col overflow-hidden">
          <TopBar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onNew={handleNewConnection}
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
                  connections={filteredProfiles}
                  selectedId={selectedProfileId}
                  viewMode={viewMode}
                  searchQuery={searchQuery}
                  onCreate={handleNewConnection}
                  onOpen={openProfileInTab}
                  onEdit={handleEditProfile}
                />
              </div>
            ) : (
              <div class="p-6">
                <div class="text-center py-12">
                  <p class="text-slate-500">Keychain feature coming soon</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {showNewConnection ? (
          <ConnectionModal
            onSaved={handleProfileSaved}
            onClose={() => {
              setShowNewConnection(false);
              resetSelection();
              setShowDatabaseForm(false);
            }}
            showDatabaseForm={showDatabaseForm}
            setShowDatabaseForm={setShowDatabaseForm}
          />
        ) : null}

        <OverlayModal
          open={!!(showProfileModal && selectedProfile)}
          onClose={() => {
            setShowProfileModal(false);
            resetSelection();
          }}
        >
          <ConnectionFormDialog
            onSaved={handleProfileSaved}
            onClose={() => {
              setShowProfileModal(false);
              resetSelection();
            }}
            initialData={selectedProfile as any}
          />
        </OverlayModal>
      </div>
    </div>
  );
}
