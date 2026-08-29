import { describe, expect, it } from "vitest";
import {
  deriveFallbackTitle,
  extractEntities,
  hasExplicitReference,
  hasGoalShiftSignal,
} from "./goal-thread-signals.js";

describe("deriveFallbackTitle", () => {
  it("produces a short Title Case label instead of a raw truncated sentence", () => {
    // Regression case for the confusing titles seen in the live demo
    // ("Give me a 4-day beginner gym" as a thread title).
    expect(deriveFallbackTitle("Give me a 4-day beginner gym routine.")).toBe(
      "4-day Beginner Gym Routine",
    );
    expect(deriveFallbackTitle("But can you create a 3-day itinerary?")).toBe(
      "3-day Itinerary",
    );
    expect(deriveFallbackTitle("Which hotels in Japan are the best?")).toBe(
      "Hotels Japan Best",
    );
  });

  it("falls back to the raw words when everything is a stopword", () => {
    expect(deriveFallbackTitle("What should we do?")).not.toBe("");
  });

  it("never returns an empty title", () => {
    expect(deriveFallbackTitle("")).toBe("Untitled goal");
    expect(deriveFallbackTitle("   ")).toBe("Untitled goal");
  });
});

describe("extractEntities", () => {
  it("extracts non-sentence-initial capitalized words", () => {
    expect(extractEntities("Extract restaurants from my saved Tokyo travel videos.")).toEqual([
      "Tokyo",
    ]);
  });

  it("extracts quoted phrases regardless of case", () => {
    expect(extractEntities('Add "morning pages" to my routine.')).toContain("morning pages");
  });

  it("ignores the sentence-initial word even when capitalized", () => {
    expect(extractEntities("Build a todo app.")).toEqual([]);
  });
});

describe("hasExplicitReference / hasGoalShiftSignal", () => {
  it("recognizes common back-reference phrasing", () => {
    expect(hasExplicitReference("Which of those are near Shibuya?")).toBe(true);
    expect(hasExplicitReference("Continue with the next step.")).toBe(true);
    expect(hasExplicitReference("Give me a 4-day beginner gym routine.")).toBe(false);
  });

  it("recognizes explicit goal-shift phrasing but not casual use of 'instead'", () => {
    expect(hasGoalShiftSignal("Actually forget Tokyo, I'm going to Seoul instead.")).toBe(true);
    expect(
      hasGoalShiftSignal("Add them to my fantasy list instead, not the self-improvement one."),
    ).toBe(false);
  });
});
