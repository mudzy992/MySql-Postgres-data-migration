import { storeInfo } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const storage = await storeInfo();
    return Response.json({ ok: true, storage });
  } catch {
    return Response.json({ ok: true });
  }
}
