import { h } from "preact";
import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { DbIcon } from "./DbIcon";

describe("DbIcon", () => {
  it("tags the MySQL mark so dark theme can brighten it", () => {
    render(h(DbIcon, { engine: "mysql", px: 16 }));
    expect(
      document.querySelector("img[data-db-engine='mysql']")
    ).not.toBeNull();
  });
});
