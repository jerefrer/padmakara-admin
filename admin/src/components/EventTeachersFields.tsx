/**
 * The event's teachers, split as in the old Wix database (André): the main
 * teachers, the phrase that introduces the others ("with the presence of",
 * "&", ...), and the guests / other teachers. The app shows the main teachers
 * as before and the guests on a smaller second line, so a visiting teacher's
 * few sessions are not given the weight of the main teachings.
 *
 * Both pickers edit one ordered list (`selected`: main teachers first, then the
 * guests) plus the ids saved with the 'guest' role; the list order is the
 * display order the API stores.
 */

import MenuItem from "@mui/material/MenuItem";
import MuiTextField from "@mui/material/TextField";
import Grid from "@mui/material/Grid";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslate } from "react-admin";
import { CheckboxMultiSelect } from "./CheckboxMultiSelect";

/** Same keys as the API (src/lib/guest-intro.ts); null = the default phrase. */
export const GUEST_INTRO_KEYS = [
  "with_presence_of",
  "and",
  "practice_sessions_by",
  "with_visit_of",
  "with_guest",
] as const;
export type GuestIntro = (typeof GUEST_INTRO_KEYS)[number];
const DEFAULT_GUEST_INTRO: GuestIntro = "with_presence_of";

export interface TeacherPick {
  id: number;
  name: string;
  abbreviation: string;
}

export interface EventTeachersFieldsProps<T extends TeacherPick> {
  allTeachers: T[];
  /** Main teachers first, then the guests. */
  selected: T[];
  guestIds: number[];
  guestIntro: GuestIntro | null;
  onChange: (next: { selected: T[]; guestIds: number[] }) => void;
  onGuestIntroChange: (next: GuestIntro | null) => void;
}

/**
 * The API's `teacherIds`: main teachers first, then the guests, each in the order
 * picked (the API stores that order as the display order).
 */
export function teacherIdsPayload(
  selected: TeacherPick[],
  guestIds: number[],
): { id: number; role: "teacher" | "guest" }[] {
  const guestSet = new Set(guestIds);
  return [
    ...selected.filter((t) => !guestSet.has(t.id)).map((t) => ({ id: t.id, role: "teacher" as const })),
    ...selected.filter((t) => guestSet.has(t.id)).map((t) => ({ id: t.id, role: "guest" as const })),
  ];
}

/** An event's saved teachers in display order (main first, then guests, by position). */
export function orderedEventTeacherIds(
  links: { teacherId: number; role?: string | null; position?: number | null }[] | null | undefined,
): number[] {
  const rank = (l: { role?: string | null }) => (l.role === "guest" ? 1 : 0);
  return [...(links ?? [])]
    .sort((a, b) => rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0))
    .map((l) => l.teacherId);
}

/** "with the presence of Shechen Rabjam Rinpoche": what the app shows under the main teachers. */
export function guestPreviewLine(
  guests: TeacherPick[],
  guestIntro: GuestIntro | null,
  translate: (key: string) => string,
): string | null {
  if (guests.length === 0) return null;
  const label = translate(`padmakara.events.guestIntroOptions.${guestIntro ?? DEFAULT_GUEST_INTRO}`);
  return `${label} ${guests.map((g) => g.name).join(", ")}`;
}

export function EventTeachersFields<T extends TeacherPick>({
  allTeachers,
  selected,
  guestIds,
  guestIntro,
  onChange,
  onGuestIntroChange,
}: EventTeachersFieldsProps<T>) {
  const translate = useTranslate();
  const guestSet = new Set(guestIds);
  const main = selected.filter((t) => !guestSet.has(t.id));
  const guests = selected.filter((t) => guestSet.has(t.id));
  const label = (o: T) => `${o.name} (${o.abbreviation})`;
  const preview = guestPreviewLine(guests, guestIntro, translate);

  return (
    <>
      <Grid size={{ xs: 12 }}>
        <CheckboxMultiSelect<T>
          options={allTeachers.filter((t) => !guestSet.has(t.id))}
          getOptionLabel={label}
          value={main}
          onChange={(_, v) => onChange({ selected: [...v, ...guests], guestIds })}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          renderInput={(params) => (
            <MuiTextField
              {...params}
              label={translate("padmakara.events.mainTeachers")}
              placeholder={translate("padmakara.events.teachersPlaceholder")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
        />
      </Grid>
      <Grid size={{ xs: 12, sm: 4 }}>
        <MuiTextField
          select
          fullWidth
          label={translate("padmakara.events.guestIntro")}
          value={guestIntro ?? ""}
          onChange={(e) => onGuestIntroChange(e.target.value ? (e.target.value as GuestIntro) : null)}
          slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}
          inputProps={{ "data-testid": "guest-intro-select" }}
        >
          <MenuItem value="">
            <em>{translate("padmakara.events.guestIntroDefault")}</em>
          </MenuItem>
          {GUEST_INTRO_KEYS.map((key) => (
            <MenuItem key={key} value={key}>
              {translate(`padmakara.events.guestIntroOptions.${key}`)}
            </MenuItem>
          ))}
        </MuiTextField>
      </Grid>
      <Grid size={{ xs: 12, sm: 8 }}>
        <CheckboxMultiSelect<T>
          options={allTeachers.filter((t) => !main.some((m) => m.id === t.id))}
          getOptionLabel={label}
          value={guests}
          onChange={(_, v) => onChange({ selected: [...main, ...v], guestIds: v.map((t) => t.id) })}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          renderInput={(params) => (
            <MuiTextField
              {...params}
              label={translate("padmakara.events.guestTeachers")}
              placeholder={translate("padmakara.events.teachersPlaceholder")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
        />
      </Grid>
      {main.length + guests.length > 0 && (
        <Grid size={{ xs: 12 }}>
          <Box data-testid="teachers-preview">
            <Typography variant="caption" color="text.secondary">
              {translate("padmakara.events.teachersPreview")}
            </Typography>
            <Typography variant="body1">{main.map((t) => t.name).join(", ")}</Typography>
            {preview && (
              <Typography variant="body2" color="text.secondary">
                {preview}
              </Typography>
            )}
          </Box>
        </Grid>
      )}
    </>
  );
}
