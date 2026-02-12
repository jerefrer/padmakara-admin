import {
  List,
  Datagrid,
  TextField,
  DateField,
  Edit,
  Create,
  SimpleForm,
  TabbedForm,
  TextInput,
  DateInput,
  SelectInput,
  ReferenceArrayInput,
  AutocompleteArrayInput,
  required,
  EditButton,
  ReferenceManyField,
  useRecordContext,
  ArrayField,
  SingleFieldList,
  ChipField,
  FunctionField,
} from "react-admin";

export const RetreatList = () => (
  <List sort={{ field: "startDate", order: "DESC" }}>
    <Datagrid rowClick="edit">
      <TextField source="id" />
      <TextField source="eventCode" label="Code" />
      <TextField source="titleEn" label="Title (EN)" />
      <DateField source="startDate" />
      <DateField source="endDate" />
      <TextField source="status" />
      <DateField source="createdAt" />
      <EditButton />
    </Datagrid>
  </List>
);

const SessionsTab = () => {
  const record = useRecordContext();
  if (!record) return null;
  return (
    <ReferenceManyField
      label="Sessions"
      reference="admin/sessions"
      target="retreatId"
      sort={{ field: "sessionNumber", order: "ASC" }}
    >
      <Datagrid rowClick="edit">
        <TextField source="sessionNumber" label="#" />
        <TextField source="titleEn" label="Title (EN)" />
        <TextField source="titlePt" label="Title (PT)" />
        <DateField source="sessionDate" />
        <TextField source="timePeriod" />
        <EditButton />
      </Datagrid>
    </ReferenceManyField>
  );
};

export const RetreatEdit = () => (
  <Edit>
    <TabbedForm>
      <TabbedForm.Tab label="Details">
        <TextInput source="eventCode" validate={required()} />
        <TextInput source="titleEn" label="Title (EN)" validate={required()} fullWidth />
        <TextInput source="titlePt" label="Title (PT)" fullWidth />
        <TextInput source="descriptionEn" label="Description (EN)" multiline fullWidth />
        <TextInput source="descriptionPt" label="Description (PT)" multiline fullWidth />
        <DateInput source="startDate" />
        <DateInput source="endDate" />
        <TextInput source="designation" />
        <TextInput source="audience" />
        <TextInput source="bibliography" multiline fullWidth />
        <TextInput source="sessionThemes" multiline fullWidth />
        <TextInput source="notes" multiline fullWidth />
        <SelectInput
          source="status"
          choices={[
            { id: "draft", name: "Draft" },
            { id: "published", name: "Published" },
            { id: "archived", name: "Archived" },
          ]}
        />
        <TextInput source="imageUrl" label="Image URL" fullWidth />
        <TextInput source="s3Prefix" label="S3 Prefix" fullWidth />
      </TabbedForm.Tab>

      <TabbedForm.Tab label="Associations">
        <ReferenceArrayInput source="teacherIds" reference="admin/teachers">
          <AutocompleteArrayInput optionText="name" />
        </ReferenceArrayInput>
        <ReferenceArrayInput source="groupIds" reference="admin/groups">
          <AutocompleteArrayInput optionText="nameEn" />
        </ReferenceArrayInput>
        <ReferenceArrayInput source="placeIds" reference="admin/places">
          <AutocompleteArrayInput optionText="name" />
        </ReferenceArrayInput>
      </TabbedForm.Tab>

      <TabbedForm.Tab label="Sessions">
        <SessionsTab />
      </TabbedForm.Tab>
    </TabbedForm>
  </Edit>
);

export const RetreatCreate = () => (
  <Create>
    <SimpleForm>
      <TextInput source="eventCode" validate={required()} />
      <TextInput source="titleEn" label="Title (EN)" validate={required()} fullWidth />
      <TextInput source="titlePt" label="Title (PT)" fullWidth />
      <TextInput source="descriptionEn" label="Description (EN)" multiline fullWidth />
      <TextInput source="descriptionPt" label="Description (PT)" multiline fullWidth />
      <DateInput source="startDate" />
      <DateInput source="endDate" />
      <TextInput source="designation" />
      <TextInput source="audience" />
      <SelectInput
        source="status"
        defaultValue="draft"
        choices={[
          { id: "draft", name: "Draft" },
          { id: "published", name: "Published" },
          { id: "archived", name: "Archived" },
        ]}
      />
      <TextInput source="imageUrl" label="Image URL" fullWidth />
      <ReferenceArrayInput source="teacherIds" reference="admin/teachers">
        <AutocompleteArrayInput optionText="name" />
      </ReferenceArrayInput>
      <ReferenceArrayInput source="groupIds" reference="admin/groups">
        <AutocompleteArrayInput optionText="nameEn" />
      </ReferenceArrayInput>
      <ReferenceArrayInput source="placeIds" reference="admin/places">
        <AutocompleteArrayInput optionText="name" />
      </ReferenceArrayInput>
    </SimpleForm>
  </Create>
);
