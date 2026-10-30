import type { RoomStatus } from "@anw/sync";
import type { ReactNode } from "react";
import { Pill, PresenceStack } from "@/shared/ui";
import s from "./header.module.css";

const LABEL: Record<RoomStatus, { text: string; tone?: "ok" | "warn" | "danger" }> = {
  connecting: { text: "Connecting" },
  syncing: { text: "Syncing" },
  synced: { text: "Live", tone: "ok" },
  offline: { text: "Offline, saving here", tone: "warn" },
  denied: { text: "No access", tone: "danger" },
};

export function SurfaceHeader({
  title,
  detail,
  status,
  presence = [],
  actions,
}: {
  title: ReactNode;
  detail?: ReactNode;
  status?: RoomStatus;
  presence?: string[];
  actions?: ReactNode;
}) {
  return (
    <header className={s.header}>
      <div className={s.titles}>
        <h1 className={s.title}>{title}</h1>
        {detail ? <span className={s.detail}>{detail}</span> : null}
      </div>
      <div className={s.right}>
        <PresenceStack ids={presence} />
        {status ? (
          <Pill tone={LABEL[status].tone} dot>
            {LABEL[status].text}
          </Pill>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
