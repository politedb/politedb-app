import { describe, expect, it } from "vitest";
import { featuresFor, isEngineSupported, parseDistribution } from "./index";

describe("parseDistribution", () => {
  it("treats the standard Vite modes as the direct build", () => {
    expect(parseDistribution(undefined)).toBe("direct");
    expect(parseDistribution("production")).toBe("direct");
    expect(parseDistribution("development")).toBe("direct");
    expect(parseDistribution("test")).toBe("direct");
  });

  it("recognizes only the exact appstore mode", () => {
    expect(parseDistribution("appstore")).toBe("appstore");
    expect(parseDistribution("AppStore")).toBe("direct");
  });
});

describe("featuresFor", () => {
  it("keeps every feature in the direct flavor", () => {
    const features = featuresFor("direct");
    expect(features.selfUpdate).toBe(true);
    expect(features.externalPurchase).toBe(true);
    expect(features.gatesProFeatures).toBe(true);
    expect(features.websiteLinks).toBe(true);
    expect(isEngineSupported("oracle", features)).toBe(true);
  });

  it("disables updater, external purchase and Oracle on the App Store", () => {
    const features = featuresFor("appstore");
    expect(features.selfUpdate).toBe(false);
    expect(features.externalPurchase).toBe(false);
    expect(features.gatesProFeatures).toBe(false);
    expect(features.websiteLinks).toBe(false);
    expect(isEngineSupported("oracle", features)).toBe(false);
    expect(isEngineSupported("postgres", features)).toBe(true);
  });
});
