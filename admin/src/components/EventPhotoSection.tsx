import { ImageSetUpload } from "./ImageSetUpload";

/**
 * The optional photo of an event, e.g. a photo of several teachers together. When set it
 * replaces the teachers' photos wherever the app shows the event. The square thumbnail is
 * derived from the framing chosen here, so there is a single image to manage.
 */
export function EventPhotoSection({ record, onChanged }: { record: Record<string, unknown>; onChanged?: () => void }) {
  return (
    <ImageSetUpload
      resource="events"
      record={record}
      showAvatar={false}
      heroTitle="Event photo (as it appears in the app)"
      heroDropLabel="Drop the event photo here or click to browse"
      heroUploadLabel="Upload photo"
      heroReplaceLabel="Replace photo"
      hint="Optional. Replaces the teachers' photos for this event, e.g. a photo of several teachers together."
      removePath="photo"
      removeLabel="Remove photo"
      onChanged={onChanged}
    />
  );
}
