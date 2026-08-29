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
  // Also used to filter thread-title fallback text (see deriveFallbackTitle)
  // — these matter far more there, since titles run this filter over every
  // word in the sentence, not just capitalized ones.
  "me", "you", "we", "us", "them", "they", "he", "she", "him", "of", "in",
  "on", "at", "by", "to", "too", "some", "any", "all", "one", "ones",
  "there", "here", "not", "no", "if", "as", "up", "out", "off", "over",
  "under", "than", "such", "some", "other", "another", "same", "each",
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

/**
 * Short, readable fallback title for a thread whose opening Run had no
 * extractable entities — e.g. "Give me a 4-day beginner gym routine." should
 * read as "4-day Beginner Gym Routine" on a thread card, not a raw
 * first-N-words truncation like "Give me a 4-day beginner gym". Strips the
 * same stopwords used for entity extraction from the whole sentence (not
 * just the leading run of them), keeps the first few remaining content
 * words, and Title Cases them. This is a label, not a sentence — dropping
 * mid-sentence function words is intentional, not a grammar mistake.
 */
export function deriveFallbackTitle(prompt: string): string {
  const cleaned = prompt.replace(/[?!.]+$/, "").trim();
  if (!cleaned) return "Untitled goal";
  const words = cleaned.split(/\s+/);
  const contentWords = words.filter((word) => {
    const normalized = word.toLowerCase().replace(/[^a-z0-9'-]/g, "");
    return normalized.length > 0 && !ENTITY_STOPWORDS.has(normalized);
  });
  const chosen = (contentWords.length > 0 ? contentWords : words).slice(0, 5);
  const titled = chosen
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return titled.length > 0 ? titled : "Untitled goal";
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
