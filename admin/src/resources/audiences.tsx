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

export const AudienceList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "displayOrder", order: "ASC" }} perPage={100} pagination={false}>
      <SortableList
        resource="audiences"
        columns={[
          { source: "nameEn", label: translate("padmakara.fields.nameEn") },
          { source: "namePt", label: translate("padmakara.fields.namePt") },
          { source: "slug", label: translate("padmakara.fields.slug") },
        ]}
      />
    </List>
  );
};

export const AudienceEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<NoDeleteToolbar />}>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
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
      </SimpleForm>
    </Create>
  );
};
