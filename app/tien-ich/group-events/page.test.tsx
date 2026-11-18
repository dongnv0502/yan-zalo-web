import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { io } from "socket.io-client";
import type { GroupEventLog } from "@/lib/zalo";
import GroupEventsPage from "./page";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));

function makeSocket() {
  const events = new Map<string, (event?: GroupEventLog) => void>();
  return {
    connected: false,
    on: vi.fn((name: string, listener: (event?: GroupEventLog) => void) => { events.set(name, listener); }),
    off: vi.fn((name: string) => { events.delete(name); }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    deliver(name: string, event?: GroupEventLog) {
      act(() => { events.get(name)?.(event); });
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("opens a fresh live connection after the previous signed-in view unmounts", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ events: [] }))));
  const old = makeSocket();
  const fresh = makeSocket();
  vi.mocked(io).mockReturnValueOnce(old as never).mockReturnValueOnce(fresh as never);

  const first = render(<GroupEventsPage />);
  old.deliver("connect");
  await screen.findByText("Live");
  old.deliver("disconnect");
  await screen.findByText("Ngắt kết nối");
  first.unmount();
  expect(old.disconnect).toHaveBeenCalledOnce();

  render(<GroupEventsPage />);
  fresh.deliver("connect");
  await screen.findByText("Live");
  expect(io).toHaveBeenCalledTimes(2);
  fresh.deliver("group_event", {
    id: "fresh-event", type: "join", groupId: "room", groupName: "New group", memberNames: ["Alice"], memberIds: ["a"], ts: 123,
  });
  expect(screen.getAllByText("New group")).not.toHaveLength(0);
});
