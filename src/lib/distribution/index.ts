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
  /** Engines hidden from the new-connection picker in this flavor. */
  unsupportedEngines: readonly DatabaseEngine[];
  /**
   * Sandboxed: user files are reachable only through grants made in the backend
   * pickers (`src/lib/file-access`), so file paths cannot be typed.
   */
  fileGrants: boolean;
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
      unsupportedEngines: ["oracle"],
      fileGrants: true,
    };
  }
  return {
    selfUpdate: true,
    externalPurchase: true,
    unsupportedEngines: [],
    fileGrants: false,
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
