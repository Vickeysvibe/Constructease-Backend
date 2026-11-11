/**
 * Bootstraps an organisation and its first owner. The password is read from the
 * CE_OWNER_PASSWORD environment variable so it never lands in shell history.
 *   CE_OWNER_PASSWORD='<password>' npm run org:create -- --org "Acme Builders" --name "Priya R" --email priya@acme.in
 */
import { parseArgs } from "node:util";
import { connectDb, disconnectDb } from "@/core/db";
import { hashPassword } from "@/core/auth";
import { Organization, User } from "@/modules/identity/models";
import { email as emailSchema, password as passwordSchema } from "@/modules/identity/routes";

const { values } = parseArgs({
  options: { org: { type: "string" }, name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
});

async function main() {
  const secret = process.env.CE_OWNER_PASSWORD;
  if (!values.org || !values.name || !values.email || !secret) {
    throw new Error(
      "Usage: CE_OWNER_PASSWORD='<password>' npm run org:create -- --org \"Name\" --name \"Owner\" --email owner@example.com",
    );
  }
  const email = emailSchema.parse(values.email);
  const passwordHash = await hashPassword(passwordSchema.parse(secret));
  await connectDb();
  if (await User.exists({ email }).setOptions({ skipTenantGuard: true })) throw new Error(`User ${email} already exists`);
  const org = await Organization.create({ name: values.org });
  await User.create({ orgId: org._id, name: values.name, email, phone: values.phone ?? "", orgRole: "owner", passwordHash });
  console.log(`Created org "${org.name}" (${org._id.toHexString()}) with owner ${email}`);
  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
