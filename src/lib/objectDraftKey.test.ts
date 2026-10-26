import { describe, expect, it } from "vitest";
import {
  draftKeyForWindow,
  editDraftKey,
  isCreateDraftKey,
  newCreateDraftKey,
  windowIdForDraftKey,
} from "./objectDraftKey";

describe("object draft keys", () => {
  it("maps windows and drafts both ways", () => {
    const key = editDraftKey("function:public:a:b:c");
    const id = windowIdForDraftKey(key);
    expect(draftKeyForWindow({ id, initialObjectId: "" })).toBe(key);
    expect(
      draftKeyForWindow({ id: "x", initialObjectId: "function:public:a:b:c" })
    ).toBe(key);
  });

  it("create keys are unique and never look like edits", () => {
    const a = newCreateDraftKey("trigger");
    const b = newCreateDraftKey("trigger");
    expect(a).not.toBe(b);
    expect(isCreateDraftKey(a)).toBe(true);
    expect(isCreateDraftKey(editDraftKey("new:x"))).toBe(false);
    expect(draftKeyForWindow({ id: windowIdForDraftKey(a) })).toBe(a);
  });
});
