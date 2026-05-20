import { NextRequest } from "next/server";
import { handlePowerAction } from "../power-action";

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return handlePowerAction(req, name, "force-stop");
}
