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

  it("剔除加粗/斜体闭合符被吞进链接的尾巴", () => {
    // **url** 的闭合 ** 被 autolink 吞进 href,非法端口令 new URL 抛错,点击无响应
    expect(trimAutolinkTail("http://localhost:35174**")).toBe(
      "http://localhost:35174",
    );
    expect(trimAutolinkTail("https://g.com/a/b*")).toBe("https://g.com/a/b");
    expect(trimAutolinkTail("https://g.com/a/b**`")).toBe("https://g.com/a/b");
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
