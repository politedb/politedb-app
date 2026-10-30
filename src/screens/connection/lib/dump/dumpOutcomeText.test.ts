import { describe, expect, it } from "vitest";
import {
  BACKUP_CANCELLED_TOAST,
  quietCancelToast,
  RESTORE_CANCELLED_TOAST,
} from "./dumpOutcomeText";

/** Which cancels end with a toast instead of a result to read (D12). */
describe("quietCancelToast", () => {
  const cancelled = (rollback: never, extra: object = {}) =>
    ({ kind: "cancelled", rollback, message: "Cancelled.", ...extra }) as const;

  it("toasts a restore or import cancel known not committed", () => {
    for (const kind of ["restore", "import"] as const) {
      for (const rollback of ["rolled-back", "not-committed-closed"]) {
        expect(quietCancelToast(kind, cancelled(rollback as never))).toBe(
          RESTORE_CANCELLED_TOAST
        );
      }
    }
    expect(RESTORE_CANCELLED_TOAST).toBe(
      "Cancelled. The transaction was not committed."
    );
  });

  it("keeps a restore cancel to read otherwise", () => {
    for (const rollback of ["cleanup-unconfirmed", "nothing-run", "n/a"]) {
      expect(quietCancelToast("restore", cancelled(rollback as never))).toBe(
        null
      );
    }
    expect(
      quietCancelToast(
        "restore",
        cancelled("rolled-back" as never, { failure: "ERROR: boom" })
      )
    ).toBe(null);
    expect(
      quietCancelToast(
        "restore",
        cancelled("not-committed-closed" as never, {
          catalogUnconfirmed: true,
        })
      )
    ).toBe(null);
    // A run stopped outside a transaction (MySQL) is not a cancel.
    expect(
      quietCancelToast("restore", {
        kind: "stopped",
        reason: "user",
        message: "Stopped.",
        counts: { completed: 1, skipped: 0, unknown: 0, total: 2 },
      })
    ).toBe(null);
  });

  it("toasts a backup cancel that wrote nothing, as before", () => {
    expect(quietCancelToast("backup", cancelled("n/a" as never))).toBe(
      BACKUP_CANCELLED_TOAST
    );
    expect(
      quietCancelToast("backup", cancelled("cleanup-unconfirmed" as never))
    ).toBe(null);
    expect(
      quietCancelToast(
        "backup",
        cancelled("n/a" as never, { failure: "permission denied" })
      )
    ).toBe(null);
  });
});
