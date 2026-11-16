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
  useGetIdentity,
  usePermissions,
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

/**
 * What the signed-in admin may change on this account; mirrors the API rules
 * (src/routes/admin/users.ts), which enforce them. Roles, and sign-in or deletion of
 * an admin account, are superadmin-only; nobody changes or deletes their own account.
 */
const useAccountControls = () => {
  const record = useRecordContext();
  const { permissions } = usePermissions();
  const { identity } = useGetIdentity();
  const isSuperadmin = permissions === "superadmin";
  const isSelf = record != null && identity != null && String(record.id) === String(identity.id);
  const isStaff = record?.role === "admin" || record?.role === "superadmin";
  return {
    isSuperadmin,
    canChangeRole: isSuperadmin && !isSelf,
    canChangeSignIn: !isSelf && (isSuperadmin || !isStaff),
    canDelete: !isSelf && (isSuperadmin || !isStaff),
  };
};

/** Cancel leaves without saving; the unsaved-changes warning covers a dirty form. */
const UserEditToolbar = () => {
  const translate = useTranslate();
  const redirect = useRedirect();
  const { canDelete } = useAccountControls();
  return (
    <Toolbar sx={{ justifyContent: "space-between" }}>
      <Stack direction="row" spacing={1}>
        <SaveButton />
        <Button onClick={() => redirect("list", "users")}>{translate("ra.action.cancel")}</Button>
      </Stack>
      {canDelete && <DeleteButton />}
    </Toolbar>
  );
};

const RoleInput = () => {
  const translate = useTranslate();
  const { isSuperadmin, canChangeRole } = useAccountControls();
  const record = useRecordContext();
  const choices = [
    { id: "user", name: translate("padmakara.users.roleUser") },
    { id: "admin", name: translate("padmakara.users.roleAdmin") },
  ];
  if (isSuperadmin || record?.role === "superadmin") {
    choices.push({ id: "superadmin", name: translate("padmakara.users.roleSuperadmin") });
  }
  return (
    <SelectInput
      source="role"
      label={translate("padmakara.fields.role")}
      choices={choices}
      disabled={!canChangeRole}
      sx={{ flex: 1 }}
    />
  );
};

const SignInInput = () => {
  const translate = useTranslate();
  const { canChangeSignIn } = useAccountControls();
  return (
    <BooleanInput
      source="isActive"
      label={translate("padmakara.users.canSignIn")}
      helperText={translate("padmakara.users.canSignInHelp")}
      disabled={!canChangeSignIn}
    />
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
          <RoleInput />
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
          <SignInInput />
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
