import { sentinelClient } from "@better-auth/infra/client";
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({ plugins: [sentinelClient()] });
