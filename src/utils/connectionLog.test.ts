import { describe, expect, it } from "vitest";
import type { ConnectionOpenLogEntry } from "src/types";
import {
  collapseRepeatedSessions,
  connectionLogDisplayStatus,
  filterSessionsByStatus,
  formatSessionDuration,
  formatSessionTime,
  groupRowsByDay,
  hasSeveralDevices,
  sessionDayLabel,
  splitSessionTarget,
  truncateMiddle,
} from "./connectionLog";

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();
const NOW = at(2026, 10, 21, 12, 0);

let seq = 0;
function session(
  over: Partial<ConnectionOpenLogEntry> = {}
): ConnectionOpenLogEntry {
  seq += 1;
  return {
    id: `s${seq}`,
    tabId: `t${seq}`,
    profileId: "p1",
    profileLabel: "Prod",
    engine: "postgres",
    host: "db:5432 • app",
    deviceName: "macbook.local",
    openedAt: at(2026, 10, 21, 10, 0),
    closedAt: at(2026, 10, 21, 10, 0, 20),
    status: "closed",
    ...over,
  };
}

describe("connectionLogDisplayStatus", () => {
  it("tells open sessions from finished ones", () => {
    expect(connectionLogDisplayStatus("active")).toBe("open");
    expect(connectionLogDisplayStatus("closed")).toBe("success");
    expect(connectionLogDisplayStatus("failed")).toBe("failed");
  });
});

describe("session time and duration", () => {
  it("shows the start time", () => {
    expect(formatSessionTime(at(2026, 10, 21, 9, 5))).toBe("09:05");
  });

  it.each([
    [0, "< 1 min"],
    [59_000, "< 1 min"],
    [3 * 60_000, "3 min"],
    [60 * 60_000, "1 h"],
    [65 * 60_000, "1 h 5 min"],
    [26 * 3600_000, "1 d 2 h"],
    [48 * 3600_000, "2 d"],
  ])("formats %i ms as %s", (ms, text) => {
    expect(formatSessionDuration(1000, 1000 + ms, NOW)).toBe(text);
  });

  it("measures an open session up to now", () => {
    expect(formatSessionDuration(NOW - 12 * 60_000, undefined, NOW)).toBe(
      "12 min"
    );
  });
});

describe("sessionDayLabel", () => {
  it("names today, yesterday, then dates", () => {
    expect(sessionDayLabel(at(2026, 10, 21, 0, 1), NOW)).toBe("Today");
    expect(sessionDayLabel(at(2026, 10, 20, 23, 59), NOW)).toBe("Yesterday");
    expect(sessionDayLabel(at(2026, 10, 19, 8), NOW)).toBe("Mon, Oct 19");
    expect(sessionDayLabel(at(2025, 12, 31, 8), NOW)).toBe("Dec 31, 2025");
  });
});

describe("collapseRepeatedSessions", () => {
  it("folds back-to-back short identical sessions", () => {
    const a = session({ openedAt: at(2026, 10, 21, 10, 45) });
    a.closedAt = a.openedAt + 5_000;
    const b = session({ openedAt: at(2026, 10, 21, 10, 44) });
    b.closedAt = b.openedAt + 5_000;
    const rows = collapseRepeatedSessions([a, b]);
    expect(rows).toEqual([{ entry: a, count: 2 }]);
  });

  it("keeps sessions apart when anything differs", () => {
    const base = {
      openedAt: at(2026, 10, 21, 10),
      closedAt: at(2026, 10, 21, 10, 0, 5),
    };
    const long = session({ ...base, closedAt: at(2026, 10, 21, 10, 5) });
    const other = session({ ...base, profileId: "p2" });
    const failed = session({ ...base, status: "failed", error: "x" });
    const failedOther = session({ ...base, status: "failed", error: "y" });
    const open = session({ ...base, status: "active", closedAt: undefined });
    const plain = session(base);
    const yesterday = session({
      openedAt: at(2026, 10, 20, 10),
      closedAt: at(2026, 10, 20, 10, 0, 5),
    });
    const rows = collapseRepeatedSessions([
      long,
      plain,
      other,
      failed,
      failedOther,
      open,
      session(base),
      yesterday,
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("groupRowsByDay", () => {
  it("splits rows into labelled days, keeping order", () => {
    const today = session({ openedAt: at(2026, 10, 21, 9) });
    const today2 = session({ openedAt: at(2026, 10, 21, 8) });
    const older = session({ openedAt: at(2026, 10, 19, 8) });
    const days = groupRowsByDay(
      [today, today2, older].map((entry) => ({ entry, count: 1 })),
      NOW
    );
    expect(days.map((d) => [d.label, d.rows.length])).toEqual([
      ["Today", 2],
      ["Mon, Oct 19", 1],
    ]);
  });
});

describe("targets", () => {
  it("shortens the host in the middle and keeps the database", () => {
    const host =
      "politedb-e1d055c7.pgwss41fhn25j4kyr6drcww6g.c0.ap-southeast-1.aws.pg.clickhouse.cloud:5432 • saltabo";
    const { address, database } = splitSessionTarget(host);
    expect(database).toBe("saltabo");
    const short = truncateMiddle(address, 40);
    expect(short).toHaveLength(40);
    expect(short.startsWith("politedb-e1d05")).toBe(true);
    expect(short.endsWith("clickhouse.cloud:5432")).toBe(true);
    expect(short).toContain("…");
    expect(truncateMiddle("short", 40)).toBe("short");
    expect(splitSessionTarget("/tmp/app.db")).toEqual({
      address: "/tmp/app.db",
      database: "",
    });
  });
});

describe("filters", () => {
  const open = session({ status: "active", closedAt: undefined });
  const failed = session({ status: "failed" });
  const ok = session();

  it("filters by status", () => {
    expect(filterSessionsByStatus([open, failed, ok], "all")).toHaveLength(3);
    expect(filterSessionsByStatus([open, failed, ok], "open")).toEqual([open]);
    expect(filterSessionsByStatus([open, failed, ok], "failed")).toEqual([
      failed,
    ]);
  });

  it("knows whether several devices are logged", () => {
    expect(hasSeveralDevices([ok, failed])).toBe(false);
    expect(hasSeveralDevices([ok, session({ deviceName: "work-pc" })])).toBe(
      true
    );
    expect(hasSeveralDevices([])).toBe(false);
  });
});
