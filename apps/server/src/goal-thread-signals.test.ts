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
  it("extracts the real entity from a properly-capitalized message", () => {
    expect(extractEntities("Extract restaurants from my saved Tokyo travel videos.")).toContain(
      "Tokyo",
    );
  });

  it("extracts quoted phrases regardless of case", () => {
    expect(extractEntities('Add "morning pages" to my routine.')).toContain("morning pages");
  });

  it("ignores the sentence-initial word regardless of case", () => {
    // "Build"/"extract" themselves never count (they're also stopwords), but
    // the real point: index 0 is excluded purely by position, independent
    // of capitalization.
    expect(extractEntities("Build a todo app.")).not.toContain("build");
  });

  it("is case-insensitive — finds a real entity even typed lowercase", () => {
    // Regression: three real bugs came from trying to gate extraction on
    // whether the message "looked" properly capitalized. A perfectly
    // ordinary sentence (capital first letter, as everyone types) with an
    // uncapitalized proper noun used to find nothing at all.
    expect(extractEntities("Extract restaurants from my saved tokyo travel videos.")).toContain(
      "tokyo",
    );
    expect(extractEntities("actually forget tokyo, im going to seoul instead")).toEqual(
      expect.arrayContaining(["tokyo", "seoul"]),
    );
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
