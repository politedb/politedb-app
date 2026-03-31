import posthog from "posthog-js";

type AnalyticsPrimitive = string | number | boolean | null | undefined;
type AnalyticsProps = Record<string, AnalyticsPrimitive>;
export type TelemetryConsent = "granted" | "denied" | "unknown";

const INSTALL_DATE_KEY = "politedb.analytics.install_date";
const LAST_ACTIVE_DATE_KEY = "politedb.analytics.last_active_date";
const SESSION_ID_KEY = "politedb.analytics.session_id";
const CONSENT_KEY = "politedb.analytics.consent";

let initialized = false;

function randomId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {}
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function readOrCreate(key: string) {
  const existed = readStorage(key);
  if (existed) return existed;
  const created = randomId();
  writeStorage(key, created);
  return created;
}

function isoDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function isAnalyticsEnabled() {
  return String(import.meta.env.VITE_ANALYTICS_ENABLED ?? "false") === "true";
}

function shouldDebugAnalytics() {
  return String(import.meta.env.VITE_ANALYTICS_DEBUG ?? "false") === "true";
}

function posthogKey() {
  return String(import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
}

function posthogHost() {
  return String(
    import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com"
  ).trim();
}

function analyticsReady() {
  return isAnalyticsEnabled() && !!posthogKey();
}

function maskSensitiveText(value: string) {
  return value
    .replace(/([A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])*[^\\/\s]+/g, "[masked-path]")
    .replace(/(["'`])(?:\\.|(?!\1).){1,200}\1/g, '"[masked]"')
    .replace(/\b(?:select|insert|update|delete|alter|create|drop|truncate)\b[\s\S]*/i, "[masked-sql]");
}

function sanitizeErrorMessage(value: string) {
  const normalized = maskSensitiveText(value);
  const firstLine = normalized.split("\n")[0] ?? normalized;
  return firstLine.slice(0, 160);
}

function sanitizeProp(key: string, value: AnalyticsPrimitive): AnalyticsPrimitive {
  if (value == null) return value;

  const k = key.toLowerCase();
  if (
    k.includes("path") ||
    k.includes("file") ||
    k === "database" ||
    k === "db" ||
    k === "db_name" ||
    k.includes("host") ||
    k.includes("username") ||
    k === "user" ||
    k === "label"
  ) {
    return "[masked]";
  }

  if (k === "error" && typeof value === "string") {
    return sanitizeErrorMessage(value);
  }

  if (typeof value === "string") {
    return maskSensitiveText(value).slice(0, 160);
  }

  return value;
}

function sanitizeProps(props?: AnalyticsProps) {
  if (!props) return {};
  return Object.fromEntries(
    Object.entries(props).map(([key, value]) => [key, sanitizeProp(key, value)])
  );
}

export function getTelemetryConsent(): TelemetryConsent {
  const value = readStorage(CONSENT_KEY);
  if (value === "granted" || value === "denied") return value;
  return "unknown";
}

export function needsTelemetryConsent() {
  return analyticsReady() && getTelemetryConsent() === "unknown";
}

export function isTelemetryEnabledByUser() {
  return analyticsReady() && getTelemetryConsent() === "granted";
}

export function setTelemetryConsent(consent: Exclude<TelemetryConsent, "unknown">) {
  writeStorage(CONSENT_KEY, consent);
  if (!initialized) {
    initAnalytics();
  }

  if (!analyticsReady()) return;

  if (consent === "granted") {
    trackEvent("analytics_enabled", { source: "privacy_dialog" });
  }
}

export function initAnalytics() {
  if (initialized) return;
  initialized = true;

  if (!analyticsReady()) return;

  posthog.init(posthogKey(), {
    api_host: posthogHost(),
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "localStorage",
    loaded: (client) => {
      if (shouldDebugAnalytics()) {
        client.debug(true);
      }
    },
  });
}

function captureSanitized(event: string, props?: AnalyticsProps) {
  if (!analyticsReady()) return;
  if (!initialized) initAnalytics();
  const sanitized = sanitizeProps(props);

  if (shouldDebugAnalytics()) {
    console.debug("[posthog]", event, sanitized);
  }

  posthog.capture(event, sanitized);
}

export function trackEssentialEvent(event: string, props?: AnalyticsProps) {
  try {
    captureSanitized(event, props);
  } catch {
    // analytics must never break app flows
  }
}

export function trackEvent(event: string, props?: AnalyticsProps) {
  try {
    if (!isTelemetryEnabledByUser()) return;
    captureSanitized(event, props);
  } catch {
    // analytics must never break app flows
  }
}

export function trackAppLifecycle(props?: AnalyticsProps) {
  const sessionId = readOrCreate(SESSION_ID_KEY);
  const today = isoDateOnly();
  const installedAt = readStorage(INSTALL_DATE_KEY);
  const lastActiveAt = readStorage(LAST_ACTIVE_DATE_KEY);

  if (!installedAt) {
    writeStorage(INSTALL_DATE_KEY, today);
    trackEssentialEvent("app_installed", {
      ...props,
      install_date: today,
      session_id: sessionId,
    });
  }

  trackEssentialEvent("app_opened", {
    ...props,
    opened_date: today,
    session_id: sessionId,
  });

  if (lastActiveAt !== today) {
    writeStorage(LAST_ACTIVE_DATE_KEY, today);
    trackEssentialEvent("app_active_daily", {
      ...props,
      active_date: today,
      session_id: sessionId,
    });
  }
}

export function detectSqlKind(sql: string) {
  const token = String(sql ?? "")
    .trimStart()
    .split(/\s+/, 1)[0]
    ?.toUpperCase();

  return token || "UNKNOWN";
}
