import {
  List,
  Datagrid,
  TextField,
  EmailField,
  DateField,
  BooleanField,
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  BooleanInput,
  EditButton,
  Show,
  SimpleShowLayout,
  ReferenceManyField,
  useTranslate,
} from "react-admin";

export const UserList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "createdAt", order: "DESC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="show">
        <TextField source="id" />
        <EmailField source="email" label={translate("padmakara.fields.email")} />
        <TextField source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextField source="lastName" label={translate("padmakara.fields.lastName")} />
        <TextField source="dharmaName" label={translate("padmakara.fields.dharmaName")} />
        <TextField source="role" label={translate("padmakara.fields.role")} />
        <BooleanField source="isActive" label={translate("padmakara.fields.isActive")} />
        <BooleanField source="isVerified" label={translate("padmakara.fields.isVerified")} />
        <DateField source="lastActivity" label={translate("padmakara.fields.lastActivity")} showTime />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const UserShow = () => {
  const translate = useTranslate();
  return (
    <Show>
      <SimpleShowLayout>
        <TextField source="email" label={translate("padmakara.fields.email")} />
        <TextField source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextField source="lastName" label={translate("padmakara.fields.lastName")} />
        <TextField source="dharmaName" label={translate("padmakara.fields.dharmaName")} />
        <TextField source="preferredLanguage" label={translate("padmakara.fields.preferredLanguage")} />
        <TextField source="role" label={translate("padmakara.fields.role")} />
        <BooleanField source="isActive" label={translate("padmakara.fields.isActive")} />
        <BooleanField source="isVerified" label={translate("padmakara.fields.isVerified")} />
        <DateField source="createdAt" showTime />
        <DateField source="lastActivity" label={translate("padmakara.fields.lastActivity")} showTime />
        <ReferenceManyField label={translate("padmakara.fields.groupMemberships")} reference="groups" target="userId">
          <Datagrid>
            <TextField source="nameEn" label={translate("padmakara.fields.group")} />
          </Datagrid>
        </ReferenceManyField>
      </SimpleShowLayout>
    </Show>
  );
};

export const UserEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm>
        <TextInput source="email" label={translate("padmakara.fields.email")} disabled />
        <TextInput source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextInput source="lastName" label={translate("padmakara.fields.lastName")} />
        <TextInput source="dharmaName" label={translate("padmakara.fields.dharmaName")} />
        <SelectInput
          source="preferredLanguage"
          label={translate("padmakara.fields.preferredLanguage")}
          choices={[
            { id: "en", name: translate("padmakara.users.langEn") },
            { id: "pt", name: translate("padmakara.users.langPt") },
          ]}
        />
        <SelectInput
          source="role"
          label={translate("padmakara.fields.role")}
          choices={[
            { id: "user", name: translate("padmakara.users.roleUser") },
            { id: "admin", name: translate("padmakara.users.roleAdmin") },
          ]}
        />
        <BooleanInput source="isActive" label={translate("padmakara.fields.isActive")} />
        <BooleanInput source="isVerified" label={translate("padmakara.fields.isVerified")} />
      </SimpleForm>
    </Edit>
  );
};
