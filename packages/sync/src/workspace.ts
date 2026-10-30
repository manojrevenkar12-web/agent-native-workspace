import agentConfig from "../../../config/agent.json" with { type: "json" };
import schedulingConfig from "../../../config/scheduling.json" with { type: "json" };
import syncConfig from "../../../config/sync.json" with { type: "json" };
import workspaceConfig from "../../../config/workspace.json" with { type: "json" };

/** Settings live in config/*.json; everything reads them from here. */
export const config = {
  sync: syncConfig,
  agent: agentConfig,
  scheduling: schedulingConfig,
  workspace: workspaceConfig,
};

export interface Person {
  id: string;
  name: string;
  timeZone: string;
  color: string;
}

export interface RoomInfo {
  title: string;
  kind: "doc" | "notes" | "calendar" | "sheet";
  editors: string[];
  viewers: string[];
}

export const people: Person[] = workspaceConfig.people;
export const assistant: Person = { ...workspaceConfig.assistant, timeZone: "UTC" };
export const channels = workspaceConfig.channels;
export const rooms = workspaceConfig.rooms as Record<string, RoomInfo>;

export function person(id: string): Person {
  if (id === assistant.id) return assistant;
  const p = people.find((x) => x.id === id);
  if (!p) throw new Error(`unknown person ${id}`);
  return p;
}

export function roleIn(user: string, room: string): "editor" | "viewer" | null {
  const r = rooms[room];
  if (!r) return null;
  if (r.editors.includes(user)) return "editor";
  if (r.viewers.includes(user)) return "viewer";
  return null;
}

export function inChannel(user: string, channel: string): boolean {
  return channels.find((c) => c.id === channel)?.members.includes(user) ?? false;
}

export function channelMembers(channel: string): string[] {
  return channels.find((c) => c.id === channel)?.members ?? [];
}

export function roomsOf(user: string, kind?: RoomInfo["kind"]): [string, RoomInfo][] {
  return Object.entries(rooms).filter(([id, r]) => (!kind || r.kind === kind) && roleIn(user, id) !== null);
}

export const dayParts = schedulingConfig.dayParts as unknown as Record<string, [string, string]>;
