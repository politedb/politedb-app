import posthog from "posthog-js";

type AnalyticsPrimitive = string | number | boolean | null | undefined;
type AnalyticsProps = Record<string, AnalyticsPrimitive>;
export type TelemetryConsent = "granted" | "denied" | "unknown";

const INSTALL_DATE_KEY = "politedb.analytics.install_date";
const LAST_ACTIVE_DATE_KEY = "politedb.analytics.last_active_date";
const SESSION_ID_KEY = "politedb.analytics.session_id";
const CONSENT_KEY = "politedb.analytics.consent";

let initialized = false;
let navigationListenersInstalled = false;
let currentScreenPath = "";

type ScrollMetrics = {
  maxScrollPercentage: number;
  maxScrollPixels: number;
  lastScrollPercentage: number;
  lastScrollPixels: number;
  scrolled: boolean;
};

let scrollMetrics: ScrollMetrics = {
  maxScrollPercentage: 0,
  maxScrollPixels: 0,
  lastScrollPercentage: 0,
  lastScrollPixels: 0,
  scrolled: false,
};

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
    .replace(
      /\b(?:select|insert|update|delete|alter|create|drop|truncate)\b[\s\S]*/i,
      "[masked-sql]"
    );
}

/** Error categories analytics may report; checked in order, first match wins. */
const ERROR_KINDS: ReadonlyArray<[string, RegExp]> = [
  ["cancelled", /\b(cancel(l)?ed|aborted|abort)\b/i],
  ["timeout", /time(d)?[ -]?out|deadline exceeded/i],
  [
    "auth_failed",
    /authenticat|password|access denied|login failed|invalid credentials|unauthori[sz]ed|\b401\b/i,
  ],
  [
    "permission_denied",
    /permission denied|not authori[sz]ed|insufficient privilege|forbidden|\b403\b/i,
  ],
  ["tls", /\b(ssl|tls)\b|certificate|handshake/i],
  [
    "host_not_found",
    /could not translate host|unknown host|name or service not known|nodename nor servname|no such host|getaddrinfo|dns/i,
  ],
  [
    "connection_refused",
    /connection refused|econnrefused|could not connect|can't connect|unable to connect/i,
  ],
  [
    "network",
    /connection (reset|closed|lost|aborted)|broken pipe|network|unreachable|econnreset|socket/i,
  ],
  ["too_many_connections", /too many (connections|clients)/i],
  [
    "database_not_found",
    /database .*(does not exist|not found)|unknown database/i,
  ],
  [
    "object_not_found",
    /does not exist|not found|no such (table|column)|unknown (table|column)|invalid object name/i,
  ],
  ["syntax_error", /syntax|parse error|unexpected token/i],
  [
    "constraint_violation",
    /constraint|duplicate key|unique|foreign key|violat/i,
  ],
  ["read_only", /read[- ]only/i],
  ["keychain", /keychain|credential store/i],
  ["ssh", /\bssh\b|tunnel/i],
  ["out_of_resources", /out of memory|disk full|no space left|resource/i],
  ["unsupported", /not supported|unsupported|not implemented/i],
];

/**
 * A fixed category for an error message ("timeout", "auth_failed", …), so the
 * message itself is never sent; "other" when nothing matches.
 */
export function classifyErrorMessage(message: string): string {
  const text = String(message ?? "");
  if (!text.trim()) return "other";
  for (const [kind, pattern] of ERROR_KINDS) {
    if (pattern.test(text)) return kind;
  }
  return "other";
}

function sanitizeProp(
  key: string,
  value: AnalyticsPrimitive
): AnalyticsPrimitive {
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

  // Statement kinds come from detectSqlKind's allowlist; anything else is
  // reported as OTHER rather than masked into a useless placeholder.
  if (k === "sql_kind" && typeof value === "string") {
    return SQL_KINDS.has(value) || value === "UNKNOWN" ? value : "OTHER";
  }

  // Errors leave the device only as a fixed category, never their text: a
  // driver message can carry hosts, users, table names or row values.
  if (k.includes("error") && typeof value === "string") {
    return classifyErrorMessage(value);
  }

  if (typeof value === "string") {
    return maskSensitiveText(value).slice(0, 160);
  }

  return value;
}

