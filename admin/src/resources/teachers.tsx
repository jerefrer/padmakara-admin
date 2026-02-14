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
  useTranslate,
} from "react-admin";

export const TeacherList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "name", order: "ASC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <TextField source="id" />
        <TextField source="name" label={translate("padmakara.fields.name")} />
        <TextField source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <DateField source="createdAt" />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const TeacherEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} validate={required()} />
        <TextInput source="photoUrl" label={translate("padmakara.fields.photoUrl")} />
      </SimpleForm>
    </Edit>
  );
};

export const TeacherCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} validate={required()} />
        <TextInput source="photoUrl" label={translate("padmakara.fields.photoUrl")} />
      </SimpleForm>
    </Create>
  );
};
