import { Admin, Resource, CustomRoutes } from "react-admin";
import { dataProvider } from "./dataProvider";
import { authProvider } from "./authProvider";

import { TeacherList, TeacherEdit, TeacherCreate } from "./resources/teachers";
import { PlaceList, PlaceEdit, PlaceCreate } from "./resources/places";
import { GroupList, GroupEdit, GroupCreate } from "./resources/groups";
import { RetreatList, RetreatEdit, RetreatCreate } from "./resources/retreats";
import { SessionList, SessionEdit, SessionCreate } from "./resources/sessions";
import { TrackList, TrackEdit, TrackCreate } from "./resources/tracks";
import { UserList, UserShow, UserEdit } from "./resources/users";

const App = () => (
  <Admin dataProvider={dataProvider} authProvider={authProvider} basename="/admin">
    <Resource
      name="admin/retreats"
      options={{ label: "Retreats" }}
      list={RetreatList}
      edit={RetreatEdit}
      create={RetreatCreate}
    />
    <Resource
      name="admin/sessions"
      options={{ label: "Sessions" }}
      list={SessionList}
      edit={SessionEdit}
      create={SessionCreate}
    />
    <Resource
      name="admin/tracks"
      options={{ label: "Tracks" }}
      list={TrackList}
      edit={TrackEdit}
      create={TrackCreate}
    />
    <Resource
      name="admin/groups"
      options={{ label: "Groups" }}
      list={GroupList}
      edit={GroupEdit}
      create={GroupCreate}
    />
    <Resource
      name="admin/teachers"
      options={{ label: "Teachers" }}
      list={TeacherList}
      edit={TeacherEdit}
      create={TeacherCreate}
    />
    <Resource
      name="admin/places"
      options={{ label: "Places" }}
      list={PlaceList}
      edit={PlaceEdit}
      create={PlaceCreate}
    />
    <Resource
      name="admin/users"
      options={{ label: "Users" }}
      list={UserList}
      show={UserShow}
      edit={UserEdit}
    />
  </Admin>
);

export default App;
