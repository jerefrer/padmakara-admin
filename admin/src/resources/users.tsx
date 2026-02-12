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
} from "react-admin";

export const UserList = () => (
  <List sort={{ field: "createdAt", order: "DESC" }}>
    <Datagrid rowClick="show">
      <TextField source="id" />
      <EmailField source="email" />
      <TextField source="firstName" />
      <TextField source="lastName" />
      <TextField source="dharmaName" />
      <TextField source="role" />
      <BooleanField source="isActive" />
      <BooleanField source="isVerified" />
      <DateField source="lastActivity" showTime />
      <EditButton />
    </Datagrid>
  </List>
);

export const UserShow = () => (
  <Show>
    <SimpleShowLayout>
      <TextField source="email" />
      <TextField source="firstName" />
      <TextField source="lastName" />
      <TextField source="dharmaName" />
      <TextField source="preferredLanguage" />
      <TextField source="role" />
      <BooleanField source="isActive" />
      <BooleanField source="isVerified" />
      <DateField source="createdAt" showTime />
      <DateField source="lastActivity" showTime />
      <ReferenceManyField label="Group Memberships" reference="groups" target="userId">
        <Datagrid>
          <TextField source="nameEn" label="Group" />
        </Datagrid>
      </ReferenceManyField>
    </SimpleShowLayout>
  </Show>
);

export const UserEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="email" disabled />
      <TextInput source="firstName" />
      <TextInput source="lastName" />
      <TextInput source="dharmaName" />
      <SelectInput
        source="preferredLanguage"
        choices={[
          { id: "en", name: "English" },
          { id: "pt", name: "Portuguese" },
        ]}
      />
      <SelectInput
        source="role"
        choices={[
          { id: "user", name: "User" },
          { id: "admin", name: "Admin" },
        ]}
      />
      <BooleanInput source="isActive" />
      <BooleanInput source="isVerified" />
    </SimpleForm>
  </Edit>
);
