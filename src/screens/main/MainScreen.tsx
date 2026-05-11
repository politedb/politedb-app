import { useEffect, useMemo, useState } from "preact/hooks";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { v4 as uuid } from "uuid";

import { ConnectionModal } from "src/components/SelectConnEngineModal";
import { ConnectionFormDialog } from "src/components/connection-form/ConnectionFormDialog";
import { KeyboardShortcutsDialog } from "src/components/modal/KeyboardShortcutsDialog";
import { LicenseDialog } from "src/components/modal/LicenseDialog";
import { NewConnectionGroupDialog } from "src/components/modal/NewConnectionGroupDialog";
import { OverlayModal } from "src/components/modal/OverlayModal";
import { PrivacyDialog } from "src/components/modal/PrivacyDialog";

import { ProfileTab, useScreenStore } from "src/stores/screen";
import { useProfileStore } from "src/stores/profile";
import { useConnectionGroupsStore } from "src/stores/connectionGroups";
import { normalizeGroupIds } from "src/stores/connectionGroups";
import { useLicenseStore } from "src/stores/license";

import { LeftNav } from "./LeftNav";
import { TopBar } from "./TopBar";
import { ConnectionsSection } from "./ConnectionsSection";
import { GroupsSection } from "./GroupsSection";
import { KeychainSection } from "./KeychainSection";

