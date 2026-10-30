import { SheetView } from "@/features/sheets/SheetView";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SheetView id={id} />;
}
