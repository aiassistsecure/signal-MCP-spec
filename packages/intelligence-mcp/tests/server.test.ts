import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import { LEXICON_MARKDOWN } from "../src/resources/lexicon.js";
import { INTENTS } from "../src/constants.js";

describe("createServer", () => {
  it("builds without an apiKey (tools will error on call, but server boots)", () => {
    const { server, apiClient } = createServer({});
    expect(server).toBeDefined();
    expect(apiClient).toBeNull();
  });

  it("builds an ApiClient when apiKey is provided", () => {
    const { apiClient } = createServer({ apiKey: "aai_test" });
    expect(apiClient).not.toBeNull();
  });

  it("exposes the correct server name and version", () => {
    expect(SERVER_NAME).toBe("signal");
    expect(SERVER_VERSION).toBe("0.1.0");
  });
});

describe("lexicon", () => {
  it("covers every intent enum value", () => {
    for (const intent of INTENTS) {
      const header = `## ${intent}`;
      expect(
        LEXICON_MARKDOWN.includes(header),
        `lexicon missing section for intent '${intent}'`,
      ).toBe(true);
    }
  });

  it("every intent section has the four required parts", () => {
    for (const intent of INTENTS) {
      const start = LEXICON_MARKDOWN.indexOf(`## ${intent}`);
      const next = LEXICON_MARKDOWN.indexOf("\n## ", start + 1);
      const end = next === -1 ? LEXICON_MARKDOWN.length : next;
      const section = LEXICON_MARKDOWN.slice(start, end);
      expect(section).toMatch(/\*\*Definition\.\*\*/);
      expect(section).toMatch(/\*\*Canonical example\.\*\*/);
      expect(section).toMatch(/\*\*Common false positives\.\*\*/);
      expect(section).toMatch(/\*\*Recommended agent response\.\*\*/);
    }
  });
});
