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
import { MigrationList, MigrationCreate, MigrationShow } from "./resources/migrations";

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
      name="migrations"
      options={{ label: "Migrations" }}
      list={MigrationList}
      create={MigrationCreate}
      show={MigrationShow}
    />
  </Admin>
);

export default App;
