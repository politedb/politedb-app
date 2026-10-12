import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "src/lib/tauri/types";
import type { AiProviderConfig } from "src/types";
import { keychainDisplay } from "./display";

const anthropic: AiProviderConfig = {
  id: "anthropic-1",
  kind: "anthropic",
  label: "My Claude",
  defaultModel: "claude-opus-5-5",
  apiKeyRef: "politedb:ai:anthropic-1:api_key",
  enabled: true,
};

const PROFILE_ID = "0f1e2d3c-aaaa-bbbb-cccc-111122223333";
const profile = {
  id: PROFILE_ID,
  engine: "postgres",
  label: "Prod DB",
} as ConnectionProfile;

describe("keychainDisplay", () => {
  it("names AI keys credential/<provider kind> with the default model", () => {
    expect(
      keychainDisplay("politedb:ai:anthropic-1:api_key", {
        aiProviders: [anthropic],
      })
    ).toEqual({ title: "credential/anthropic", subtitle: "claude-opus-5-5" });
    expect(
      keychainDisplay("politedb:ai:anthropic-1:api_key", {
        aiProviders: [{ ...anthropic, defaultModel: "" }],
      }).subtitle
    ).toBe("No default model");
  });

  it("marks AI keys whose provider was removed", () => {
    expect(keychainDisplay("politedb:ai:gone:api_key")).toEqual({
      title: "credential/ai",
      subtitle: "Unused AI key",
    });
  });

  it("names connection secrets credential/<engine> with the connection name", () => {
    const sources = { profiles: [profile] };
    expect(
      keychainDisplay(
        `politedb/profile/${PROFILE_ID.toUpperCase()}/credential/database`,
        sources
      )
    ).toEqual({ title: "credential/postgres", subtitle: "Prod DB" });
    expect(
      keychainDisplay(`politedb/profile/${PROFILE_ID}/credential/ssh`, sources)
    ).toEqual({ title: "credential/ssh", subtitle: "Prod DB" });
    expect(
      keychainDisplay("politedb/profile/missing/credential/database", sources)
    ).toEqual({
      title: "credential/database",
      subtitle: "Unused connection key",
    });
  });

  it("keeps the previous names for other keys", () => {
    expect(keychainDisplay("my-custom-key")).toEqual({
      title: "my-custom-key",
      subtitle: "my-custom-key",
    });
  });
});
