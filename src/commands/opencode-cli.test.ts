import { describe, expect, test } from "bun:test";
import { parseAutoOpenCodeCliRequest } from "./opencode-cli";

describe("parseAutoOpenCodeCliRequest", () => {
  test("parses configured command prefix", () => {
    const parsed = parseAutoOpenCodeCliRequest("!op stats", ["!agent", "!op"]);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ command: "stats", args: [] });
  });

  test("parses bare configured prefix as help", () => {
    const parsed = parseAutoOpenCodeCliRequest("!op", ["!agent", "!op"]);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ command: "help", args: [] });
  });

  test("parses neutral !agent alias", () => {
    const parsed = parseAutoOpenCodeCliRequest("!agent model", ["!agent", "!op"]);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ command: "model", args: [] });
  });

  test("does not match partial prefix", () => {
    const parsed = parseAutoOpenCodeCliRequest("!opstats", ["!agent", "!op"]);
    expect(parsed).toBeNull();
  });
});
