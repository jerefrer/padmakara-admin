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
  useRecordContext,
} from "react-admin";
import { SortableList } from "../components/SortableList";

// Mirrors AUDIENCE_SLUGS in src/services/access.ts: the access rules match on
// these slugs, so the API refuses to change them (409) and the form locks them.
const BUILT_IN_SLUGS = new Set([
  "free-anyone",
  "free-subscribers",
  "retreat-group-members",
  "event-participants",
  "available-on-request-only",
  "received-initiation",
  "restricted",
]);

const SlugInput = () => {
  const translate = useTranslate();
  const record = useRecordContext<{ slug?: string }>();
  const locked = !!record?.slug && BUILT_IN_SLUGS.has(record.slug);
  return (
    <TextInput
      source="slug"
      label={translate("padmakara.fields.slug")}
      validate={required()}
      disabled={locked}
      helperText={locked ? translate("padmakara.audiences.slugLocked") : undefined}
    />
  );
};

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
        <SlugInput />
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
