import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "src/lib/tauri/types";
import type { AiProviderConfig } from "src/types";
import { keychainDisplay, sortKeychainKeys } from "./display";

const anthropic: AiProviderConfig = {
  id: "anthropic-1",
  kind: "anthropic",
  label: "My Claude",
  defaultModel: "claude-opus-5-5",
  apiKeyRef: "politedb:ai:anthropic-1:api_key",
  enabled: true,
};

const PROFILE_ID = "0f1e2d3c-aaaa-bbbb-cccc-111122223333";
const OTHER_ID = "0f1e2d3c-aaaa-bbbb-cccc-444455556666";
const profile = (id: string, host: string) =>
  ({
    id,
    engine: "postgres",
    label: "Prod DB",
    input: {
      engine: "postgres",
      label: "Prod DB",
      tags: [],
      postgres: { host, port: 5432, user: "app", database: "shop" },
      ssh: { ssh_host: "bastion.example", ssh_port: 2222, ssh_user: "ops" },
    },
  }) as unknown as ConnectionProfile;

const dbKey = (id: string) => `politedb/profile/${id}/credential/database`;

describe("keychainDisplay", () => {
  it("names AI keys by provider, with the default model", () => {
    expect(
      keychainDisplay(anthropic.apiKeyRef!, { aiProviders: [anthropic] })
    ).toEqual({
      title: "My Claude",
      badge: "AI key",
      detail: "claude-opus-5-5",
      icon: { kind: "ai" },
      unused: false,
    });

    const unnamed = keychainDisplay(anthropic.apiKeyRef!, {
      aiProviders: [{ ...anthropic, label: " ", defaultModel: "" }],
    });
    expect(unnamed.title).toBe("Anthropic");
    expect(unnamed.detail).toBe("No default model");
  });

  it("marks AI keys whose provider was removed as unused", () => {
    expect(keychainDisplay("politedb:ai:gone:api_key")).toMatchObject({
      title: "Unused AI key",
      badge: "AI key",
      unused: true,
    });
  });

  it("names connection secrets by connection, with the engine and target", () => {
    const sources = { profiles: [profile(PROFILE_ID, "db.internal")] };

    expect(keychainDisplay(dbKey(PROFILE_ID.toUpperCase()), sources)).toEqual({
      title: "Prod DB",
      badge: "PostgreSQL",
      detail: "db.internal:5432 • shop",
      icon: { kind: "database", engine: "postgres" },
      unused: false,
    });

    expect(
      keychainDisplay(`politedb/profile/${PROFILE_ID}/credential/ssh`, sources)
    ).toEqual({
      title: "Prod DB",
      badge: "SSH",
      detail: "ops@bastion.example:2222",
      icon: { kind: "ssh" },
      unused: false,
    });
  });

  it("tells apart connections that share a name", () => {
    const sources = {
      profiles: [
        profile(PROFILE_ID, "db.internal"),
        profile(OTHER_ID, "replica.internal"),
      ],
    };
    const a = keychainDisplay(dbKey(PROFILE_ID), sources);
    const b = keychainDisplay(dbKey(OTHER_ID), sources);

    expect(a.title).toBe(b.title);
    expect(a.detail).not.toBe(b.detail);
  });

  it("marks connection secrets without a connection as unused", () => {
    expect(keychainDisplay(dbKey("missing"))).toMatchObject({
      title: "Unused connection key",
      badge: "Database",
      unused: true,
    });
  });

  it("keeps the previous names for other keys", () => {
    expect(keychainDisplay("my-custom-key")).toEqual({
      title: "my-custom-key",
      badge: "",
      detail: "",
      icon: { kind: "key" },
      unused: false,
    });
  });
});

describe("sortKeychainKeys", () => {
  // Raw ids run opposite to the names: "zulu" is stored under the smallest id.
  const zulu = { ...profile(PROFILE_ID, "z.internal"), label: "Zulu" };
  const alpha = { ...profile(OTHER_ID, "a.internal"), label: "alpha" };
  const sources = { profiles: [zulu, alpha] } as const;
  const keys = [dbKey(PROFILE_ID), dbKey(OTHER_ID), "politedb:ai:gone:api_key"];
  const displays = new Map(keys.map((k) => [k, keychainDisplay(k, sources)]));
  const titles = (sorted: string[]) =>
    sorted.map((k) => displays.get(k)!.title);

  it("orders A-Z and Z-A by the displayed name, ignoring case", () => {
    expect(titles(sortKeychainKeys(keys, displays, "label-asc"))).toEqual([
      "alpha",
      "Unused AI key",
      "Zulu",
    ]);
    expect(titles(sortKeychainKeys(keys, displays, "label-desc"))).toEqual([
      "Zulu",
      "Unused AI key",
      "alpha",
    ]);
  });

  it("breaks ties by kind, target and finally the raw key", () => {
    const same = [
      dbKey(OTHER_ID),
      `politedb/profile/${PROFILE_ID}/credential/ssh`,
      dbKey(PROFILE_ID),
    ];
    const twins = {
      profiles: [
        profile(PROFILE_ID, "b.internal"),
        profile(OTHER_ID, "a.internal"),
      ],
    };
    const d = new Map(same.map((k) => [k, keychainDisplay(k, twins)]));
    expect(sortKeychainKeys(same, d, "label-asc")).toEqual([
      dbKey(OTHER_ID), // PostgreSQL, a.internal
      dbKey(PROFILE_ID), // PostgreSQL, b.internal
      `politedb/profile/${PROFILE_ID}/credential/ssh`, // SSH
    ]);
  });
});
