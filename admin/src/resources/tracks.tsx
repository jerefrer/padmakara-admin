import {
  List,
  Datagrid,
  TextField,
  NumberField,
  DateField,
  BooleanField,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  NumberInput,
  SelectInput,
  BooleanInput,
  ReferenceInput,
  ReferenceField,
  required,
  EditButton,
} from "react-admin";

export const TrackList = () => (
  <List sort={{ field: "trackNumber", order: "ASC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <ReferenceField source="sessionId" reference="admin/sessions" link="edit">
        <TextField source="titleEn" />
      </ReferenceField>
      <NumberField source="trackNumber" label="#" />
      <TextField source="title" />
      <TextField source="language" />
      <BooleanField source="isTranslation" />
      <NumberField source="durationSeconds" label="Duration (s)" />
      <EditButton />
    </Datagrid>
  </List>
);

export const TrackEdit = () => (
  <Edit>
    <SimpleForm>
      <ReferenceInput source="sessionId" reference="admin/sessions">
        <SelectInput optionText="titleEn" disabled />
      </ReferenceInput>
      <TextInput source="title" validate={required()} fullWidth />
      <NumberInput source="trackNumber" validate={required()} />
      <SelectInput
        source="language"
        choices={[
          { id: "en", name: "English" },
          { id: "pt", name: "Portuguese" },
          { id: "tib", name: "Tibetan" },
          { id: "fr", name: "French" },
        ]}
      />
      <BooleanInput source="isTranslation" />
      <TextInput source="s3Key" label="S3 Key" fullWidth />
      <NumberInput source="durationSeconds" label="Duration (seconds)" />
      <NumberInput source="fileSizeBytes" label="File Size (bytes)" />
      <TextInput source="originalFilename" fullWidth />
    </SimpleForm>
  </Edit>
);

export const TrackCreate = () => (
  <Create>
    <SimpleForm>
      <ReferenceInput source="sessionId" reference="admin/sessions">
        <SelectInput optionText="titleEn" validate={required()} />
      </ReferenceInput>
      <TextInput source="title" validate={required()} fullWidth />
      <NumberInput source="trackNumber" validate={required()} />
      <SelectInput
        source="language"
        defaultValue="en"
        choices={[
          { id: "en", name: "English" },
          { id: "pt", name: "Portuguese" },
          { id: "tib", name: "Tibetan" },
          { id: "fr", name: "French" },
        ]}
      />
      <BooleanInput source="isTranslation" defaultValue={false} />
      <TextInput source="s3Key" label="S3 Key" fullWidth />
      <NumberInput source="durationSeconds" label="Duration (seconds)" />
      <NumberInput source="fileSizeBytes" label="File Size (bytes)" />
      <TextInput source="originalFilename" fullWidth />
    </SimpleForm>
  </Create>
);
