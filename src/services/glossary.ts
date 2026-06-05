// Buddhist / Tibetan / Sanskrit terms whose spelling and (non-)translation must
// stay consistent across an event. Keep terms in their canonical English/source
// form; instruct the model NOT to translate or re-spell them.
export const GLOSSARY: string[] = [
  "bodhicitta", "dharmakaya", "sambhogakaya", "nirmanakaya", "tonglen",
  "dzogchen", "mahamudra", "samsara", "nirvana", "sangha", "dharma",
  "rinpoche", "lama", "tulku", "bardo", "mandala", "mantra", "ngöndro",
  "shamatha", "vipashyana", "tathagatagarbha", "rigpa", "prajna", "skandha",
];

export function glossaryBlock(): string {
  return [
    "GLOSSARY — keep these terms exactly as written; do not translate or re-spell them:",
    GLOSSARY.join(", "),
  ].join("\n");
}
