import { describe, expect, test } from "bun:test";
import { buildInitialSenderAllowlist, parseSenderAllowlist } from "./sender-allowlist";

describe("senderAllowlist bootstrap/validation", () => {
  test("create bootstrap seeds sender and passes validation", () => {
    const createdBy = "@admin:matrix.org";
    const bootstrap = buildInitialSenderAllowlist(createdBy);

    expect(bootstrap).toEqual([createdBy]);
    expect(parseSenderAllowlist(bootstrap)).toEqual(new Set([createdBy]));
  });

  test("validation rejects empty senderAllowlist", () => {
    expect(() => parseSenderAllowlist([])).toThrow(
      "senderAllowlist must include at least one user ID",
    );
  });
});
