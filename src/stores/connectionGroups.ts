import { create } from "zustand";

type ConnectionGroup = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type ConnectionGroupsSnapshot = {
  groups: ConnectionGroup[];
  assignments: Record<string, string | undefined>;
};

type ConnectionGroupsState = ConnectionGroupsSnapshot & {
  loaded: boolean;
  ensureLoaded: () => void;
  createGroup: (name: string) => ConnectionGroup;
  assignGroup: (profileId: string, groupId?: string) => void;
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
    return {
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      assignments:
        parsed.assignments && typeof parsed.assignments === "object"
          ? parsed.assignments
          : {},
    };
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

export { type ConnectionGroup };

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

    assignGroup: (profileId, groupId) => {
      get().ensureLoaded();
      const nextAssignments = { ...get().assignments };
      if (groupId) {
        nextAssignments[profileId] = groupId;
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
      const groupId = assignments[profileId];
      return groups.find((group) => group.id === groupId);
    },
  })
);
