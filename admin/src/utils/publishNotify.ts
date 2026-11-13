import type { PublishOptions } from "../components/EventStatusControls";

/** JSON body of POST /events/:id/notify-published: the personal message only when there is one. */
export function notifyPublishedBody(options: PublishOptions): string {
  const message = options.message?.trim();
  return JSON.stringify(message ? { message } : {});
}
