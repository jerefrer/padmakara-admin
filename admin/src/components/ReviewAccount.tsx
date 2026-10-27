import { useTranslate } from "react-admin";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";

/** Small "Review account" tag for the users list. Renders nothing for other users. */
export const ReviewAccountChip = ({ record }: { record?: { isReviewAccount?: boolean } }) => {
  const translate = useTranslate();
  if (!record?.isReviewAccount) return null;
  return (
    <Chip
      size="small"
      color="warning"
      label={translate("padmakara.users.reviewAccount")}
      data-testid="review-account-chip"
    />
  );
};

/** Warning shown on the user's edit page when it is the store-review account. */
export const ReviewAccountWarning = ({ record }: { record?: { isReviewAccount?: boolean } }) => {
  const translate = useTranslate();
  if (!record?.isReviewAccount) return null;
  return (
    <Alert severity="warning" sx={{ width: "100%", mb: 2 }} data-testid="review-account-warning">
      <ReviewAccountChip record={record} />{" "}
      {translate("padmakara.users.reviewAccountWarning")}
    </Alert>
  );
};
