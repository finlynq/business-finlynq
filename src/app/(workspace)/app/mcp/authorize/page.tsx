import { redirect } from "next/navigation";

export default async function ResumeMcpAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const target = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string") target.set(name, value);
    else if (Array.isArray(value)) for (const item of value) target.append(name, item);
  }
  redirect(`/oauth/authorize?${target.toString()}`);
}
