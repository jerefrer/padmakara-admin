# Naming conventions

How to name audio files so the importer can detect, for each track, its **number**, its **speaker**, and its **language(s)**. Get the name right and the rest is automatic.

## The 5 rules

1. **No accents.** Use a normal dash (`-`), never a long dash.
2. **Start with the track number**, zero-padded to 3 digits: `006`.
   The same teaching in another language keeps the **same number** — that is how the app pairs them (see "Parallel languages" below).
3. **Then the speaker code**: `JKR`, `KPS`, `CNR`, `TGR`, `KNP`, `KTR`, `YMR`…
4. **Then the language tag in brackets.** If several languages are audible in the *same* file, join them with `+`: `[TIB+ENG]`.
5. **`TRAD` is shorthand for `[POR]`** (Portuguese translation). `006 TRAD - Titulo.mp3` ≡ `006 [POR] Titulo.mp3`.

## Language tags

| Tag | Language | Also accepted |
|-----|----------|---------------|
| `[TIB]` | Tibetan | — |
| `[ENG]` | English | `[ING]` |
| `[POR]` | Portuguese | `[PT]`, or the shorthand `TRAD` |
| `[FRA]` | French | `[FR]` |

No tag at all = English (the default).

## Two ways a file can carry languages

- **One language per file** — separate files, one per language: `[ENG]`, `[POR]`, `[TIB]`.
- **Several languages in one file** (sequential translation in the recording) — join with `+`: `[TIB+ENG]`, `[ENG+POR]`, `[TIB+ENG+POR]`.

## Parallel languages — pair by number

When the **same content** exists as **separate files** (e.g. an English set and a Portuguese set), give the matching files the **same track number**. The app then lines them up and the language picker switches cleanly between them.

```
005 JKR [ENG] Mind training.mp3
005 TRAD Treino da mente.mp3        ← same number 005 = the Portuguese of the same track
006 JKR [ENG] Bodhicitta.mp3
006 TRAD Bodhicitta.mp3
```

Do **not** number the Portuguese set 101, 102… — that breaks the pairing.

## Examples by situation

Every recording type maps onto one of these.

| Situation | Example file name(s) |
|-----------|----------------------|
| English only | `006 JKR [ENG] Title.mp3` (or no tag) |
| English + Portuguese, one file | `006 JKR [ENG+POR] Title.mp3` (or `006 JKR+TRAD - Title.mp3`) |
| Tibetan + English, one file | `006 CNR [TIB+ENG] Title.mp3` |
| Tibetan + Portuguese, one file | `006 KNP [TIB+POR] Title.mp3` |
| Tibetan + English + Portuguese, one file | `006 KTR [TIB+ENG+POR] Title.mp3` |
| Several files, each in the same pattern | number them `001`, `002`, `003`… with the same tag |
| Parallel files — English set + Portuguese set | `005 JKR [ENG] Title.mp3` + `005 TRAD Titulo.mp3` (same numbers) |
| Parallel files — Tibetan&English set + Portuguese set | `005 KPS [TIB+ENG] Title.mp3` + `005 TRAD Titulo.mp3` (same numbers) |
| Continuous parallel recordings (one long file per language) | `001 YMR [ENG] Conference.mp3` + `001 TRAD Conferencia.mp3` |

### Optional date / part suffix

You may add a parenthetical at the end; it does not affect language detection:

```
006 JKR [ENG] Relative and absolute means (17 April AM - Part 1).mp3
```

## Video

Video is **not** named for the importer — it is uploaded to the streaming server (Bunny) separately and attached to its session. One video per session. The recording's languages are handled with subtitle tracks, not with the file name.

## Transcripts (PDF)

Transcripts are attached at the **event** level, and an event may have more than one. Tag each with its language so the app shows the right one:

```
Shantideva chapter 9 [ENG].pdf
Shantideva capitulo 9 [POR].pdf
```
