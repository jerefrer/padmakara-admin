# Naming conventions

How to name audio files so the importer can detect, for each track, its **number**, its **speaker**, its **language(s)**, and **which session it belongs to**. Get the name right and the rest is automatic.

## The rules

1. **No accents.** Use a normal dash (`-`), never a long dash.
2. **Start with the track number**, zero-padded to 3 digits: `006`.
   The same teaching in another language keeps the **same number** — that is how the app pairs them (see "Parallel languages" below).
3. **Then the speaker code**: `JKR`, `KPS`, `CNR`, `TGR`, `KNP`, `KTR`, `YMR`…
4. **Then the language tag in brackets.** If several languages are audible in the *same* file, join them with `+`: `[TIB+ENG]`.
5. **`TRAD` is shorthand for `[POR]`** (Portuguese translation). `006 TRAD - Titulo.mp3` ≡ `006 [POR] Titulo.mp3`.
6. **End with the session marker** `(DD Month AM/PM)` — **required as soon as the event has more than one session.** Without it, every track collapses into a single session. See "Session markers" below.

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
005 JKR Mind training.mp3
005 TRAD Treino da mente.mp3        ← same number 005 = the Portuguese of the same track
006 JKR Bodhicitta.mp3
006 TRAD Bodhicitta.mp3
```

Do **not** number the Portuguese set 101, 102… — that breaks the pairing.

> **Leave the English side untagged.** English is the default, so `005 JKR Mind training.mp3` is already English. Writing `[ENG]` marks the file as a *translation of a Tibetan original* (the meaning brackets carry in Tibetan events) and unpairs it from its `TRAD` file across sessions. Only bracket English when it really is the translation in a Tibetan teaching (`[TIB+ENG]` is fine — a multi-tag file is treated as an original).

## Examples by situation

Every recording type maps onto one of these.

| Situation | Example file name(s) |
|-----------|----------------------|
| English only | `006 JKR Title.mp3` (English is the default — no tag) |
| English + Portuguese, one file | `006 JKR [ENG+POR] Title.mp3` (or `006 JKR+TRAD - Title.mp3`) |
| Tibetan + English, one file | `006 CNR [TIB+ENG] Title.mp3` |
| Tibetan + Portuguese, one file | `006 KNP [TIB+POR] Title.mp3` |
| Tibetan + English + Portuguese, one file | `006 KTR [TIB+ENG+POR] Title.mp3` |
| Several files, each in the same pattern | number them `001`, `002`, `003`… with the same tag |
| Parallel files — English set + Portuguese set | `005 JKR Title.mp3` + `005 TRAD Titulo.mp3` (same numbers; English untagged) |
| Parallel files — Tibetan&English set + Portuguese set | `005 KPS [TIB+ENG] Title.mp3` + `005 TRAD Titulo.mp3` (same numbers) |
| Continuous parallel recordings (one long file per language) | `001 YMR Conference.mp3` + `001 TRAD Conferencia.mp3` |

(Session markers are left off the table above for clarity — in real files add them, see below.)

## Session markers — required when an event has more than one session

The importer splits an event into sessions using a **date + period marker** at the end of the file name. **A marker does not carry over to the next file** — each track is filed into its session by its *own* marker, and a track with no marker drops into a separate catch-all session. So put the marker on **every track** that starts new content.

The one file that may skip it: a **translation that shares its track number** with an already-marked file (the Portuguese of a parallel EN/PT set). It is paired to that file's session by track number, so the marker on the original is enough.

Put it in parentheses at the end:

```
006 JKR Relative and absolute means (17 April AM).mp3
```

- **Day + month** — `17 April`. Month in English or Portuguese (`17 Abril` also works).
- **Period** — `AM` or `PM` (morning / afternoon). This is what separates the morning session from the afternoon session on the same day.
- **Part** *(optional)* — add `Part N` when one session is split across several files:

```
129 JKR Patience, part 1 (8 October PM - Part 1).mp3
130 JKR Patience, part 2 (8 October PM - Part 2).mp3
```

Separators inside the marker may be spaces, hyphens, or underscores — all equivalent: `(15 April AM - Part 2)` ≡ `(15 April AM_part_2)`.

### When is it needed?

| File | Session marker |
|------|----------------|
| Any track in a single-session event | Not needed — omit it |
| Each track of new content (multiple days, or morning + afternoon) | **Required — each carries its own** |
| A parallel translation sharing a number with a marked file | Optional — inherited by track number |
| A session split across several files | Required, plus `Part N` |

> **Note:** there is no forward-fill — a marker on track 1 does *not* cover tracks 2, 3… Even an event with **one track per session** needs the marker on each of those tracks; the track number alone never creates a session.
>
> A plain date (`2017-11-14`) or compact date (`20171114`) anywhere in the name sets the **day** but **not** the period, so it separates different days but not morning from afternoon. Prefer the `(DD Month AM/PM)` form for full control.

### Worked examples

**Several tracks across two half-days — every track marked:**

```
001 JKR Opening prayers (17 April AM).mp3
002 JKR Refuge and bodhicitta (17 April AM).mp3
003 JKR The four thoughts (17 April PM).mp3
004 JKR Dedication (17 April PM).mp3
```
→ 2 sessions: **17 April Morning** (tracks 1, 2) and **17 April Afternoon** (tracks 3, 4).

**Parallel EN/PT — only the original is marked, the translation is paired by number:**

```
001 JKR Opening prayers (17 April AM).mp3
001 TRAD Oracoes iniciais.mp3                      ← no marker; same number → same session as 001
002 JKR Refuge and bodhicitta (17 April AM).mp3
002 TRAD Refugio e bodhicitta.mp3
```
→ 1 session: **17 April Morning** holding tracks 1, 1-PT, 2, 2-PT.

(The English side is left **untagged** — see the caution under "Parallel languages". Tagging it `[ENG]` would break the pairing here.)

**The pitfall — a missing marker splits the session:**

```
001 JKR Opening prayers (17 April AM).mp3
002 JKR Refuge and bodhicitta.mp3                  ← marker forgotten
```
→ 2 sessions by mistake: **17 April Morning** (track 1) and a stray catch-all session (track 2). Add the marker to track 2 to keep them together.

## Video

Video is **not** named for the importer — it is uploaded to the streaming server (Bunny) separately and attached to its session. One video per session. The recording's languages are handled with subtitle tracks, not with the file name.

## Transcripts (PDF)

Transcripts are attached at the **event** level, and an event may have more than one. Tag each with its language so the app shows the right one:

```
Shantideva chapter 9 [ENG].pdf
Shantideva capitulo 9 [POR].pdf
```
