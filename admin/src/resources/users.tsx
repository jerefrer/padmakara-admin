import {
  List,
  Datagrid,
  TextField,
  EmailField,
  DateField,
  BooleanField,
  Edit,
  SimpleForm,
  Toolbar,
  SaveButton,
  DeleteButton,
  TextInput,
  SelectInput,
  BooleanInput,
  DateTimeInput,
  EditButton,
  useRedirect,
  useTranslate,
  useRecordContext,
  FunctionField,
} from "react-admin";
import { Typography, Divider, Box, Button, Stack } from "@mui/material";

import { ReviewAccountChip, ReviewAccountWarning } from "../components/ReviewAccount";
import { UserAccessSection } from "../components/UserAccessSection";

// ─── List ────────────────────────────────────────────────────────────────────

export const UserList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "createdAt", order: "DESC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <EmailField source="email" label={translate("padmakara.fields.email")} />
        <FunctionField
          label=""
          sortable={false}
          render={(record: any) => <ReviewAccountChip record={record} />}
        />
        <TextField source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextField source="lastName" label={translate("padmakara.fields.lastName")} />
        <TextField source="dharmaName" label={translate("padmakara.fields.dharmaName")} />
        <TextField source="role" label={translate("padmakara.fields.role")} />
        <BooleanField source="isActive" label={translate("padmakara.users.canSignIn")} />
        <TextField source="subscriptionStatus" label={translate("padmakara.users.subscription")} />
        <DateField source="lastActivity" label={translate("padmakara.fields.lastActivity")} showTime />
        <EditButton />
      </Datagrid>
    </List>
  );
};

// ─── Edit ────────────────────────────────────────────────────────────────────

const EditReviewWarning = () => <ReviewAccountWarning record={useRecordContext() as any} />;

/** Cancel leaves without saving; the unsaved-changes warning covers a dirty form. */
const UserEditToolbar = () => {
  const translate = useTranslate();
  const redirect = useRedirect();
  return (
    <Toolbar sx={{ justifyContent: "space-between" }}>
      <Stack direction="row" spacing={1}>
        <SaveButton />
        <Button onClick={() => redirect("list", "users")}>{translate("ra.action.cancel")}</Button>
      </Stack>
      <DeleteButton />
    </Toolbar>
  );
};

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="subtitle1" fontWeight={600} sx={{ mt: 2, mb: 1 }}>
    {children}
  </Typography>
);

export const UserEdit = () => {
  const translate = useTranslate();
  return (
    <Edit mutationMode="pessimistic">
      <SimpleForm warnWhenUnsavedChanges toolbar={<UserEditToolbar />}>
        <EditReviewWarning />
        {/* ─── Identity ──────────────────────────────── */}
        <TextInput source="email" label={translate("padmakara.fields.email")} disabled fullWidth />
        <Stack direction="row" spacing={2} sx={{ width: "100%" }}>
          <TextInput source="firstName" label={translate("padmakara.fields.firstName")} sx={{ flex: 1 }} />
          <TextInput source="lastName" label={translate("padmakara.fields.lastName")} sx={{ flex: 1 }} />
          <TextInput source="dharmaName" label={translate("padmakara.fields.dharmaName")} sx={{ flex: 1 }} />
        </Stack>

        {/* ─── Settings ─────────────────────────────── */}
        <Stack direction="row" spacing={2} sx={{ width: "100%" }}>
          <SelectInput
            source="role"
            label={translate("padmakara.fields.role")}
            choices={[
              { id: "user", name: translate("padmakara.users.roleUser") },
              { id: "admin", name: translate("padmakara.users.roleAdmin") },
            ]}
            sx={{ flex: 1 }}
          />
          <SelectInput
            source="preferredLanguage"
            label={translate("padmakara.fields.preferredLanguage")}
            choices={[
              { id: "en", name: translate("padmakara.users.langEn") },
              { id: "pt", name: translate("padmakara.users.langPt") },
            ]}
            sx={{ flex: 1 }}
          />
        </Stack>
        <Stack direction="row" spacing={4}>
          <BooleanInput
            source="isActive"
            label={translate("padmakara.users.canSignIn")}
            helperText={translate("padmakara.users.canSignInHelp")}
          />
          {/* Set by the first sign-in; the API does not accept changing it. */}
          <BooleanInput
            source="isVerified"
            label={translate("padmakara.fields.isVerified")}
            helperText={translate("padmakara.users.verifiedHelp")}
            disabled
          />
        </Stack>

        {/* ─── Subscription ─────────────────────────── */}
        <Divider sx={{ width: "100%", my: 1 }} />
        <Box sx={{ width: "100%" }}>
      <SectionTitle>{translate("padmakara.users.subscription")}</SectionTitle>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2}>
          <SelectInput
            source="subscriptionStatus"
            label={translate("padmakara.users.subscriptionStatusLabel")}
            choices={[
              { id: "none", name: translate("padmakara.users.subscriptionNone") },
              { id: "active", name: translate("padmakara.users.subscriptionActive") },
              { id: "expired", name: translate("padmakara.users.subscriptionExpired") },
            ]}
            sx={{ flex: 1 }}
          />
          <SelectInput
            source="subscriptionSource"
            label={translate("padmakara.users.subscriptionSourceLabel")}
            choices={[
              { id: "easypay", name: translate("padmakara.users.sourceEasypay") },
              { id: "cash", name: translate("padmakara.users.sourceCash") },
              { id: "admin", name: translate("padmakara.users.sourceAdmin") },
              { id: "bank_transfer", name: translate("padmakara.users.sourceBankTransfer") },
            ]}
            parse={(v: string) => v || null}
            emptyText={translate("padmakara.common.notSet")}
            sx={{ flex: 1 }}
          />
        </Stack>
        <DateTimeInput
          source="subscriptionExpiresAt"
          label={translate("padmakara.users.subscriptionExpiresAtLabel")}
          fullWidth
        />
        <TextInput
          source="subscriptionNotes"
          label={translate("padmakara.users.subscriptionNotesLabel")}
          multiline
          minRows={3}
          fullWidth
        />
      </Stack>
        </Box>

        {/* ─── Access ───────────────────────────────── */}
        <Divider sx={{ width: "100%", my: 1 }} />
        <SectionTitle>{translate("padmakara.users.access")}</SectionTitle>
        <UserAccessSection />
      </SimpleForm>
    </Edit>
  );
};
