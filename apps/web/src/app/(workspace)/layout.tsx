import type { ReactNode } from "react";
import { Shell } from "@/features/shell/Shell";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
