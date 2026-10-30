import { ChatView } from "@/features/chat/ChatView";

export default async function Page({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  return <ChatView channel={channel} />;
}
