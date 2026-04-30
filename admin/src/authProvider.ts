import { AuthProvider } from "react-admin";
import { refreshAccessToken } from "./utils/authFetch";

const API_URL = "/api/auth";

export const authProvider: AuthProvider = {
  login: async ({ username, password }) => {
    const res = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: username, password }),
    });

    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error || "Login failed");
    }

    const { accessToken, refreshToken, user } = await res.json();
    localStorage.setItem("accessToken", accessToken);
    localStorage.setItem("refreshToken", refreshToken);
    localStorage.setItem("user", JSON.stringify(user));
  },

  logout: async () => {
    const accessToken = localStorage.getItem("accessToken");
    const refreshToken = localStorage.getItem("refreshToken");

    if (accessToken) {
      try {
        await fetch(`${API_URL}/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // Ignore logout errors
      }
    }

    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("user");
  },

  checkAuth: async () => {
    const token = localStorage.getItem("accessToken");
    if (!token) throw new Error("Not authenticated");

    const res = await fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return;

    // Access token rejected — try a refresh before giving up.
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error("Session expired");
  },

  checkError: async (error) => {
    // Don't wipe credentials on a single 401 — the data provider already
    // refreshes and retries. If the refresh itself failed it has cleared
    // localStorage on its own, so the next checkAuth will route to /login.
    // 403 is "forbidden", not "unauthenticated" — leaving auth state intact
    // lets the user navigate elsewhere instead of being kicked out entirely.
    if (error.status === 401 && !localStorage.getItem("accessToken")) {
      throw new Error("Session expired");
    }
  },

  getIdentity: async () => {
    const userStr = localStorage.getItem("user");
    if (!userStr) throw new Error("Not authenticated");
    const user = JSON.parse(userStr);
    return {
      id: user.id,
      fullName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email,
    };
  },

  getPermissions: async () => {
    const userStr = localStorage.getItem("user");
    if (!userStr) return "";
    const user = JSON.parse(userStr);
    return user.role;
  },
};
