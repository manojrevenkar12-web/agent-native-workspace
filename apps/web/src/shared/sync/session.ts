export const SERVER = process.env.NEXT_PUBLIC_ANW_SERVER ?? "http://localhost:4417";
export const WS_URL = `${SERVER.replace(/^http/, "ws")}/ws`;

const KEY = "anw.session";

export interface Session {
  user: string;
}

/** Browser storage can be blocked; the session then lives only in memory for this tab. */
let memory: Session | null = null;

export function readSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch {
    // fall through
  }
  return memory;
}

export function writeSession(s: Session | null): void {
  memory = s;
  try {
    if (s) window.sessionStorage.setItem(KEY, JSON.stringify(s));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // memory only
  }
}

/** Demo sign-in: the dev server issues a short-lived token for a demo person. */
export async function fetchToken(user: string): Promise<string> {
  const r = await fetch(`${SERVER}/auth/dev?user=${encodeURIComponent(user)}`);
  if (!r.ok) throw new Error(`Sign-in failed (${r.status})`);
  return ((await r.json()) as { token: string }).token;
}

export const browserStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // full or blocked: the outbox stays in memory
    }
  },
};
