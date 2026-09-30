"use client";
import { useParams } from "next/navigation";
import SupportWorkspace from "@/components/SupportWorkspace";
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <SupportWorkspace initialTicketId={id} />;
}
