import { describe, expect, it } from "vitest";
import { buildChatExport, formatExportTs, safeExportBasename } from "./exportChat.js";

describe("exportChat", () => {
  it("formats WhatsApp-style timestamps", () => {
    const d = new Date(2026, 9, 27, 14, 5, 9); // Oct 27 2026
    expect(formatExportTs(d)).toBe("[27/10/2026, 14:05:09]");
  });

  it("builds text lines with sender names", () => {
    const built = buildChatExport({
      title: "Ali",
      includeMedia: false,
      senderName: (id) => (id === "a" ? "Alice" : "Bob"),
      messages: [
        {
          id: "1",
          type: "TEXT",
          text: "Hello",
          attachment: null,
          payload: null,
          deletedForEveryoneAt: null,
          expiresAt: null,
          viewOnce: false,
          createdAt: new Date(2026, 0, 1, 10, 0, 0),
          senderId: "a",
        },
        {
          id: "2",
          type: "IMAGE",
          text: "pic",
          attachment: { url: "https://x/y.png", name: "y.png" },
          payload: null,
          deletedForEveryoneAt: null,
          expiresAt: null,
          viewOnce: false,
          createdAt: new Date(2026, 0, 1, 10, 1, 0),
          senderId: "b",
        },
      ],
    });
    expect(built.text).toContain("Aivora Chat Export: Ali");
    expect(built.text).toContain("Alice: Hello");
    expect(built.text).toContain("Bob: <image omitted> pic");
    expect(built.mediaFiles).toHaveLength(0);
  });

  it("safeExportBasename strips unsafe chars", () => {
    expect(safeExportBasename("Hi/there??")).toBe("Hi_there_");
  });
});
