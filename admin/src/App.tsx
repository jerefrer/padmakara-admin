import { Admin, Resource } from "react-admin";
import { dataProvider } from "./dataProvider";
import { authProvider } from "./authProvider";
import { i18nProvider } from "./i18n";
import { theme } from "./theme";
import { Layout } from "./layout/Layout";

import { TeacherList, TeacherEdit, TeacherCreate } from "./resources/teachers";
import { PlaceList, PlaceEdit, PlaceCreate } from "./resources/places";
import { GroupList, GroupEdit, GroupCreate } from "./resources/groups";
import { EventList, EventEdit, EventCreate } from "./resources/events";
import { EventTypeList, EventTypeEdit, EventTypeCreate } from "./resources/event-types";
import { AudienceList, AudienceEdit, AudienceCreate } from "./resources/audiences";
import { UserList, UserEdit } from "./resources/users";
import { ApprovalList } from "./resources/approvals";
import { PublicationList, PublicationEdit, PublicationCreate } from "./resources/publications";

const App = () => (
  <Admin
    dataProvider={dataProvider}
    authProvider={authProvider}
    i18nProvider={i18nProvider}
    theme={theme}
    layout={Layout}
    title="Padmakara"
  >
    <Resource
      name="events"
      options={{ label: "Events" }}
      list={EventList}
      edit={EventEdit}
      create={EventCreate}
    />
    <Resource
      name="groups"
      options={{ label: "Retreat Groups" }}
      list={GroupList}
      edit={GroupEdit}
      create={GroupCreate}
    />
    <Resource
      name="event-types"
      options={{ label: "Event Types" }}
      list={EventTypeList}
      edit={EventTypeEdit}
      create={EventTypeCreate}
    />
    <Resource
      name="audiences"
      options={{ label: "Audiences" }}
      list={AudienceList}
      edit={AudienceEdit}
      create={AudienceCreate}
    />
    <Resource
      name="teachers"
      options={{ label: "Teachers" }}
      list={TeacherList}
      edit={TeacherEdit}
      create={TeacherCreate}
    />
    <Resource
      name="places"
      options={{ label: "Places" }}
      list={PlaceList}
      edit={PlaceEdit}
      create={PlaceCreate}
    />
    <Resource
      name="users"
      options={{ label: "Users" }}
      list={UserList}
      edit={UserEdit}
    />
    <Resource
      name="approvals"
      options={{ label: "Approvals" }}
      list={ApprovalList}
    />
    <Resource
      name="publications"
      options={{ label: "Publications" }}
      list={PublicationList}
      edit={PublicationEdit}
      create={PublicationCreate}
    />
    {/* List-less resources: used programmatically via the data provider
        from the event form (Documents section, transcript persistence) —
        no dedicated list/edit/create screens. */}
    <Resource name="event-files" />
    <Resource name="transcripts" />
  </Admin>
);

export default App;
