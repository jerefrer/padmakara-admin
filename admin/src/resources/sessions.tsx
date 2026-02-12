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
  DateInput,
  SelectInput,
  ReferenceInput,
  ReferenceField,
  required,
  EditButton,
  ReferenceManyField,
} from "react-admin";

export const SessionList = () => (
  <List sort={{ field: "sessionNumber", order: "ASC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <ReferenceField source="retreatId" reference="admin/retreats" link="edit">
        <TextField source="eventCode" />
      </ReferenceField>
      <NumberField source="sessionNumber" label="#" />
      <TextField source="titleEn" label="Title (EN)" />
      <DateField source="sessionDate" />
      <TextField source="timePeriod" />
      <EditButton />
    </Datagrid>
  </List>
);

export const SessionEdit = () => (
  <Edit>
    <SimpleForm>
      <ReferenceInput source="retreatId" reference="admin/retreats">
        <SelectInput optionText="eventCode" disabled />
      </ReferenceInput>
      <NumberInput source="sessionNumber" validate={required()} />
      <TextInput source="titleEn" label="Title (EN)" fullWidth />
      <TextInput source="titlePt" label="Title (PT)" fullWidth />
      <DateInput source="sessionDate" />
      <SelectInput
        source="timePeriod"
        choices={[
          { id: "morning", name: "Morning" },
          { id: "afternoon", name: "Afternoon" },
          { id: "evening", name: "Evening" },
        ]}
      />
      <TextInput source="description" multiline fullWidth />

      <ReferenceManyField
        label="Tracks"
        reference="admin/tracks"
        target="sessionId"
        sort={{ field: "trackNumber", order: "ASC" }}
      >
        <Datagrid rowClick="edit">
          <NumberField source="trackNumber" label="#" />
          <TextField source="title" />
          <TextField source="language" />
          <NumberField source="durationSeconds" label="Duration (s)" />
          <EditButton />
        </Datagrid>
      </ReferenceManyField>
    </SimpleForm>
  </Edit>
);

export const SessionCreate = () => (
  <Create>
    <SimpleForm>
      <ReferenceInput source="retreatId" reference="admin/retreats">
        <SelectInput optionText="eventCode" validate={required()} />
      </ReferenceInput>
      <NumberInput source="sessionNumber" validate={required()} />
      <TextInput source="titleEn" label="Title (EN)" fullWidth />
      <TextInput source="titlePt" label="Title (PT)" fullWidth />
      <DateInput source="sessionDate" />
      <SelectInput
        source="timePeriod"
        choices={[
          { id: "morning", name: "Morning" },
          { id: "afternoon", name: "Afternoon" },
          { id: "evening", name: "Evening" },
        ]}
      />
      <TextInput source="description" multiline fullWidth />
    </SimpleForm>
  </Create>
);
