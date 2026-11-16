/**
 * The avatar and hero editors save through their own upload routes and then
 * refresh the page so it shows the new image. Text typed in the form and not
 * saved yet must survive that refresh: an admin who fixes a name and then
 * re-frames the photo should not lose the name.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { AdminContext, ResourceContextProvider, useTakeUndoableMutation, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only the image upload succeeds; the side panels (group members…) stay empty.
vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response("{}", { status: 200 })
      : new Response("{}", { status: 404 }),
  ),
}));

// The real crop dialog needs a canvas; this one saves the avatar at once.
vi.mock("../components/ImageCropDialog", () => ({
  applyGrayscale: vi.fn(),
  ImageCropDialog: (props: { mode: string; onSave: (blob: Blob) => void }) => (
    <button type="button" onClick={() => props.mode === "avatar" && props.onSave(new Blob(["avatar"]))}>
      save-crop
    </button>
  ),
}));

import { i18nProvider } from "../i18n";
import { TeacherEdit } from "./teachers";
import { GroupEdit } from "./groups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
});

/**
 * Edit pages save in undoable mode: the update waits for the undo notification
 * to close. This stands in for that notification closing on its own.
 */
let commitPendingSave: () => void = () => {};
function UndoableCommitter() {
  const takeMutation = useTakeUndoableMutation();
  commitPendingSave = () => takeMutation()?.({ isUndo: false });
  return null;
}

/** Serves `before` until the avatar upload, then the record as the server has it after it. */
async function renderEdit(resource: string, element: React.ReactNode, before: { id: number }, after: object) {
  let uploaded = false;
  const getOne = vi.fn(async () => ({ data: uploaded ? after : before }));
  const update = vi.fn(async (_r: string, params: { data: unknown }) => ({ data: params.data }));
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne,
    getMany: vi.fn(async () => ({ data: [] })),
    getManyReference: vi.fn(async () => ({ data: [], total: 0 })),
    update,
  } as unknown as DataProvider;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/${resource}/${before.id}`]}>
        <AdminContext dataProvider={dataProvider} queryClient={queryClient} i18nProvider={i18nProvider}>
          <Routes>
            <Route
              path={`/${resource}/:id`}
              element={<ResourceContextProvider value={resource}>{element}</ResourceContextProvider>}
            />
          </Routes>
          <UndoableCommitter />
        </AdminContext>
      </MemoryRouter>,
    ),
  );
  await flush();
  return { markUploaded: () => (uploaded = true), getOne, update };
}

const textInput = (name: string) => host.querySelector(`input[name="${name}"]`) as HTMLInputElement;

async function type(name: string, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textInput(name), value);
    textInput(name).dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Picks a file for the avatar and saves it through the (mocked) crop dialog. */
async function saveAvatar(markUploaded: () => void) {
  const avatarInput = host.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["avatar"], "avatar.jpg", { type: "image/jpeg" });
  Object.defineProperty(avatarInput, "files", { value: [file], configurable: true });
  await act(async () => avatarInput.dispatchEvent(new Event("change", { bubbles: true })));
  const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "save-crop");
  expect(save, "crop dialog").toBeTruthy();
  markUploaded();
  await act(async () => (save as HTMLButtonElement).click());
  await flush();
}

describe("image save on an edit page", () => {
  it("should keep a teacher name typed but not saved when the avatar is saved", async () => {
    // Arrange
    const before = { id: 5, name: "Jigme Khyentse", abbreviation: "JKR", aliases: [] };
    const after = { ...before, avatarS3Key: "teachers/avatars/5-1.webp", avatarUrl: "https://signed/avatar.webp" };
    const { markUploaded, getOne } = await renderEdit("teachers", <TeacherEdit />, before, after);
    await type("name", "Jigme Khyentse Rinpoche");

    // Act
    await saveAvatar(markUploaded);

    // Assert: the page did refetch the record, and the typed name survived it.
    expect(getOne.mock.calls.length).toBeGreaterThan(1);
    expect(textInput("name").value).toBe("Jigme Khyentse Rinpoche");
  });

  it("should send the typed name with the refreshed image key when Save follows an avatar save", async () => {
    // Arrange
    const before = { id: 5, name: "Jigme Khyentse", abbreviation: "JKR", aliases: [], avatarS3Key: "teachers/avatars/5-0.webp" };
    const after = { ...before, avatarS3Key: "teachers/avatars/5-1.webp", avatarUrl: "https://signed/avatar.webp" };
    const { markUploaded, update } = await renderEdit("teachers", <TeacherEdit />, before, after);
    await type("name", "Jigme Khyentse Rinpoche");
    await saveAvatar(markUploaded);
    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save") as HTMLButtonElement;

    // Act
    await act(async () => save.click());
    await act(async () => commitPendingSave());
    await flush();

    // Assert: never the key loaded before the avatar save.
    expect(update).toHaveBeenCalledWith(
      "teachers",
      expect.objectContaining({
        data: expect.objectContaining({ name: "Jigme Khyentse Rinpoche", avatarS3Key: "teachers/avatars/5-1.webp" }),
      }),
    );
  });

  it("should keep a group name typed but not saved when the avatar is saved", async () => {
    // Arrange
    const before = { id: 3, nameEn: "Ngondro", slug: "ngondro" };
    const after = { ...before, avatarS3Key: "groups/avatars/3-1.webp", avatarUrl: "https://signed/avatar.webp" };
    const { markUploaded, getOne } = await renderEdit("groups", <GroupEdit />, before, after);
    await type("nameEn", "Ngondro group");

    // Act
    await saveAvatar(markUploaded);

    // Assert
    expect(getOne.mock.calls.length).toBeGreaterThan(1);
    expect(textInput("nameEn").value).toBe("Ngondro group");
  });
});
