import { h } from "preact";
import { useState } from "preact/hooks";
import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "./TagInput";

function Harness(props: {
  initial?: string[];
  suggestions?: string[];
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState(props.initial ?? []);
  return h(TagInput, {
    value: tags,
    suggestions: props.suggestions ?? ["local", "dev", "staging", "production"],
    onChange: (next) => {
      setTags(next);
      props.onChange?.(next);
    },
  });
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const onChange = vi.fn();
  render(h(Harness, { ...props, onChange }));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { input, onChange };
}

const optionTexts = () =>
  screen.queryAllByRole("option").map((o) => o.textContent);

describe("TagInput", () => {
  it("lists the suggestions when focused, without highlighting one", () => {
    const { input } = setup();
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.focus(input);

    expect(optionTexts()).toEqual(["local", "dev", "staging", "production"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("offers Create Tag for typed text first, then matching suggestions", () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "Pro d" } });

    // Typed text is normalized like any tag.
    expect(optionTexts()).toEqual(["Create Tag pro-d"]);

    fireEvent.input(input, { target: { value: "d" } });
    expect(optionTexts()).toEqual(["Create Tag d", "dev", "production"]);
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected")
    ).toBe("true");
  });

  it("hides Create Tag when the text matches a suggestion or an added tag", () => {
    const { input } = setup({ initial: ["qa"] });
    fireEvent.focus(input);

    fireEvent.input(input, { target: { value: "dev" } });
    expect(optionTexts()).toEqual(["dev"]);

    fireEvent.input(input, { target: { value: "qa" } });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("adds the typed tag with Enter or a comma, as before", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);

    fireEvent.input(input, { target: { value: "dsa" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["dsa"]);
    expect(input.value).toBe("");

    fireEvent.input(input, { target: { value: "qa" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenLastCalledWith(["dsa", "qa"]);
  });

  it("puts an exact suggestion first and highlights it", () => {
    const { input, onChange } = setup({
      suggestions: ["devops", "dev", "staging"],
    });
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "dev" } });

    expect(optionTexts()).toEqual(["dev", "devops"]);
    expect(
      screen.getAllByRole("option")[0]!.getAttribute("aria-selected")
    ).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["dev"]);
  });

  it("does not add another suggestion when the typed tag already exists", () => {
    const { input, onChange } = setup({ initial: ["d"] });
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "d" } });

    // Only longer suggestions match, and none is highlighted.
    expect(optionTexts()).toEqual(["dev", "production"]);
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("leaves keys to the input method while composing", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "ni" } });

    const arrow = fireEvent.keyDown(input, {
      key: "ArrowDown",
      isComposing: true,
    });
    expect(arrow).toBe(true); // not prevented
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    // Safari reports the confirming Enter as keyCode 229.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("ni");
    expect(screen.getByRole("listbox")).not.toBeNull();

    // After the composition ends, Enter adds the text.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["ni"]);
  });

  it("keeps the picked option when removing a chip changes the list", () => {
    const { input, onChange } = setup({ initial: ["local"] });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // dev

    // Backspace removes "local", which returns to the top of the list.
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(optionTexts()[0]).toBe("local");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["dev"]);
  });

  it("keeps the picked option when the suggestions are reordered", () => {
    const onChange = vi.fn();
    const props = { value: [] as string[], onChange };
    const view = render(
      h(TagInput, { ...props, suggestions: ["dev", "staging", "production"] })
    );
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // dev

    view.rerender(
      h(TagInput, { ...props, suggestions: ["production", "staging", "dev"] })
    );
    const selected = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toBe("dev");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["dev"]);
  });

  it("picks a suggestion with the arrow keys and Enter", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith(["dev"]);
    // The added tag leaves the list.
    expect(optionTexts()).toEqual(["local", "staging", "production"]);
  });

  it("does nothing on Enter with an empty input and no highlight", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds an option on click and keeps the list open", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    fireEvent.input(input, { target: { value: "dsa" } });

    const create = screen.getByRole("option", { name: "Create Tag dsa" });
    // mousedown is prevented so the input keeps focus.
    expect(fireEvent.mouseDown(create)).toBe(false);
    fireEvent.click(create);

    expect(onChange).toHaveBeenLastCalledWith(["dsa"]);
    expect(screen.getByRole("listbox")).not.toBeNull();
  });

  it("closes on Escape without letting it reach the dialog, and on blur", () => {
    const { input } = setup();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();

    // A second Escape, with the list closed, goes through.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outer);

    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("removes the last tag with Backspace on an empty input, and via its button", () => {
    const { input, onChange } = setup({ initial: ["a", "b", "c"] });

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith(["a", "b"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove tag a" }));
    expect(onChange).toHaveBeenLastCalledWith(["b"]);
  });
});
