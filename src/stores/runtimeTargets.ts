import { create } from "zustand";
import type { RuntimeTarget } from "src/lib/tauri/types";

/*
 * Transient facts about runtime connections (plan tab-database-reconnect
 * D1, R4, R6, R11): what each was opened on, which tab owns it, and which
 * the backend refused as stale. Never persisted.
 */

export type RuntimeRefusal = "RUNTIME_STALE" | "RUNTIME_IDENTITY_MISSING";

type RuntimeTargetsState = {
  /** runtime id → what it was opened on (null: the backend has none). */
  targets: Record<string, RuntimeTarget | null>;
  /** runtime id → the tab that acquired it (and alone may remove it). */
  owners: Record<string, string>;
  /** runtime id → why the backend refused it; it takes no new work. */
  refused: Record<string, RuntimeRefusal>;
  register: (
    runtimeId: string,
    target: RuntimeTarget | null | undefined,
    ownerTabId?: string
  ) => void;
  setOwner: (runtimeId: string, ownerTabId: string) => void;
  markRefused: (runtimeId: string, reason: RuntimeRefusal) => void;
  forget: (runtimeId: string) => void;
};

function withOwner(
  owners: Record<string, string>,
  runtimeId: string,
  ownerTabId: string | undefined
): Record<string, string> {
  if (!ownerTabId || owners[runtimeId]) return owners;
  return { ...owners, [runtimeId]: ownerTabId };
}

export const useRuntimeTargetsStore = create<RuntimeTargetsState>((set) => ({
  targets: {},
  owners: {},
  refused: {},
  // An owner, once recorded, never changes until the connection is
  // forgotten: a tab that passed the guard for a connection stays the one
  // the dispatch guard checks it against (D3).
  register: (runtimeId, target, ownerTabId) =>
    set((s) => ({
      targets: { ...s.targets, [runtimeId]: target ?? null },
      owners: withOwner(s.owners, runtimeId, ownerTabId),
    })),
  setOwner: (runtimeId, ownerTabId) =>
    set((s) => ({ owners: withOwner(s.owners, runtimeId, ownerTabId) })),
  markRefused: (runtimeId, reason) =>
    set((s) =>
      s.refused[runtimeId] === reason
        ? s
        : { refused: { ...s.refused, [runtimeId]: reason } }
    ),
  forget: (runtimeId) =>
    set((s) => {
      const { [runtimeId]: _t, ...targets } = s.targets;
      const { [runtimeId]: _o, ...owners } = s.owners;
      const { [runtimeId]: _r, ...refused } = s.refused;
      return { targets, owners, refused };
    }),
}));

/** The refusal code carried by a backend error, if it is one. */
export function runtimeRefusalOf(err: unknown): RuntimeRefusal | null {
  const text =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? "");
  // The backend answers with the bare code (an `Error:` prefix may be added
  // on the way); text that merely contains it, such as a database error
  // naming an object "RUNTIME_STALE", is not a refusal.
  const match =
    /^\s*(?:Error:\s*)?(RUNTIME_STALE|RUNTIME_IDENTITY_MISSING)\s*$/.exec(text);
  return (match?.[1] as RuntimeRefusal | undefined) ?? null;
}
