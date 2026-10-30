"use client";

import { people } from "@anw/sync";
import { MotionConfig } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { readSession, writeSession } from "@/shared/sync/session";
import { useConnectionStatus, WorkspaceProvider } from "@/shared/sync/workspace";
import { Avatar, Icon, type IconName, SkeletonLines } from "@/shared/ui";
import s from "./shell.module.css";

const TOOLS: { href: string; match: string; label: string; icon: IconName }[] = [
  { href: "/chat/launch", match: "/chat", label: "Chat", icon: "chat" },
  { href: "/notes", match: "/notes", label: "Notes", icon: "notes" },
  { href: "/calendar", match: "/calendar", label: "Calendar", icon: "calendar" },
  { href: "/docs/launch-brief", match: "/docs", label: "Docs", icon: "docs" },
  { href: "/sheets/budget", match: "/sheets", label: "Sheets", icon: "sheets" },
];

function OfflineBanner() {
  const status = useConnectionStatus();
  if (status !== "offline") return null;
  return (
    <div className={s.banner} role="status">
      <Icon name="offline" size={18} />
      You're offline. Everything you do is kept here and sent when the connection is back.
    </div>
  );
}

function Rail({ user }: { user: string }) {
  const path = usePathname();
  const router = useRouter();
  return (
    <nav className={s.rail} aria-label="Tools">
      <div className={s.mark} aria-hidden>
        ws
      </div>
      <ul className={s.nav}>
        {TOOLS.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              className={s.link}
              aria-current={path.startsWith(t.match) ? "page" : undefined}
            >
              <Icon name={t.icon} />
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className={s.foot}>
        <button
          type="button"
          className={s.switch}
          onClick={() => {
            writeSession(null);
            router.push(`/sign-in?next=${encodeURIComponent(path)}`);
          }}
          aria-label={`Signed in as ${people.find((p) => p.id === user)?.name}. Switch person`}
        >
          <Avatar id={user} size="2.25rem" />
        </button>
      </div>
    </nav>
  );
}

function Session({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const as = useSearchParams().get("as");
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => {
    if (as && people.some((p) => p.id === as)) writeSession({ user: as });
    const sess = readSession();
    if (!sess) router.replace(`/sign-in?next=${encodeURIComponent(path)}`);
    else setUser(sess.user);
  }, [as, path, router]);
  if (!user) return <SkeletonLines label="Opening your workspace" lines={6} />;
  return (
    <WorkspaceProvider key={user} user={user}>
      <div className={s.frame}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Rail user={user} />
        <main className={s.main} id="main">
          <OfflineBanner />
          <div className={s.content}>{children}</div>
        </main>
      </div>
    </WorkspaceProvider>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <Suspense fallback={<SkeletonLines label="Opening your workspace" lines={6} />}>
        <Session>{children}</Session>
      </Suspense>
    </MotionConfig>
  );
}
