/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ANALYTICS_ENABLED?: string;
  readonly VITE_ANALYTICS_DEBUG?: string;
  readonly VITE_POSTHOG_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
  readonly VITE_POLITEDB_API_BASE?: string;
  readonly VITE_LICENSE_PRODUCT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
