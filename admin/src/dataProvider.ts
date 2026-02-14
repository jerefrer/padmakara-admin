import { DataProvider, fetchUtils } from "react-admin";

const API_URL = "/api/admin";

const httpClient = (url: string, options: fetchUtils.Options = {}) => {
  const token = localStorage.getItem("accessToken");
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetchUtils.fetchJson(url, { ...options, headers });
};

/**
 * React Admin data provider for the Padmakara admin API.
 * Uses simple REST conventions with Content-Range header for pagination.
 */
export const dataProvider: DataProvider = {
  getList: async (resource, params) => {
    const { page = 1, perPage = 25 } = params.pagination ?? {};
    const { field = "id", order = "ASC" } = params.sort ?? {};
    const start = (page - 1) * perPage;
    const end = page * perPage;

    const query = new URLSearchParams({
      _start: String(start),
      _end: String(end),
      _sort: field,
      _order: order,
    });

    // Add filters
    if (params.filter) {
      Object.entries(params.filter).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          // Handle array values (multi-select filters)
          if (Array.isArray(value)) {
            if (value.length > 0) {
              query.set(key, value.join(","));
            }
          } else {
            query.set(key, String(value));
          }
        }
      });
    }

    const url = `${API_URL}/${resource}?${query}`;
    const { json, headers } = await httpClient(url);

    const contentRange = headers.get("Content-Range");
    const total = contentRange
      ? parseInt(contentRange.split("/").pop()!, 10)
      : json.length;

    // Transform events data to include array IDs for React Admin
    const transformedData = resource === "events"
      ? json.map((event: any) => ({
          ...event,
          teacherIds: event.eventTeachers?.map((et: any) => et.teacherId) || [],
          groupIds: event.eventRetreatGroups?.map((eg: any) => eg.retreatGroupId) || [],
          placeIds: event.eventPlaces?.map((ep: any) => ep.placeId) || [],
          audienceIds: event.audienceId ? [event.audienceId] : [],
        }))
      : json;

    return { data: transformedData, total };
  },

  getOne: async (resource, params) => {
    const { json } = await httpClient(`${API_URL}/${resource}/${params.id}`);
    return { data: json };
  },

  getMany: async (resource, params) => {
    const results = await Promise.all(
      params.ids.map((id) =>
        httpClient(`${API_URL}/${resource}/${id}`).then(({ json }) => json)
      )
    );
    return { data: results };
  },

  getManyReference: async (resource, params) => {
    const { page = 1, perPage = 25 } = params.pagination ?? {};
    const { field = "id", order = "ASC" } = params.sort ?? {};
    const start = (page - 1) * perPage;
    const end = page * perPage;

    const query = new URLSearchParams({
      _start: String(start),
      _end: String(end),
      _sort: field,
      _order: order,
      [params.target]: String(params.id),
    });

    const url = `${API_URL}/${resource}?${query}`;
    const { json, headers } = await httpClient(url);

    const contentRange = headers.get("Content-Range");
    const total = contentRange
      ? parseInt(contentRange.split("/").pop()!, 10)
      : json.length;

    return { data: json, total };
  },

  create: async (resource, params) => {
    const { json } = await httpClient(`${API_URL}/${resource}`, {
      method: "POST",
      body: JSON.stringify(params.data),
    });
    return { data: json };
  },

  update: async (resource, params) => {
    const { json } = await httpClient(`${API_URL}/${resource}/${params.id}`, {
      method: "PUT",
      body: JSON.stringify(params.data),
    });
    return { data: json };
  },

  updateMany: async (resource, params) => {
    const results = await Promise.all(
      params.ids.map((id) =>
        httpClient(`${API_URL}/${resource}/${id}`, {
          method: "PUT",
          body: JSON.stringify(params.data),
        }).then(({ json }) => json.id)
      )
    );
    return { data: results };
  },

  delete: async (resource, params) => {
    const { json } = await httpClient(`${API_URL}/${resource}/${params.id}`, {
      method: "DELETE",
    });
    return { data: json };
  },

  deleteMany: async (resource, params) => {
    const results = await Promise.all(
      params.ids.map((id) =>
        httpClient(`${API_URL}/${resource}/${id}`, {
          method: "DELETE",
        }).then(({ json }) => json.id)
      )
    );
    return { data: results };
  },
};
