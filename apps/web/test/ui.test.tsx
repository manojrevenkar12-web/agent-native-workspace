import type { MeetingProposal, Message, TaskProposal } from "@anw/sync";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageItem } from "@/features/chat/MessageItem";
import { ProposalCard } from "@/features/chat/ProposalCard";
import { SkeletonLines, StateView } from "@/shared/ui";

const meeting: MeetingProposal = {
  kind: "meeting",
  id: "p",
  sourceId: "m",
  title: "Onboarding",
  window: "Thu 5 Nov, after 15:00",
  durationMin: 30,
  attendees: ["lena", "maya"],
  slots: [{ start: "2026-11-05T16:00:00Z", end: "2026-11-05T16:30:00Z", missing: [] }],
  status: "open",
};

describe("states every screen has", () => {
  it("announces loading, explains errors and offers an action", () => {
    render(<SkeletonLines label="Loading messages" />);
    expect(screen.getByRole("status", { name: "Loading messages" })).toBeTruthy();
    render(
      <StateView
        kind="error"
        title="Can't reach the workspace"
        action={<button type="button">Try again</button>}
      >
        Start the server.
      </StateView>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Can't reach the workspace");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("proposals", () => {
  it("shows each slot in the reader's time and the other attendee's city", () => {
    const decide = vi.fn();
    render(<ProposalCard proposal={meeting} me="lena" onDecide={decide} />);
    const slot = screen.getByRole("button", { name: /Book Thu 5 Nov at 17:00/ });
    expect(slot.textContent).toContain("11:00 New York");
    fireEvent.click(slot);
    expect(decide).toHaveBeenCalledWith(0);
  });

  it("does not let someone outside the meeting book it", () => {
    render(<ProposalCard proposal={meeting} me="arif" onDecide={() => {}} />);
    expect((screen.getByRole("button", { name: /Book/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Only people in the meeting/)).toBeTruthy();
  });

  it("settles into a confirmation once booked", () => {
    render(
      <ProposalCard
        proposal={{ ...meeting, status: "booked", decidedBy: "maya" }}
        me="lena"
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/Maya booked “Onboarding” for Thu 5 Nov at 17:00/)).toBeTruthy();
  });

  it("offers a task to add", () => {
    const task: TaskProposal = {
      kind: "task",
      id: "t",
      sourceId: "m",
      text: "Send the contract",
      assignee: "arif",
      due: "2026-11-06",
      status: "open",
    };
    const decide = vi.fn();
    render(<ProposalCard proposal={task} me="arif" onDecide={decide} />);
    expect(screen.getByText(/due Fri 6 Nov/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to tasks" }));
    expect(decide).toHaveBeenCalledWith("accept");
  });
});

describe("messages", () => {
  const base: Message = {
    id: "1",
    seq: 1,
    channel: "launch",
    author: "assistant",
    body: "Here is",
    createdAt: Date.now(),
    status: "streaming",
    version: 1,
  };
  it("marks a streaming reply busy so screen readers wait for the whole answer", () => {
    const { container } = render(
      <ol>
        <MessageItem
          msg={base}
          me="lena"
          continued={false}
          onDecide={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </ol>,
    );
    expect(container.querySelector("li")?.getAttribute("aria-busy")).toBe("true");
  });

  it("never renders message text as HTML", () => {
    const evil = {
      ...base,
      author: "maya",
      status: "complete" as const,
      body: "<img src=x onerror=alert(1)> @lena",
    };
    const { container } = render(
      <ol>
        <MessageItem
          msg={evil}
          me="lena"
          continued={false}
          onDecide={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </ol>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("@lena");
  });
});
