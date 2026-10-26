import { fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StandaloneTableExportHost } from "./StandaloneTableExportHost";

const mocks = vi.hoisted(() => ({
  phase: { status: "idle" } as unknown,
  close: vi.fn(),
  retry: vi.fn(),
  showMessage: vi.fn(),
}));

vi.mock("../hooks/useStandaloneTableExport", () => ({
  useStandaloneTableExport: () => ({
    phase: mocks.phase,
    close: mocks.close,
    retry: mocks.retry,
  }),
}));
vi.mock("src/lib/system-dialog", () => ({ showMessage: mocks.showMessage }));

const target = {
  requestId: 1,
  connectionId: "c1",
  schema: "public",
  tableName: "users",
  engine: "postgres",
};

function renderHost() {
  return render(
    <StandaloneTableExportHost
      profileScreenId="t1"
      runtimeConnectionId="c1"
      engine="postgres"
      target={target as never}
      onClearTarget={vi.fn()}
    />
  );
}

beforeEach(() => {
  mocks.close.mockReset();
  mocks.retry.mockReset();
  mocks.showMessage.mockReset();
});

describe("StandaloneTableExportHost", () => {
  it("shows a preparation failure inline and offers to try again", () => {
    mocks.phase = {
      status: "error",
      target,
      message: "permission denied for table users",
    };
    renderHost();
    expect(screen.getByText("public.users")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "permission denied for table users"
    );
    expect(mocks.showMessage).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
