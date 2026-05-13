import type { TableRowState } from "src/stores/connection";

/** Percent of the current row window received. Keeps moving while rows stream. */
export function tableRowsStreamLoadPercent(
  st: Pick<
    TableRowState,
    "streamOffset" | "cap" | "loadedMax" | "running" | "startedAt"
  >,
  rowCount: number | null | undefined,
  now = Date.now()
): number {
  const { streamOffset, cap, loadedMax } = st;
  const safeCap = Math.max(1, cap);
  let total = safeCap;

  if (
    typeof rowCount === "number" &&
    Number.isFinite(rowCount) &&
    rowCount >= 0
  ) {
    total = Math.min(safeCap, Math.max(1, rowCount - streamOffset));
  }

  const received =
    loadedMax < streamOffset
      ? 0
      : Math.min(loadedMax - streamOffset + 1, total);
  const rowPercent = (received / total) * 100;

  const elapsedMs =
    typeof st.startedAt === "number" ? Math.max(0, now - st.startedAt) : 0;
  const trickleCap = received > 0 ? 95 : 18;
  const tricklePercent =
    received > 0
      ? Math.min(trickleCap, 20 + elapsedMs / 250)
      : Math.min(trickleCap, 1 + elapsedMs / 150);

  return Math.min(
    st.running ? 99 : 100,
    Math.max(0, Math.round(Math.max(rowPercent, tricklePercent)))
  );
}
