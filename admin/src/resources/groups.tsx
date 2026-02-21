import {
  List,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  required,
  useTranslate,
  SaveButton,
  Toolbar,
} from "react-admin";
import { SortableList } from "../components/SortableList";

const NoDeleteToolbar = () => (
  <Toolbar>
    <SaveButton />
  </Toolbar>
);

export const GroupList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "displayOrder", order: "ASC" }} perPage={100} pagination={false}>
      <SortableList
        resource="groups"
        columns={[
          { source: "nameEn", label: translate("padmakara.fields.nameEn") },
          { source: "namePt", label: translate("padmakara.fields.namePt") },
          { source: "abbreviation", label: translate("padmakara.fields.abbreviation") },
          { source: "slug", label: translate("padmakara.fields.slug") },
        ]}
      />
    </List>
  );
};

export const GroupEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<NoDeleteToolbar />}>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <TextInput source="description" label={translate("padmakara.fields.description")} multiline />
        <TextInput source="logoUrl" label={translate("padmakara.fields.logoUrl")} />
      </SimpleForm>
    </Edit>
  );
};

export const GroupCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <TextInput source="description" label={translate("padmakara.fields.description")} multiline />
        <TextInput source="logoUrl" label={translate("padmakara.fields.logoUrl")} />
      </SimpleForm>
    </Create>
  );
};
