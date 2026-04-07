/**
 * Parse JSON from LLM responses, handling markdown code fences
 * that providers like Gemini wrap around JSON output.
 */
export function parseLLMJson(raw: string): any {
  let cleaned = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = cleaned.match(
    /^```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```\s*$/,
  );
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // If still not valid JSON, try extracting the first { ... } or [ ... ] block
  if (cleaned[0] !== "{" && cleaned[0] !== "[") {
    const braceMatch = cleaned.match(/(\{[\s\S]*\})/);
    const bracketMatch = cleaned.match(/(\[[\s\S]*\])/);
    cleaned = (braceMatch?.[1] ?? bracketMatch?.[1] ?? cleaned).trim();
  }

  return JSON.parse(cleaned);
}
