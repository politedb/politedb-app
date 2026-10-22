import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { Dialog } from "src/components/common/Dialog";
import { SessionActions } from "./SessionActions";

const both = {
  cancel: true,
  terminate: true,
  ownedByThisApp: false,
  reason: null,
};

function open() {
  const trigger = screen.getByRole("button", { name: "Actions for PID 42" });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  return trigger;
}

describe("SessionActions", () => {
  it("labels this app's sessions instead of offering actions", () => {
    render(
      <SessionActions
        pid={42}
        eligibility={{
          ...both,
          cancel: false,
          terminate: false,
          ownedByThisApp: true,
        }}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    expect(screen.getByText("This app")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains why nothing is offered", () => {
    render(
      <SessionActions
        pid={42}
        eligibility={{
          cancel: false,
          terminate: false,
          ownedByThisApp: false,
          reason: "Session has no application name",
        }}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    expect(
      screen.getByRole("img", { name: "Session has no application name" })
    ).toBeTruthy();
  });

  it("opens a named menu, focuses the first item and moves with arrows", () => {
    const onAction = vi.fn();
    render(
      <SessionActions
        pid={42}
        eligibility={both}
        disabled={false}
        onAction={onAction}
      />
    );
    const trigger = open();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    const [cancelItem, terminateItem] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(cancelItem);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(terminateItem);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cancelItem);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(terminateItem);
    fireEvent.click(terminateItem!);
    expect(onAction).toHaveBeenCalledWith("terminate");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not offer Cancel for sessions that are not running a query", () => {
    const onAction = vi.fn();
    render(
      <SessionActions
        pid={42}
        eligibility={{ ...both, cancel: false }}
        disabled={false}
        onAction={onAction}
      />
    );
    open();
    const cancelItem = screen.getByRole("menuitem", { name: /Cancel query/ });
    expect(cancelItem.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancelItem);
    expect(onAction).not.toHaveBeenCalled();
    // Focus starts on the first enabled item.
    expect(document.activeElement?.textContent).toBe("Terminate session");
  });

  it("closes on Escape without closing the surrounding dialog", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        <SessionActions
          pid={42}
          eligibility={both}
          disabled={false}
          onAction={vi.fn()}
        />
      </Dialog>
    );
    const trigger = open();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab and while disabled does not open", () => {
    const { rerender } = render(
      <SessionActions
        pid={42}
        eligibility={both}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    const opener = open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    // Tab continues from the row's trigger, not from the end of the page.
    expect(document.activeElement).toBe(opener);

    rerender(
      <SessionActions
        pid={42}
        eligibility={both}
        disabled
        disabledReason="Waiting for the session action"
        onAction={vi.fn()}
      />
    );
    const trigger = screen.getByRole("button", { name: "Actions for PID 42" });
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("hands focus back when its row disappears", () => {
    const onFocusLost = vi.fn();
    const { unmount } = render(
      <SessionActions
        pid={42}
        eligibility={both}
        disabled={false}
        onAction={vi.fn()}
        onFocusLost={onFocusLost}
      />
    );
    act(() =>
      screen.getByRole("button", { name: "Actions for PID 42" }).focus()
    );
    unmount();
    expect(onFocusLost).toHaveBeenCalledTimes(1);
  });
});
