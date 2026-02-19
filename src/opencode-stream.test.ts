import { describe, expect, test } from "bun:test";
import {
  extractJsonLinesText,
  formatThinkingStreamDelta,
  parseOpenCodeStreamEvent,
} from "./opencode-stream";

describe("parseOpenCodeStreamEvent", () => {
  test("marks part.type=thinking as reasoning", () => {
    const event = parseOpenCodeStreamEvent({
      type: "message.part.updated",
      part: {
        type: "thinking",
        text: "Plan the fix",
      },
    });

    expect(event.isReasoning).toBe(true);
    expect(event.text).toBe("Plan the fix");
  });

  test("marks nested mode=thinking as reasoning", () => {
    const event = parseOpenCodeStreamEvent({
      type: "message.delta",
      data: {
        mode: "thinking",
        part: {
          text: "Inspecting inputs",
        },
      },
    });

    expect(event.isReasoning).toBe(true);
    expect(event.text).toBe("Inspecting inputs");
  });

  test("does not mark regular output as reasoning", () => {
    const event = parseOpenCodeStreamEvent({
      type: "message.delta",
      part: {
        type: "output_text",
        text: "Final answer",
      },
    });

    expect(event.isReasoning).toBe(false);
    expect(event.text).toBe("Final answer");
  });
});

describe("extractJsonLinesText", () => {
  test("prefers non-reasoning stream text when mixed", () => {
    const output = [
      JSON.stringify({
        type: "message.part.updated",
        part: { type: "thinking", text: "Analyze edge cases" },
      }),
      JSON.stringify({
        type: "message.part.updated",
        part: { type: "output_text", text: "Ship the patch" },
      }),
    ].join("\n");

    expect(extractJsonLinesText(output)).toBe("Ship the patch");
  });
});

describe("formatThinkingStreamDelta", () => {
  test("strips initial thinking prefix and preserves title separation", () => {
    const stream = "Thinking... **Plan**Start implementing";
    const delta = formatThinkingStreamDelta(stream, 0);

    expect(delta).toBe("**Plan**\n\nStart implementing");
  });
});
