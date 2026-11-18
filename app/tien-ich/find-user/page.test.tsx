import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FindUserPage from "./page";

const recipient = { uid: "9007199254740993", display_name: "An", zalo_name: "an" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lets the user retry a failed invitation and prevents another send after success", async () => {
  vi.stubGlobal("React", React);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json(recipient))
    .mockResolvedValueOnce(Response.json({ error: "Zalo chưa xác nhận." }, { status: 502 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(<FindUserPage />);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "0912345678" } });
  fireEvent.click(screen.getByRole("button", { name: "Tra cứu" }));
  const send = await screen.findByRole("button", { name: "Gửi lời mời kết bạn" });
  fireEvent.change(screen.getByLabelText("Lời nhắn (không bắt buộc)"), { target: { value: "Chào An!" } });
  fireEvent.click(send);

  expect((await screen.findByRole("alert")).textContent).toBe("Zalo chưa xác nhận.");
  expect(fetchMock).toHaveBeenLastCalledWith("/api/utilities/send-friend-request", expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ uid: recipient.uid, message: "Chào An!" }),
  }));
  fireEvent.click(send);
  expect((await screen.findByRole("status")).textContent).toBe("Đã gửi lời mời kết bạn.");
  expect((screen.getByRole("button", { name: "Gửi lời mời kết bạn" }) as HTMLButtonElement).disabled).toBe(true);
});
