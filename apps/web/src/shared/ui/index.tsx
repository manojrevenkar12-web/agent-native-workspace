"use client";

import { assistant, person } from "@anw/sync";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./ui.module.css";

export { Icon, type IconName };

type Variant = "default" | "primary" | "agent" | "decide" | "quiet" | "danger";

export function Button({
  variant = "default",
  small,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; small?: boolean; icon?: IconName }) {
  const cls = [s.button, variant !== "default" ? s[variant] : "", small ? s.small : "", className ?? ""].join(
    " ",
  );
  return (
    <button type="button" className={cls} {...rest}>
      {icon ? <Icon name={icon} size={small ? 16 : 18} /> : null}
      {children}
    </button>
  );
}

export function Skeleton({
  width,
  height,
  style,
}: {
  width?: string;
  height?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={s.skeleton}
      style={{ width: width ?? "100%", height: height ?? "1em", ...style }}
      aria-hidden
    />
  );
}

/** Loading placeholder rows, announced once to assistive tech. */
export function SkeletonLines({ lines = 4, label }: { lines?: number; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      style={{ display: "grid", gap: "var(--s-3)", padding: "var(--s-6)" }}
    >
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} width={`${92 - ((i * 17) % 40)}%`} height="1.1em" />
      ))}
    </div>
  );
}

export function StateView({
  kind,
  title,
  children,
  action,
  icon,
}: {
  kind: "empty" | "error";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <section
      className={`${s.state} ${kind === "error" ? s.stateError : ""}`}
      role={kind === "error" ? "alert" : undefined}
    >
      <span className={s.stateMark}>
        <Icon name={icon ?? (kind === "error" ? "offline" : "spark")} />
      </span>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </section>
  );
}

export function Avatar({ id, size = "2rem" }: { id: string; size?: string }) {
  const p = person(id);
  const isAgent = id === assistant.id;
  const initials = isAgent
    ? "AI"
    : p.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2);
  return (
    <span
      className={`${s.avatar} ${isAgent ? s.avatarAgent : ""}`}
      style={{ "--avatar": size, "--person": p.color } as CSSProperties}
      title={p.name}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function PresenceStack({ ids, size = "1.75rem" }: { ids: string[]; size?: string }) {
  if (!ids.length) return null;
  const names = ids.map((i) => person(i).name);
  return (
    <span className={s.stack} role="img" aria-label={`Here now: ${names.join(", ")}`}>
      {ids.map((id) => (
        <Avatar key={id} id={id} size={size} />
      ))}
    </span>
  );
}

export function Pill({
  tone,
  children,
  dot,
}: {
  tone?: "ok" | "agent" | "warn" | "danger";
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={s.pill} data-tone={tone}>
      {dot ? <span className={s.dot} aria-hidden /> : null}
      {children}
    </span>
  );
}
