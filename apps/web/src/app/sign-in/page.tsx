"use client";

import { people } from "@anw/sync";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import s from "@/features/shell/shell.module.css";
import { city } from "@/shared/format/time";
import { fetchToken, writeSession } from "@/shared/sync/session";
import { Avatar, StateView } from "@/shared/ui";

function SignIn() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/chat/launch";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const choose = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await fetchToken(id);
      writeSession({ user: id });
      router.replace(next.startsWith("/") ? next : "/chat/launch");
    } catch {
      setError("The workspace server is not answering. Start it with npm run dev and try again.");
      setBusy(null);
    }
  };
  return (
    <main className={s.signin}>
      <h1>Who are you today?</h1>
      <p>
        A demo team in three time zones. Open a second window as someone else to see edits, cursors and the
        assistant arrive live.
      </p>
      {error ? (
        <StateView kind="error" title="Can't reach the workspace">
          {error}
        </StateView>
      ) : null}
      <ul className={s.people}>
        {people.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={s.personButton}
              onClick={() => choose(p.id)}
              disabled={busy !== null}
              aria-busy={busy === p.id}
            >
              <Avatar id={p.id} size="2.5rem" />
              <span>
                {p.name}
                <small>{city(p.timeZone)}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
