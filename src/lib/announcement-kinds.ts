/** The content an admin can announce by email once the audio is out, in the order the email lists it. */
export const ANNOUNCEMENT_KINDS = ["transcripts", "videos", "texts"] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];
