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

export const PlaceList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "name", order: "ASC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <TextField source="id" />
        <TextField source="name" label={translate("padmakara.fields.name")} />
        <TextField source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextField source="location" label={translate("padmakara.fields.location")} />
        <DateField source="createdAt" />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const PlaceEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="location" label={translate("padmakara.fields.location")} />
      </SimpleForm>
    </Edit>
  );
};

export const PlaceCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="location" label={translate("padmakara.fields.location")} />
      </SimpleForm>
    </Create>
  );
};
