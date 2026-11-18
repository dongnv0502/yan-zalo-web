import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TienIchLayout from "./layout";

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/tien-ich/find-user",
}));
const router = { replace: vi.fn() };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps Tiện ích selected and links back to the tool directory from a detail page", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "logged_in" })));
  render(<TienIchLayout><h1>Tra cứu tài khoản Zalo</h1></TienIchLayout>);

  const navigation = await screen.findByRole("navigation", { name: "Điều hướng di động" });
  expect(within(navigation).getByRole("link", { name: "Tiện ích", current: true }).getAttribute("href")).toBe("/tien-ich");
  expect(within(navigation).getByRole("link", { name: "Chat" }).getAttribute("href")).toBe("/chat");
});
