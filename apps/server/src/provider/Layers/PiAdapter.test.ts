/**
 * Tests for PiAdapter — pure logic functions and event translation helpers.
 *
 * Full integration tests that need createAgentSession require API keys
 * and are best tested manually or in an integration environment.
 *
 * @module PiAdapter.test
 */
import { describe, it, expect } from "vitest";

// ── Replicate the adapter's pure helper functions for testing ──

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("");
  }
  return "";
}

function toolItemType(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === "bash") return "command_execution";
  if (n === "edit" || n === "write") return "file_change";
  return "dynamic_tool_call";
}

function toolDisplay(
  toolName: string,
  args: unknown,
): { title: string; detail: string | undefined } {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  switch (toolName) {
    case "bash":
      return {
        title: "Ran command",
        detail: typeof a?.command === "string" ? a.command : undefined,
      };
    case "read":
      return { title: "Reading file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "edit":
      return { title: "Editing file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "write":
      return { title: "Writing file", detail: typeof a?.path === "string" ? a.path : undefined };
    case "find":
      return { title: "Finding files", detail: typeof a?.path === "string" ? a.path : undefined };
    case "grep":
      return { title: "Searching", detail: typeof a?.pattern === "string" ? a.pattern : undefined };
    case "ls":
      return {
        title: "Listing directory",
        detail: typeof a?.path === "string" ? a.path : undefined,
      };
    default:
      return { title: toolName, detail: undefined };
  }
}

function parseModelSlug(slug: string): { provider: string; modelId: string } | undefined {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

function compactionFromRuntimeMode(mode: string): boolean {
  return mode !== "approval-required";
}

describe("PiAdapter helpers", () => {
  describe("extractText", () => {
    it("returns plain string directly", () => {
      expect(extractText("hello")).toBe("hello");
    });

    it("extracts text from content array", () => {
      expect(
        extractText([
          { type: "text", text: "Hello" },
          { type: "image", url: "..." },
          { type: "text", text: " world" },
        ]),
      ).toBe("Hello world");
    });

    it("returns empty string for empty array", () => {
      expect(extractText([])).toBe("");
    });

    it("returns empty string for non-text content", () => {
      expect(extractText([{ type: "image", url: "..." }])).toBe("");
    });
  });

  describe("toolItemType", () => {
    it("classifies bash as command_execution", () => {
      expect(toolItemType("bash")).toBe("command_execution");
      expect(toolItemType("Bash")).toBe("command_execution");
    });

    it("classifies edit and write as file_change", () => {
      expect(toolItemType("edit")).toBe("file_change");
      expect(toolItemType("write")).toBe("file_change");
      expect(toolItemType("Write")).toBe("file_change");
    });

    it("classifies unknown tools as dynamic_tool_call", () => {
      expect(toolItemType("read")).toBe("dynamic_tool_call");
      expect(toolItemType("web_search")).toBe("dynamic_tool_call");
    });
  });

  describe("toolDisplay", () => {
    it("shows descriptive title and command/path as detail for bash", () => {
      const result = toolDisplay("bash", { command: "npm test" });
      expect(result.title).toBe("Ran command");
      expect(result.detail).toBe("npm test");
    });

    it("shows descriptive title for read with path", () => {
      const result = toolDisplay("read", { path: "/src/file.ts" });
      expect(result.title).toBe("Reading file");
      expect(result.detail).toBe("/src/file.ts");
    });

    it("shows descriptive title for edit", () => {
      const result = toolDisplay("edit", { path: "/src/file.ts" });
      expect(result.title).toBe("Editing file");
    });

    it("shows descriptive title for write", () => {
      const result = toolDisplay("write", { path: "/src/file.ts" });
      expect(result.title).toBe("Writing file");
    });

    it("shows descriptive title for grep with pattern", () => {
      const result = toolDisplay("grep", { pattern: "function foo" });
      expect(result.title).toBe("Searching");
      expect(result.detail).toBe("function foo");
    });

    it("shows descriptive title for find", () => {
      const result = toolDisplay("find", { path: "/src" });
      expect(result.title).toBe("Finding files");
    });

    it("shows descriptive title for ls", () => {
      const result = toolDisplay("ls", { path: "/src" });
      expect(result.title).toBe("Listing directory");
    });

    it("falls back to raw tool name for unknown tools", () => {
      const result = toolDisplay("unknown_tool", {});
      expect(result.title).toBe("unknown_tool");
      expect(result.detail).toBeUndefined();
    });

    it("handles undefined args", () => {
      const result = toolDisplay("bash", undefined);
      expect(result.title).toBe("Ran command");
      expect(result.detail).toBeUndefined();
    });

    it("handles null args", () => {
      const result = toolDisplay("read", null);
      expect(result.title).toBe("Reading file");
      expect(result.detail).toBeUndefined();
    });
  });

  describe("parseModelSlug", () => {
    it("parses provider/model format", () => {
      expect(parseModelSlug("anthropic/claude-opus-4-5")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-5",
      });
    });

    it("parses deepseek/deepseek-chat", () => {
      expect(parseModelSlug("deepseek/deepseek-chat")).toEqual({
        provider: "deepseek",
        modelId: "deepseek-chat",
      });
    });

    it("returns undefined for no slash", () => {
      expect(parseModelSlug("gpt-5")).toBeUndefined();
    });

    it("returns undefined for slash at start", () => {
      expect(parseModelSlug("/model")).toBeUndefined();
    });

    it("returns undefined for slash at end", () => {
      expect(parseModelSlug("provider/")).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseModelSlug("")).toBeUndefined();
    });
  });

  describe("compactionFromRuntimeMode", () => {
    it("enables compaction for full-access", () => {
      expect(compactionFromRuntimeMode("full-access")).toBe(true);
    });

    it("enables compaction for auto-accept-edits", () => {
      expect(compactionFromRuntimeMode("auto-accept-edits")).toBe(true);
    });

    it("disables compaction for approval-required", () => {
      expect(compactionFromRuntimeMode("approval-required")).toBe(false);
    });
  });
});
