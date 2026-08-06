import { describe, expect, it } from "vitest";
import { trimAutolinkTail } from "./shared";

describe("trimAutolinkTail", () => {
  it("剔除中文正文里被 GFM autolink 误吞的尾巴", () => {
    expect(
      trimAutolinkTail(
        "https://g.com/x/-/merge_requests/102\uFF08`feature/field-inventory`",
      ),
    ).toBe("https://g.com/x/-/merge_requests/102");
    expect(trimAutolinkTail("https://g.com/a/b\uFF0C详见文档")).toBe(
      "https://g.com/a/b",
    );
    expect(trimAutolinkTail("https://g.com/a/b\u3002")).toBe(
      "https://g.com/a/b",
    );
  });

  it("不动纯 ASCII 的正常链接", () => {
    for (const u of [
      "https://g.com/a/b",
      "https://g.com/a/b?q=1&r=2#frag",
      "https://g.com/-/merge_requests/102",
    ]) {
      expect(trimAutolinkTail(u)).toBe(u);
    }
  });
});
