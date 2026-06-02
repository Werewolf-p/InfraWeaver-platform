"use server";
import { signIn } from "@/lib/auth";

export async function signInWithAuthentik(formData: FormData) {
  const callbackUrl = (formData.get("callbackUrl") as string | null) ?? "/";
  await signIn("authentik", { redirectTo: callbackUrl });
}
