import {
  List,
  Datagrid,
  TextField,
  NumberField,
  DateField,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  NumberInput,
  required,
  EditButton,
} from "react-admin";

export const GroupList = () => (
  <List sort={{ field: "displayOrder", order: "ASC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <TextField source="nameEn" label="Name (EN)" />
      <TextField source="namePt" label="Name (PT)" />
      <TextField source="slug" />
      <NumberField source="displayOrder" />
      <DateField source="createdAt" />
      <EditButton />
    </Datagrid>
  </List>
);

export const GroupEdit = () => (
  <Edit>
    <SimpleForm>
      <TextInput source="nameEn" label="Name (EN)" validate={required()} />
      <TextInput source="namePt" label="Name (PT)" />
      <TextInput source="slug" validate={required()} />
      <TextInput source="description" multiline />
      <TextInput source="logoUrl" label="Logo URL" />
      <NumberInput source="displayOrder" />
    </SimpleForm>
  </Edit>
);

export const GroupCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="nameEn" label="Name (EN)" validate={required()} />
      <TextInput source="namePt" label="Name (PT)" />
      <TextInput source="slug" validate={required()} />
      <TextInput source="description" multiline />
      <TextInput source="logoUrl" label="Logo URL" />
      <NumberInput source="displayOrder" defaultValue={0} />
    </SimpleForm>
  </Create>
);
