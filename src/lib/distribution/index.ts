import type { DatabaseEngine } from "src/types";

/**
 * Build flavor. Mirrors the Rust `app-store` Cargo feature. The frontend flavor is the
 * Vite mode (`vite build --mode appstore`), which `tauri.appstore.conf.json` pins via
 * `beforeBuildCommand`, so the MAS Tauri config always ships the MAS frontend.
 */
export type Distribution = "direct" | "appstore";

export type DistributionFeatures = {
  /** In-app updater (not allowed on the Mac App Store). */
  selfUpdate: boolean;
  /** Links/buttons that send users to buy outside the App Store. */
  externalPurchase: boolean;
  /** Pro features need a license or trial (App Store keeps them unlocked until IAP). */
  gatesProFeatures: boolean;
  /** Free trial recorded by the license server (none on the App Store). */
  serverTrial: boolean;
  /** Engines hidden from the new-connection picker in this flavor. */
  unsupportedEngines: readonly DatabaseEngine[];
};

export const APP_STORE_MODE = "appstore";

/** Maps a Vite mode to a flavor; every mode other than `appstore` is the direct build. */
export function parseDistribution(mode: string | undefined): Distribution {
  return mode === APP_STORE_MODE ? "appstore" : "direct";
}

export function featuresFor(distribution: Distribution): DistributionFeatures {
  if (distribution === "appstore") {
    return {
      selfUpdate: false,
      externalPurchase: false,
      gatesProFeatures: false,
      serverTrial: false,
      unsupportedEngines: ["oracle"],
    };
  }
  return {
    selfUpdate: true,
    externalPurchase: true,
    gatesProFeatures: true,
    serverTrial: true,
    unsupportedEngines: [],
  };
}

export const DISTRIBUTION: Distribution = parseDistribution(
  import.meta.env.MODE
);

export const DISTRIBUTION_FEATURES: DistributionFeatures =
  featuresFor(DISTRIBUTION);

export function isEngineSupported(
  engine: DatabaseEngine,
  features: DistributionFeatures = DISTRIBUTION_FEATURES
) {
  return !features.unsupportedEngines.includes(engine);
}
