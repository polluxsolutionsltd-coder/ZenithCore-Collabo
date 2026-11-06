/** Settings that make a production start unsafe; the API refuses to start if any is found. */
export function unsafeSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) problems.push("JWT_SECRET must be set to at least 32 characters");
  if (env.DEMO_MODE === "1") problems.push("DEMO_MODE must not be enabled");
  if (!env.MOAD_API_KEY) problems.push("MOAD_API_KEY must be set (the demo key is public)");
  if (!env.RECEIPT_SECRET) problems.push("RECEIPT_SECRET must be set");
  if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 32) problems.push("SIGNING_SECRET must be set to at least 32 characters (protects the electronic-signature keys)");
  return problems;
}