/** Exported for tests: what every event property becomes before sending. */
export function sanitizeProps(props?: AnalyticsProps) {
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

export function setTelemetryConsent(
  consent: Exclude<TelemetryConsent, "unknown">
) {
  writeStorage(CONSENT_KEY, consent);
  if (!initialized) {
    initAnalytics();
  }

  if (!analyticsReady()) return;

  syncNavigationCapture();

  if (consent === "granted") {
    trackEvent("analytics_enabled", { source: "privacy_dialog" });
  }
}

function screenPathFromId(screenId: string) {
  if (!screenId || screenId === "main") return "/main";
  if (screenId.startsWith("tab-")) return `/connection/${screenId}`;
  return `/${screenId}`;
}

function screenUrl(path: string) {
  return `politedb://${path.replace(/^\//, "")}`;
}

function resetScrollMetrics() {
  scrollMetrics = {
    maxScrollPercentage: 0,
    maxScrollPixels: 0,
    lastScrollPercentage: 0,
    lastScrollPixels: 0,
    scrolled: false,
  };
}

function readScrollMetricsFromTarget(target: EventTarget | null) {
  const el =
    target instanceof Element
      ? target
      : (document.scrollingElement ?? document.documentElement);

  const scrollHeight = Math.max(
    el.scrollHeight,
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );
  const viewport =
    el.clientHeight ||
    window.innerHeight ||
    document.documentElement.clientHeight;
  const scrollTop =
    el === document.documentElement || el === document.body
      ? window.scrollY
      : (el as HTMLElement).scrollTop;

  const lastPixels = Math.max(0, scrollTop + viewport);
  const lastPercentage =
    scrollHeight > 0 ? Math.min(1, lastPixels / scrollHeight) : 0;

  return { lastPixels, lastPercentage };
}

function updateScrollMetrics(target: EventTarget | null) {
  const { lastPixels, lastPercentage } = readScrollMetricsFromTarget(target);
  scrollMetrics.lastScrollPixels = lastPixels;
  scrollMetrics.lastScrollPercentage = lastPercentage;
  if (lastPixels > 0) scrollMetrics.scrolled = true;
  if (lastPercentage > scrollMetrics.maxScrollPercentage) {
    scrollMetrics.maxScrollPercentage = lastPercentage;
  }
  if (lastPixels > scrollMetrics.maxScrollPixels) {
    scrollMetrics.maxScrollPixels = lastPixels;
  }
}

function scrollDepthProps() {
  return {
    $prev_pageview_max_scroll_percentage: scrollMetrics.maxScrollPercentage,
    $prev_pageview_max_content: scrollMetrics.maxScrollPixels,
    $prev_pageview_last_scroll_percentage: scrollMetrics.lastScrollPercentage,
    $prev_pageview_last_content: scrollMetrics.lastScrollPixels,
    "max scroll percentage": scrollMetrics.maxScrollPercentage,
    "max scroll pixels": scrollMetrics.maxScrollPixels,
    "last scroll percentage": scrollMetrics.lastScrollPercentage,
    "last scroll pixels": scrollMetrics.lastScrollPixels,
    scrolled: scrollMetrics.scrolled,
  };
}

function capturePageleave(path: string) {
  if (!isTelemetryEnabledByUser()) return;
  posthog.capture("$pageleave", {
    $current_url: screenUrl(path),
    $pathname: path,
    ...scrollDepthProps(),
  });
}

export function trackScreenView(screenId: string, props?: AnalyticsProps) {
  if (!isTelemetryEnabledByUser()) return;
  if (!initialized) initAnalytics();

  const path = screenPathFromId(screenId);
  if (path === currentScreenPath) return;

  if (navigationListenersInstalled && currentScreenPath) {
    capturePageleave(currentScreenPath);
  }

  currentScreenPath = path;
  resetScrollMetrics();

  posthog.capture("$pageview", {
    $current_url: screenUrl(path),
    $pathname: path,
    title: screenId === "main" ? "Home" : "Connection",
    ...sanitizeProps(props),
  });
}

function installNavigationListeners() {
  if (navigationListenersInstalled || typeof window === "undefined") return;
  navigationListenersInstalled = true;

  const onScroll = (event: Event) => {
    if (!isTelemetryEnabledByUser()) return;
    updateScrollMetrics(event.target);
  };

  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  document.addEventListener("scroll", onScroll, {
    passive: true,
    capture: true,
  });

  const onPageHide = () => {
    capturePageleave(currentScreenPath);
  };

  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      capturePageleave(currentScreenPath);
    }
  });
}

export function syncNavigationCapture() {
  if (!analyticsReady() || !initialized) return;

  const enabled = isTelemetryEnabledByUser();

  posthog.set_config({
    capture_pageview: enabled,
    capture_pageleave: enabled,
  });

  if (!enabled) return;

  installNavigationListeners();
  trackScreenView("main");
}

export function initAnalytics() {
  if (initialized) return;
  initialized = true;

  if (!analyticsReady()) return;

  posthog.init(posthogKey(), {
    api_host: posthogHost(),
    defaults: "2026-01-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    persistence: "localStorage",
    loaded: (client) => {
      // Stable anonymous id so DAU/WAU count the same install across sessions.
      client.identify(readOrCreate(SESSION_ID_KEY));
      if (shouldDebugAnalytics()) {
        client.debug(true);
      }
      syncNavigationCapture();
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

/** Statement kinds analytics may report; anything else is "OTHER". */
const SQL_KINDS = new Set([
  "SELECT",
  "WITH",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "REPLACE",
  "VALUES",
  "TABLE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
  "GRANT",
  "REVOKE",
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "SHOW",
  "USE",
  "SET",
  "RESET",
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "CALL",
  "EXEC",
  "EXECUTE",
  "DO",
  "DECLARE",
  "PREPARE",
  "DEALLOCATE",
  "PRAGMA",
  "ANALYZE",
  "VACUUM",
  "REINDEX",
  "REFRESH",
  "OPTIMIZE",
  "COPY",
  "UNLOAD",
  "LOCK",
  "ATTACH",
  "DETACH",
  "LISTEN",
  "NOTIFY",
  "KILL",
]);

/**
 * The kind of statement, for analytics only. Leading comments are skipped and
 * only known keywords are reported, so nothing the user typed (a comment, a
 * table name) can leave the device this way.
 */
export function detectSqlKind(sql: string) {
  let text = String(sql ?? "");
  for (;;) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("--")) {
      const end = trimmed.indexOf("\n");
      text = end < 0 ? "" : trimmed.slice(end + 1);
    } else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      text = end < 0 ? "" : trimmed.slice(end + 2);
    } else {
      text = trimmed;
      break;
    }
  }
  const token = /^[A-Za-z]+/.exec(text)?.[0]?.toUpperCase();
  if (!token) return "UNKNOWN";
  return SQL_KINDS.has(token) ? token : "OTHER";
}
