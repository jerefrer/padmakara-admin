import { ImageSetUpload } from "./ImageSetUpload";

/** Avatar and hero editor of a retreat group (reads the react-admin record). */
export function GroupImageUpload() {
  return <ImageSetUpload resource="groups" />;
}
