// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogin = vi.fn();
const mockNotify = vi.fn();
vi.mock("react-admin", () => ({
  Login: ({ children }: { children: React.ReactNode }) => children,
  useLogin: () => mockLogin,
  useNotify: () => mockNotify,
  useTranslate: () => (key: string) => key,
  useLocaleState: () => ["pt"],
}));
vi.mock("../authProvider", () => ({ requestBackofficeCode: vi.fn() }));

import { requestBackofficeCode } from "../authProvider";
import { CodeLoginForm } from "./LoginPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockRequest = requestBackofficeCode as ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
const type = (id: string, value: string) =>
  act(() => {
    const input = el(id)!;
    // React tracks the value through the native setter.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = () =>
  act(async () => {
    (container.querySelector("form") as HTMLFormElement).requestSubmit();
    await Promise.resolve();
  });

beforeEach(() => {
  mockLogin.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset();
  mockRequest.mockReset().mockResolvedValue("challenge-123");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CodeLoginForm />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CodeLoginForm", () => {
  it("should email a code in the backoffice language and then ask for it", async () => {
    type("login-email", " sofia@test.com ");
    await submit();

    expect(mockRequest).toHaveBeenCalledWith("sofia@test.com", "pt");
    expect(el("login-code")).not.toBeNull();
  });

  it("should sign in with the email, the challenge and the typed code", async () => {
    type("login-email", "sofia@test.com");
    await submit();
    type("login-code", "123456");
    await submit();

    expect(mockLogin).toHaveBeenCalledWith({ email: "sofia@test.com", challengeId: "challenge-123", code: "123456" });
  });

  it("should say so when the code is refused", async () => {
    mockLogin.mockRejectedValue(new Error("Invalid or expired code"));
    type("login-email", "sofia@test.com");
    await submit();
    type("login-code", "000000");
    await submit();

    expect(mockNotify).toHaveBeenCalledWith("padmakara.login.codeFailed", { type: "error" });
  });

  it("should still sign in with a password for accounts that have one", async () => {
    await act(async () => el("login-toggle-password")!.click());
    type("login-email", "andre@test.com");
    type("login-password", "secret-password");
    await submit();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockLogin).toHaveBeenCalledWith({ username: "andre@test.com", password: "secret-password" });
  });
});
