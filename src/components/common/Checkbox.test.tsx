import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox";

afterEach(() => cleanup());

function Controlled(props: { accept: boolean; initial?: boolean }) {
  const [checked, setChecked] = useState(props.initial ?? false);
  return (
    <Checkbox
      aria-label="box"
      checked={checked}
      onChange={() => {
        if (props.accept) setChecked((value) => !value);
      }}
    />
  );
}

const box = () => screen.getByLabelText("box") as HTMLInputElement;

describe("Checkbox", () => {
  it("follows the parent when it accepts a change, both ways", () => {
    render(<Controlled accept />);
    fireEvent.click(box());
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    expect(box().checked).toBe(false);
  });

  it("stays as rendered when the parent refuses a change", () => {
    render(<Controlled accept={false} />);
    fireEvent.click(box());
    expect(box().checked).toBe(false);

    cleanup();
    render(<Controlled accept={false} initial />);
    fireEvent.click(box());
    expect(box().checked).toBe(true);
  });

  it("leaves an uncontrolled checkbox to the browser", () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="box" onChange={onChange} />);
    fireEvent.click(box());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(box().checked).toBe(true);
  });

  it("keeps the indeterminate state and the disabled attribute", () => {
    render(
      <Checkbox aria-label="box" checked={false} indeterminate disabled />
    );
    expect(box().indeterminate).toBe(true);
    expect(box().disabled).toBe(true);
  });
});