import { filterConnections } from "src/utils/connection";
import type {
  ConnectionSortMode,
  DatabaseEngine,
  KeychainSortMode,
  NavId,
  ViewMode,
} from "src/types";
import { duplicateProfile, profileImport, type ConnectionProfile } from "src/lib/tauri";
import { pickOpenFile, showMessage } from "src/lib/system-dialog";
import { trackEvent } from "src/lib/analytics";

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
  const ensureGroupsLoaded = useConnectionGroupsStore((s) => s.ensureLoaded);
  const groups = useConnectionGroupsStore((s) => s.groups);
  const assignments = useConnectionGroupsStore((s) => s.assignments);
  const createGroup = useConnectionGroupsStore((s) => s.createGroup);
  const deleteGroup = useConnectionGroupsStore((s) => s.deleteGroup);
  const assignGroup = useConnectionGroupsStore((s) => s.assignGroup);
  const assignGroups = useConnectionGroupsStore((s) => s.assignGroups);
  const loadLicense = useLicenseStore((s) => s.load);

  const [searchQuery, setSearchQuery] = useState("");
  const [activeNav, setActiveNav] = useState<NavId>("connections");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [connectionSortMode, setConnectionSortMode] =
    useState<ConnectionSortMode>("created-desc");
  const [keychainSortMode, setKeychainSortMode] =
    useState<KeychainSortMode>("label-asc");
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [keychainNewSignal, setKeychainNewSignal] = useState(0);
  const [keychainEditorOpen, setKeychainEditorOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    ensureGroupsLoaded();
  }, [ensureGroupsLoaded]);

  useEffect(() => {
    void loadLicense();
  }, [loadLicense]);

  const selectedProfile = useMemo(() => {
    if (!selectedProfileId) return undefined;
    return profiles.find((p) => p.id === selectedProfileId);
  }, [profiles, selectedProfileId]);

  const groupIdsByProfile = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const profile of profiles) {
      next[profile.id] = normalizeGroupIds(assignments[profile.id]);
    }
    return next;
  }, [profiles, assignments]);

  const groupedProfiles = useMemo(
    () =>
      groups.map((group) => ({
        group,
        count: profiles.filter(
          (profile) => (groupIdsByProfile[profile.id] ?? []).includes(group.id)
        ).length,
      })),
    [groups, profiles, groupIdsByProfile]
  );

  const filteredProfiles = useMemo(() => {
    const searched = filterConnections(
      profiles,
      searchQuery,
      connectionSortMode
    );
    if (!selectedGroupId) return searched;
    return searched.filter(
      (profile) => (groupIdsByProfile[profile.id] ?? []).includes(selectedGroupId)
    );
  }, [profiles, searchQuery, selectedGroupId, groupIdsByProfile, connectionSortMode]);

  useEffect(() => {
    if (!selectedGroupId) return;
    const stillExists = groupedProfiles.some(
      ({ group }) => group.id === selectedGroupId
    );
    if (!stillExists) setSelectedGroupId(undefined);
  }, [groupedProfiles, selectedGroupId]);

  function assignSelectedGroupToProfile(profileId: string) {
    if (showNewConnection && selectedGroupId) {
      assignGroup(profileId, selectedGroupId);
    }
  }

  async function handleProfileSaved(v?: ConnectionProfile) {
    if (!v) return;

    await saveProfile(v);

    assignSelectedGroupToProfile(v.id);
    closeNew();
    closeEdit();
    setShowDatabaseForm(undefined);
    selectProfile(undefined);
  }

  async function handleNewProfile(v?: ConnectionProfile) {
    if (v) assignSelectedGroupToProfile(v.id);

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

  async function handleImportConnections() {
    try {
      const path = await pickOpenFile({
        title: "Import connection config",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;

      const json = await readTextFile(path);
      const result = await profileImport(json);
      await loadProfiles();

      await showMessage(
        `Imported ${result.created + result.updated} connection(s).\nCreated: ${result.created}\nUpdated: ${result.updated}\n\nProfiles using keychain secrets may need passwords to be re-entered on this device.`,
        { title: "Import complete", kind: "info" }
      );
    } catch (err) {
      await showMessage(String(err), { title: "Import failed", kind: "error" });
    }
  }

  async function handleCreateGroup(name: string) {
    createGroup(name);
  }

  async function handleDuplicate(profileId: string) {
    const found = profiles.find((p) => p.id === profileId);
    if (!found) return;

    try {
      const created = await duplicateProfile(found);
      const groupIds = normalizeGroupIds(assignments[found.id]);
      if (groupIds.length) assignGroups(created.id, groupIds);
      await loadProfiles();

      trackEvent("connection_duplicate_success", {
        engine: created.engine,
      });
    } catch (err) {
      const msg = String(err);
      await showMessage(msg, {
        title: "Could not duplicate connection",
        kind: "error",
      });
      trackEvent("connection_duplicate_error", {
        engine: found.engine,
        error: msg.slice(0, 240),
      });
    }
  }

  function handleTopBarCreate() {
    if (activeNav === "connections") {
      openNew();
      return;
    }
    setKeychainEditorOpen(true);
    setKeychainNewSignal((n) => n + 1);
  }

  function handleDeleteGroup(groupId: string) {
    if (selectedGroupId === groupId) {
      setSelectedGroupId(undefined);
    }
    deleteGroup(groupId);
  }

  return (
    <div class="flex h-full flex-col bg-neutral-50">
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <LeftNav
          active={activeNav}
          onChange={setActiveNav}
          onOpenLicense={() => setLicenseOpen(true)}
          onOpenPrivacy={() => setPrivacyOpen(true)}
          onOpenKeyboardShortcuts={() => setKeyboardShortcutsOpen(true)}
        />

        {/* Main column */}
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* TopBar: pinned */}
          <div class="shrink-0 border-b border-slate-200 bg-white">
            <div class="px-3 py-2">
              <TopBar
                mode={activeNav}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                onNewConnection={handleTopBarCreate}
                onNewGroup={() => setNewGroupOpen(true)}
                onImportConnections={handleImportConnections}
                viewMode={viewMode}
                onViewMode={setViewMode}
                connectionSortMode={connectionSortMode}
                onConnectionSortModeChange={setConnectionSortMode}
                keychainSortMode={keychainSortMode}
                onKeychainSortModeChange={setKeychainSortMode}
              />
            </div>
          </div>

          {/* Content canvas (scroll only here) */}
          <div class="min-h-0 flex-1 overflow-y-auto bg-neutral-100">
            {activeNav === "connections" ? (
              <div class="px-4 py-4">
                {/* Centered canvas */}
                <div class="mx-auto w-full max-w-400">
                  <GroupsSection
                    groups={groupedProfiles}
                    selectedGroupId={selectedGroupId}
                    onPickGroup={setSelectedGroupId}
                    onDeleteGroup={handleDeleteGroup}
                  />
                  <ConnectionsSection
                    profiles={filteredProfiles}
                    selectedId={selectedProfileId}
                    viewMode={viewMode}
                    searchQuery={searchQuery}
                    groups={groups}
                    groupIdsByProfile={groupIdsByProfile}
                    onCreate={openNew}
                    onAssignGroups={assignGroups}
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
                    onDuplicate={handleDuplicate}
                  />
                </div>
              </div>
            ) : (
              <KeychainSection
                searchQuery={searchQuery}
                viewMode={viewMode}
                sortMode={keychainSortMode}
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

        <PrivacyDialog
          open={privacyOpen}
          onClose={() => setPrivacyOpen(false)}
        />
        <LicenseDialog
          open={licenseOpen}
          onClose={() => setLicenseOpen(false)}
        />
        <KeyboardShortcutsDialog
          open={keyboardShortcutsOpen}
          onClose={() => setKeyboardShortcutsOpen(false)}
        />
        <NewConnectionGroupDialog
          open={newGroupOpen}
          onClose={() => setNewGroupOpen(false)}
          onCreate={handleCreateGroup}
        />
      </div>
    </div>
  );
}
