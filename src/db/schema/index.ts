// Core content
export { teachers } from "./teachers.ts";
export { places } from "./places.ts";
export { retreatGroups } from "./retreat-groups.ts";
export { eventTypes } from "./event-types.ts";
export { audiences } from "./audiences.ts";
export {
  events,
  eventTeachers,
  eventRetreatGroups,
  eventPlaces,
  eventsRelations,
  eventTeachersRelations,
  eventRetreatGroupsRelations,
  eventPlacesRelations,
} from "./retreats.ts";
export { sessions, sessionsRelations } from "./sessions.ts";
export { eventVideos, eventVideosRelations } from "./event-videos.ts";
export { tracks, tracksRelations } from "./tracks.ts";
export { transcripts, transcriptsRelations } from "./transcripts.ts";
export { eventFiles, eventFilesRelations } from "./event-files.ts";

// Publications
export {
  publications,
  eventPublications,
  publicationsRelations,
  eventPublicationsRelations,
} from "./publications.ts";

// Users
export {
  users,
  userGroupMemberships,
  userEventAttendance,
  usersRelations,
  userGroupMembershipsRelations,
  userEventAttendanceRelations,
} from "./users.ts";

// Auth
export {
  refreshTokens,
  magicLinkTokens,
  deviceActivations,
  userApprovalRequests,
  refreshTokensRelations,
  deviceActivationsRelations,
  userApprovalRequestsRelations,
} from "./auth.ts";

// User content
export {
  userProgress,
  bookmarks,
  eventBookmarks,
  trackBookmarks,
  userProgressRelations,
  bookmarksRelations,
  eventBookmarksRelations,
  trackBookmarksRelations,
} from "./user-content.ts";

// Video progress (per event-video, distinct from track-level userProgress)
export {
  videoProgress,
  videoProgressRelations,
} from "./video-progress.ts";

// Download requests
export {
  downloadRequests,
  downloadRequestsRelations,
} from "./download-requests.ts";

// Read-along jobs
export {
  readAlongJobs,
  readAlongJobsRelations,
} from "./read-along-jobs.ts";

// Subtitle jobs and per-video subtitles
export {
  subtitleJobs,
  subtitleJobsRelations,
} from "./subtitle-jobs.ts";
export {
  videoSubtitles,
  videoSubtitlesRelations,
} from "./video-subtitles.ts";

// Sync versioning
export { syncVersions } from "./sync-versions.ts";
export type { SyncVersion } from "./sync-versions.ts";
export { userSyncVersions } from "./user-sync-versions.ts";
export type { UserSyncVersion } from "./user-sync-versions.ts";
