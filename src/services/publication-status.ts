/**
 * Publication statuses, mirroring the event ones (see eventStatusVisibleTo /
 * eventStatusOpenTo in services/access.ts):
 *
 * - draft: being prepared; only admins see it.
 * - forthcoming: announced in the app to the people its audience lets in, but
 *   its file (the PDF) is served to admins only.
 * - published: listed and opened as the audience decides.
 *
 * Any other value is neither listed nor opened, for admins too: a status
 * nobody handled must not fall open.
 */
export const PUBLICATION_STATUSES = ["draft", "forthcoming", "published"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

function isAdminRole(role: string | null | undefined): boolean {
  return role === "admin" || role === "superadmin";
}

/** Statuses a caller of this role may SEE in the app (lists, event pages). */
export function publicationStatusVisibleTo(role: string | null | undefined): string[] {
  return isAdminRole(role) ? ["published", "forthcoming", "draft"] : ["published", "forthcoming"];
}

/** Statuses whose FILE a caller of this role may open. */
export function publicationStatusOpenTo(role: string | null | undefined): string[] {
  return isAdminRole(role) ? ["published", "forthcoming", "draft"] : ["published"];
}
