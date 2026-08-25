import { fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RightNav } from "./RightNav";

const TABLE_KEY = "sqlite:test:messages";
const mocks = vi.hoisted(() => ({ commit: vi.fn() }));

vi.mock("src/stores/connection", () => ({
  useConnectionStore: (
    selector: (state: {
      rowFieldEditHandlerByKey: Record<string, typeof mocks.commit>;
    }) => unknown
  ) =>
    selector({
      rowFieldEditHandlerByKey: { [TABLE_KEY]: mocks.commit },
    }),
}));

function renderField(field: { name: string; value: string; isNull?: boolean }) {
  render(
    <RightNav
      sizeInfo={null}
      tableLoadKey={TABLE_KEY}
      selectedRowDetail={{ rowIndex: 4, fields: [field] }}
    />
  );
}

beforeEach(() => {
  mocks.commit.mockReset();
});

describe("RightNav row editor", () => {
  it("does not patch a SQLite NULL field that only receives focus", () => {
    renderField({ name: "otp", value: "", isNull: true });

    const input = screen.getByPlaceholderText("NULL");
    fireEvent.focus(input);
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);

    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("commits a field changed from the right navigation", () => {
    renderField({ name: "seen", value: "0" });

    const input = screen.getByDisplayValue("0");
    fireEvent.input(input, { target: { value: "1" } });
    fireEvent.pointerDown(document.body);
    fireEvent.blur(input);

    expect(mocks.commit).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledWith(4, "seen", "1");
  });

  it("does not patch a field returned to its original value", () => {
    renderField({ name: "subject", value: "hello" });

    const input = screen.getByDisplayValue("hello");
    fireEvent.input(input, { target: { value: "changed" } });
    fireEvent.input(input, { target: { value: "hello" } });
    fireEvent.blur(input);

    expect(mocks.commit).not.toHaveBeenCalled();
  });
});
