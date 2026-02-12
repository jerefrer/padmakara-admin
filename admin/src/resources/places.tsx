import {
  List,
  Datagrid,
  TextField,
  DateField,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  required,
  EditButton,
} from "react-admin";

export const PlaceList = () => (
  <List sort={{ field: "name", order: "ASC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <TextField source="name" />
      <TextField source="abbreviation" />
      <TextField source="location" />
      <DateField source="createdAt" />
      <EditButton />
    </Datagrid>
  </List>
);

export const PlaceEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="name" validate={required()} />
      <TextInput source="abbreviation" />
      <TextInput source="location" />
    </SimpleForm>
  </Edit>
);

export const PlaceCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="name" validate={required()} />
      <TextInput source="abbreviation" />
      <TextInput source="location" />
    </SimpleForm>
  </Create>
);
