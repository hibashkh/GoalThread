/**
 * Tier 1 (deterministic) signal extraction for the GoalThread engine.
 * Cheap, explainable, always computed — no model call involved.
 */

// Common sentence-starting verbs/pronouns that would otherwise be picked up
// as "proper nouns" purely because English capitalizes the first word of a
// sentence. Filtered out wherever they occur (not just at index 0), because
// task text is often a single short imperative sentence.
const ENTITY_STOPWORDS = new Set([
  "i", "i'm", "im", "the", "a", "an", "this", "that", "those", "these",
  "which", "what", "who", "build", "extract", "give", "create", "make",
  "please", "can", "could", "show", "find", "get", "add", "update",
  "continue", "based", "from", "using", "use", "actually", "also", "now",
  "then", "instead", "forget", "never", "mind", "start", "new", "old",
  "previous", "last", "next", "first", "second", "third", "again", "more",
  "less", "just", "only", "still", "yet", "so", "but", "and", "or", "for",
  "with", "without", "about", "near", "around", "into", "onto", "before",
  "after", "while", "when", "where", "how", "why", "let's", "lets", "help",
  "need", "want", "would", "should", "must", "will", "shall", "don't",
  "dont", "do", "does", "did", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "it's", "my", "your", "our", "their", "his", "her",
]);

/**
 * Extracts candidate "key entities" (places, projects, named subjects) from
 * task text: quoted phrases plus capitalized words that survive the
 * sentence-initial and stopword filters. Intentionally simple — a real NER
 * model is out of scope for a Tier 1 signal that must be cheap and always
 * computed.
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/["“]([^"”]{2,40})["”]/g)) {
    const phrase = match[1]?.trim();
    if (phrase) found.add(phrase);
  }

  const words = text.split(/\s+/);
  words.forEach((raw, index) => {
    const word = raw.replace(/[^A-Za-z'-]/g, "");
    if (word.length < 3) return;
    if (!/^[A-Z][a-zA-Z'-]*$/.test(word)) return;
    if (index === 0) return; // sentence-initial capital is not a reliable signal
    if (ENTITY_STOPWORDS.has(word.toLowerCase())) return;
    found.add(word);
  });

  return [...found];
}

const EXPLICIT_REFERENCE_PATTERN =
  /\b(those|that list|the previous|earlier|continue|based on (what|those)|from (that|those)|the ones (we|you)|from (before|earlier))\b/i;

/** Does the task text reference prior output from another Run? */
export function hasExplicitReference(text: string): boolean {
  return EXPLICIT_REFERENCE_PATTERN.test(text);
}

const GOAL_SHIFT_PATTERN =
  /\b(forget (about )?|never ?mind|scratch that|instead of|going to .+ instead|switch(?:ing)? to|change of plans)\b/i;

/** Does the task text explicitly signal abandoning the prior goal? */
export function hasGoalShiftSignal(text: string): boolean {
  return GOAL_SHIFT_PATTERN.test(text);
}

/** Case-insensitive intersection, returned with the casing from `entities`. */
export function sharedEntities(entities: string[], keyEntities: string[]): string[] {
  const known = new Set(keyEntities.map((entity) => entity.toLowerCase()));
  return entities.filter((entity) => known.has(entity.toLowerCase()));
}

/** Entities present in `entities` but absent from `keyEntities` (case-insensitive). */
export function contradictingEntities(entities: string[], keyEntities: string[]): string[] {
  const known = new Set(keyEntities.map((entity) => entity.toLowerCase()));
  return entities.filter((entity) => !known.has(entity.toLowerCase()));
}
