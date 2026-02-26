import { describe, expect, test } from "bun:test";
import { parseManagementCommandArgs } from "./management";

describe("parseManagementCommandArgs", () => {
  test("parses create command with required options", () => {
    const parsed = parseManagementCommandArgs([
      "create",
      "operator",
      "--room",
      "!room:example.org",
      "--path",
      "/repo",
    ]);

    expect(parsed).toEqual({
      action: "create",
      projectKey: "operator",
      roomId: "!room:example.org",
      projectWorkingDirectory: "/repo",
    });
  });

  test("parses show and delete actions", () => {
    expect(parseManagementCommandArgs(["show", "operator"])).toEqual({
      action: "show",
      projectKey: "operator",
    });

    expect(parseManagementCommandArgs(["delete", "operator"])).toEqual({
      action: "delete",
      projectKey: "operator",
    });
  });

  test("rejects create command without required options", () => {
    expect(() => parseManagementCommandArgs(["create", "operator", "--room", "!room:example.org"])).toThrow(
      "project create requires --path <directory>",
    );
  });
});
