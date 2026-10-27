import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { GroupsSection } from "./GroupsSection";

const dialogs = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock("src/lib/system-dialog", () => dialogs);

const group = { id: "g1", name: "Team A" } as never;

describe("GroupsSection", () => {
  it("asks to delete the group, not a connection, and keeps it on cancel", async () => {
    const onDeleteGroup = vi.fn();
    render(
      <GroupsSection
        groups={[{ group, count: 2 }]}
        onPickGroup={vi.fn()}
        onDeleteGroup={onDeleteGroup}
      />
    );
    dialogs.confirmDialog.mockResolvedValueOnce(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete group Team A" })
    );
    await waitFor(() => expect(dialogs.confirmDialog).toHaveBeenCalled());
    const [body, options] = dialogs.confirmDialog.mock.calls[0]!;
    expect(body).toBe(
      'Delete the group "Team A"? Its connections are kept and become ungrouped.'
    );
    expect(options).toMatchObject({ title: "Delete group", okLabel: "Delete" });
    expect(onDeleteGroup).not.toHaveBeenCalled();

    dialogs.confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete group Team A" })
    );
    await waitFor(() => expect(onDeleteGroup).toHaveBeenCalledWith("g1"));
  });
});
