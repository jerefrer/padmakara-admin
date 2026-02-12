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

export const TeacherList = () => (
  <List sort={{ field: "name", order: "ASC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <TextField source="name" />
      <TextField source="abbreviation" />
      <DateField source="createdAt" />
      <EditButton />
    </Datagrid>
  </List>
);

export const TeacherEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="name" validate={required()} />
      <TextInput source="abbreviation" validate={required()} />
      <TextInput source="photoUrl" />
    </SimpleForm>
  </Edit>
);

export const TeacherCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="name" validate={required()} />
      <TextInput source="abbreviation" validate={required()} />
      <TextInput source="photoUrl" />
    </SimpleForm>
  </Create>
);
