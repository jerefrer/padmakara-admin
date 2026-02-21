/**
 * Translate Portuguese event titles to English.
 *
 * Handles the formulaic patterns used in Padmakara event titles:
 *   "Retiro de Primavera | Śamatha" → "Spring Retreat | Śamatha"
 *   "Conferência - Lisboa"          → "Conference - Lisboa"
 *
 * Sanskrit/Tibetan terms (Śamatha, Vajrasattva, Bodhicitta, etc.)
 * and proper nouns (place names, teacher names) are preserved as-is.
 */

/** Word/phrase replacements applied to the whole title */
const PHRASE_MAP: [RegExp, string][] = [
  // ─── Full-title patterns (match before word-level replacements) ───

  // "Os Ensinamentos do Buda: Coração Bondoso, Clareza da Mente"
  [/\bOs\s+Ensinamentos\s+do\s+Buda:\s*Coração\s+Bondoso,\s*Clareza\s+da\s+Mente\b/g,
    "The Teachings of the Buddha: Kind Heart, Clarity of Mind"],
  // "Os Ensinamentos de/do Buda"
  [/\bOs\s+Ensinamentos\s+d[eo]\s+Buda\b/g, "The Teachings of the Buddha"],
  // "O Treino da Mente"
  [/\bO\s+Treino\s+da\s+Mente\b/g, "Mind Training"],
  // Commentary
  [/\bComentário\s+às\s+37\s+Práticas\s+de\s+um\s+Bodhisattva,\s*de\s+Gyalse\s+Thogme\b/g,
    "Commentary on the 37 Practices of a Bodhisattva, by Gyalse Thogme"],
  // Mind training with quote
  [/\bTreino\s+da\s+Mente,\s*"Os\s+quatro\s+raios\s+da\s+roda"\s*[–-]\s*de\s+Jamgön\s+Mipham\s+Rinpoche,\s*Śamatha\s+e\s+Vipashyana\b/g,
    'Mind Training, "The Four Spokes of the Wheel" by Jamgön Mipham Rinpoche, Śamatha and Vipaśyanā'],

  // ─── Retreat season patterns ───
  [/\bRetiros?\s+(?:de\s+|da\s+)?Primavera(?:-Verão)?\b/gi, "Spring Retreat"],
  [/\bRetiros?\s+(?:de\s+|da\s+)?Outono\b/gi, "Autumn Retreat"],
  [/\bRetiro\b/gi, "Retreat"],

  // ─── Event types ───
  [/\bConferências?\s+Públicas?\b/gi, "Public Conference"],
  [/\bConferências?\b/gi, "Conference"],
  [/\bEnsinamentos\b/gi, "Teachings"],
  [/\bEnsinamento\b/gi, "Teaching"],
  [/\bIniciação\s+de\b/gi, "Initiation of"],
  [/\bIniciação\b/gi, "Initiation"],

  // ─── Practice-related ───
  [/\bPráticas\s+Preliminares\b/gi, "Preliminary Practices"],
  [/\bPráticas\s+d[oae]s?\s+Bodhisattvas?\b/gi, "Practices of the Bodhisattvas"],
  [/\bPráticas\b/gi, "Practices"],
  [/\bPrática\s+d[aoe]\b/gi, "Practice of"],

  // ─── Mind training ───
  [/\bTreino\s+da\s+Mente\b/gi, "Mind Training"],

  // ─── Refuge & Bodhicitta ───
  [/\bRefúgio\s+e\s+Bodhicitta\b/gi, "Refuge & Bodhicitta"],
  [/\bRefúgio\s+e\s+Bênção\s+de\b/gi, "Refuge & Blessing of"],
  [/\bRefúgio\b/gi, "Refuge"],

  // ─── Articles and connectors ───
  [/\bAs\s+37\b/gi, "The 37"],
  [/\bOs\s+Quatro\s+Pensamentos\b/gi, "The Four Thoughts"],
  [/\bOs\s+4\s+Pensamentos\b/gi, "The 4 Thoughts"],
  [/\b4\s+pensamentos\b/gi, "4 Thoughts"],
  [/\b4\s+Nobres\s+Verdades\b/gi, "4 Noble Truths"],
  [/\b4\s+Selos\b/gi, "4 Seals"],

  // ─── Specific longer titles/phrases ───
  [/\bA\s+Entrada\s+no\s+Caminho\s+Mahāyāna\b/g, "Entering the Mahāyāna Path"],
  [/\bA\s+Essência\s+da\s+Meditação:\s*Uma\s+Mente\s+Feliz\s+nos\s+Tempos\s+Modernos\b/g,
    "The Essence of Meditation: A Happy Mind in Modern Times"],
  [/\bA\s+Linhagem\s+Khyentse\b/g, "The Khyentse Lineage"],
  [/\bO\s+sūtra\s+que\s+leva\s+à\s+recordação\s+das\s+Três\s+Jóias\b/g,
    "The Sūtra of Recollecting the Three Jewels"],
  [/\bA\s+Linhagem\s+do\s+Bom\s+Coração\b/g, "The Lineage of the Good Heart"],
  [/\bA\s+Mente\s+Desperta\s+e\s+Como\s+desenvolver\s+a\s+Calma\s+Mental\b/g,
    "The Awakened Mind and How to Develop Calm Abiding"],
  [/\bA\s+Necessidade\s+de\s+Altruísmo\b/g, "The Need for Altruism"],
  [/\bA\s+Vida\s+e\s+a\s+Morte:.*?treinar\s+a\s+própria\s+mente\b/g,
    "Life and Death: The Turbulence of End of Life - How to Guide Others and Train One's Own Mind"],
  [/\bA\s+Vida\s+e\s+o\s+Mundo\s+dos\s+Grandes\s+Mestres\s+do\s+Tibete\b/g,
    "The Life and World of the Great Masters of Tibet"],
  [/\bA\s+humanidade\s+que\s+nos\s+une\s+em\s+tempos\s+de\s+incerteza\b/g,
    "The Humanity That Unites Us in Times of Uncertainty"],
  [/\bBardo,\s*Calma\s+Mental\s+e\s+Visão\s+Penetrante\b/g,
    "Bardo, Calm Abiding and Insight"],
  [/\bDesenvolver\s+a\s+Paz\s+Interior\b/g, "Developing Inner Peace"],
  [/\bDespertar\s+a\s+Paz\s+Interior\b/g, "Awakening Inner Peace"],
  [/\bA\s+Via\s+do\s+Bodhisattva\s+de\s+Śāntideva\b/g,
    "The Way of the Bodhisattva by Śāntideva"],
  [/\bExaminando\s+o\s+Espelho\s+da\s+Morte\b/g, "Examining the Mirror of Death"],
  [/\bGerir\s+Emoções\s+Negativas\s*-\s*os\s+Benefícios\s+da\s+Meditação\b/g,
    "Managing Negative Emotions - the Benefits of Meditation"],
  [/\bMeditação\s+e\s+Alegria\s+de\s+Viver:.*?Quotidiana\b/g,
    "Meditation and the Joy of Living: Cultivating Attention, Compassion and Wisdom in Daily Life"],
  [/\bMeditação\s+e\s+Paz\s+Interior\b/g, "Meditation and Inner Peace"],
  [/\bO\s+Buda\s+que\s+há\s+em\s+ti\b/g, "The Buddha Within You"],
  [/\bO\s+Dalai\s+Lama\s+em\s+Dharamsala\b/g, "The Dalai Lama in Dharamsala"],
  [/\bO\s+Dalai\s+Lama\b/g, "The Dalai Lama"],
  [/\bO\s+Nono\s+Capítulo\s+da\s+Via\s+do\s+Bodhisattva\b/g,
    "The Ninth Chapter of the Way of the Bodhisattva"],
  [/\bParte?\s+(\d+)\s+de\s+(\d+)\b/g, "Part $1 of $2"],
  [/\bO\s+Poder\s+da\s+Compaixão\b/g, "The Power of Compassion"],
  [/\bO\s+Poder\s+do\s+Bom\s+Coração\b/g, "The Power of the Good Heart"],
  [/\bRenúncia,\s*Compaixão\s+e\s+Visão\s+pura\b/g,
    "Renunciation, Compassion and Pure Vision"],
  [/\bA\s+Prática\s+d[aeo]\b/g, "The Practice of"],
  [/\bIntrodução\s+ao\s+[Cc]aminho\s+e\b/g, "Introduction to the Path &"],
  [/\bIntrodução\s+ao\s+[Cc]aminho\b/g, "Introduction to the Path"],
  [/\bSādhana\s+Tesouro\s+de\s+Bênçãos\b/g, "Sādhana Treasury of Blessings"],
  [/\bInvocar\s+Guru\s+Rinpoche\b/g, "Invoking Guru Rinpoche"],
  [/\bConhece\s+a\s+tua\s+mente\b/gi, "Know Your Mind"],
  [/\bParinirvana\s+de\s+Amala\b/g, "Parinirvana of Amala"],
  [/\bCoração\s+Bondoso,\s*Clareza\s+da\s+Mente\b/g,
    "Kind Heart, Clarity of Mind"],

  [/\bA\s+PALESTRA\s+PÚBLICA\s+DE\s+S\.S\.\s+DALAI\s+LAMA\s+NA\s+FINLÂNDIA\b/g,
    "Public Talk by H.H. the Dalai Lama in Finland"],

  // ─── Bodhicharyavatara chapter references ───
  [/\bCap\.\s*(I+V?|VI*)\b/g, "Ch. $1"],

  // ─── Generic word-level cleanup (applied last) ───
  [/\bVídeo\b/gi, "Video"],
  [/\bCalma\s+Mental\b/g, "Calm Abiding"],
  [/\bVisão\s+Penetrante\b/g, "Insight"],
];

/**
 * Translate a Portuguese event title to English.
 * Returns the original title if no patterns match (already English or unknown).
 */
export function translateTitleToEnglish(ptTitle: string): string {
  let result = ptTitle;
  for (const [pattern, replacement] of PHRASE_MAP) {
    result = result.replace(pattern, replacement);
  }
  // Collapse multiple spaces
  result = result.replace(/  +/g, " ").trim();
  return result;
}
