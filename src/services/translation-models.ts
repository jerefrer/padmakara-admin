export interface TranslationModel { id: string; label: string }

// Each entry must be an Anthropic model that supports adaptive thinking AND
// structured outputs (Opus 4.x / Sonnet 4.6+). The translation prompt is
// model-agnostic and passed identically to every model — see translateSentences.
export const TRANSLATION_MODELS: TranslationModel[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (highest quality)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (faster, cheaper)" },
];

export const DEFAULT_TRANSLATE_MODEL = "claude-opus-4-8";

export function isAllowedModel(id: string): boolean {
  return TRANSLATION_MODELS.some((m) => m.id === id);
}
