import { create } from "zustand";

type ConnectionGroup = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type ConnectionGroupsSnapshot = {
  groups: ConnectionGroup[];
  assignments: Record<string, string | string[] | undefined>;
};

type ConnectionGroupsState = ConnectionGroupsSnapshot & {
  loaded: boolean;
  ensureLoaded: () => void;
  createGroup: (name: string) => ConnectionGroup;
  deleteGroup: (groupId: string) => void;
  assignGroup: (profileId: string, groupId?: string) => void;
  assignGroups: (profileId: string, groupIds: string[]) => void;
  getGroupForProfile: (profileId: string) => ConnectionGroup | undefined;
};

const STORAGE_KEY = "politedb.connection-groups.v1";

function safeRead(): ConnectionGroupsSnapshot {
  if (typeof window === "undefined") {
    return { groups: [], assignments: {} };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { groups: [], assignments: {} };
    const parsed = JSON.parse(raw) as Partial<ConnectionGroupsSnapshot>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    const assignments: ConnectionGroupsSnapshot["assignments"] = {};
    const rawAssignments =
      parsed.assignments && typeof parsed.assignments === "object"
        ? parsed.assignments
        : {};

    for (const [profileId, value] of Object.entries(rawAssignments)) {
      if (Array.isArray(value)) {
        const groupIds = value.filter(
          (groupId): groupId is string =>
            typeof groupId === "string" && !!groupId
        );
        if (groupIds.length)
          assignments[profileId] = Array.from(new Set(groupIds));
      } else if (typeof value === "string" && value) {
        // Backward compatible migration from v1 single-group assignments.
        assignments[profileId] = [value];
      }
    }

    return { groups, assignments };
  } catch {
    return { groups: [], assignments: {} };
  }
}

function safeWrite(snapshot: ConnectionGroupsSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage failures
  }
}

function normalizeGroupName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function sortGroups(groups: ConnectionGroup[]) {
  return groups
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function normalizeGroupIds(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value.filter(
          (groupId): groupId is string =>
            typeof groupId === "string" && !!groupId
        )
      )
    );
  }
  if (typeof value === "string" && value) return [value];
  return [];
}

export { type ConnectionGroup, normalizeGroupIds };

export const useConnectionGroupsStore = create<ConnectionGroupsState>(
  (set, get) => ({
    loaded: false,
    groups: [],
    assignments: {},

    ensureLoaded: () => {
      if (get().loaded) return;
      const snapshot = safeRead();
      set({
        loaded: true,
        groups: sortGroups(snapshot.groups),
        assignments: snapshot.assignments,
      });
    },

    createGroup: (name) => {
      get().ensureLoaded();
      const normalized = normalizeGroupName(name);
      if (!normalized) {
        throw new Error("GROUP_NAME_REQUIRED");
      }

      const existing = get().groups.find(
        (group) => group.name.toLowerCase() === normalized.toLowerCase()
      );
      if (existing) {
        throw new Error("GROUP_NAME_EXISTS");
      }

      const now = Date.now();
      const nextGroup: ConnectionGroup = {
        id: `group-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: normalized,
        createdAt: now,
        updatedAt: now,
      };

      const nextGroups = sortGroups([...get().groups, nextGroup]);
      const snapshot = {
        groups: nextGroups,
        assignments: get().assignments,
      };
      safeWrite(snapshot);
      set(snapshot);
      return nextGroup;
    },

    deleteGroup: (groupId) => {
      get().ensureLoaded();

      const nextGroups = get().groups.filter((group) => group.id !== groupId);
      const nextAssignments = { ...get().assignments };

      for (const [profileId, assignedGroupIds] of Object.entries(
        nextAssignments
      )) {
        const nextGroupIds = normalizeGroupIds(assignedGroupIds).filter(
          (id) => id !== groupId
        );
        if (nextGroupIds.length) {
          nextAssignments[profileId] = nextGroupIds;
        } else {
          delete nextAssignments[profileId];
        }
      }

      const snapshot = {
        groups: nextGroups,
        assignments: nextAssignments,
      };
      safeWrite(snapshot);
      set(snapshot);
    },

    assignGroup: (profileId, groupId) => {
      get().assignGroups(profileId, groupId ? [groupId] : []);
    },

    assignGroups: (profileId, groupIds) => {
      get().ensureLoaded();
      const existingGroupIds = new Set(get().groups.map((group) => group.id));
      const cleanGroupIds = Array.from(
        new Set(groupIds.filter((groupId) => existingGroupIds.has(groupId)))
      );
      const nextAssignments = { ...get().assignments };
      if (cleanGroupIds.length) {
        nextAssignments[profileId] = cleanGroupIds;
      } else {
        delete nextAssignments[profileId];
      }
      const snapshot = {
        groups: get().groups,
        assignments: nextAssignments,
      };
      safeWrite(snapshot);
      set(snapshot);
    },

    getGroupForProfile: (profileId) => {
      const { groups, assignments } = get();
      const groupId = normalizeGroupIds(assignments[profileId])[0];
      return groups.find((group) => group.id === groupId);
    },
  })
);
