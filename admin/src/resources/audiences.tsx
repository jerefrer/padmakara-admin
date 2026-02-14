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
  useTranslate,
} from "react-admin";

export const AudienceList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "displayOrder", order: "ASC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <TextField source="id" />
        <TextField source="nameEn" label={translate("padmakara.fields.nameEn")} />
        <TextField source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextField source="slug" label={translate("padmakara.fields.slug")} />
        <NumberField source="displayOrder" label={translate("padmakara.fields.displayOrder")} />
        <DateField source="createdAt" />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const AudienceEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <NumberInput source="displayOrder" label={translate("padmakara.fields.displayOrder")} />
      </SimpleForm>
    </Edit>
  );
};

export const AudienceCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <NumberInput source="displayOrder" label={translate("padmakara.fields.displayOrder")} defaultValue={0} />
      </SimpleForm>
    </Create>
  );
};
