import { AuthProvider } from "react-admin";

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

    // Verify token is still valid
    const res = await fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // Try refreshing
      const refreshToken = localStorage.getItem("refreshToken");
      if (!refreshToken) throw new Error("No refresh token");

      const refreshRes = await fetch(`${API_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (!refreshRes.ok) {
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        localStorage.removeItem("user");
        throw new Error("Session expired");
      }

      const tokens = await refreshRes.json();
      localStorage.setItem("accessToken", tokens.accessToken);
      localStorage.setItem("refreshToken", tokens.refreshToken);
    }
  },

  checkError: async (error) => {
    if (error.status === 401 || error.status === 403) {
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      localStorage.removeItem("user");
      throw new Error("Unauthorized");
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
