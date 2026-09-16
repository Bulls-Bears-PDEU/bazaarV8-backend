import { dash } from "@better-auth/infra";
import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { sendEmail, sendPasswordResetEmail } from "./email.js";
import config from "../config/config.js";
import { pool } from "../database/pool.js";
import { emitToAdmins } from "../realtime/emitter.js";

/**
 * The reset link has to open the app the request came from, otherwise a player
 * resetting their password lands on the admin panel's reset page. Only known
 * origins are trusted; anything else falls back to the player app.
 */
const resetLinkBaseUrl = (request?: Request) => {
  const origin = request?.headers.get("origin");
  if (origin && config.FRONTEND_ORIGINS.includes(origin)) {
    return origin;
  }
  return config.PLAYER_APP_URL;
};

export const auth = betterAuth({
  // Shares the trading pool, which also registers the NUMERIC type parser so
  // cash_balance comes back as a number rather than a string.
  database: pool,
  baseURL: config.BACKEND_URL,
  trustedOrigins: config.FRONTEND_ORIGINS,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url, token }, request) => {
      void sendPasswordResetEmail({
        to: user.email,
        subject: "Reset your password for Bazaar",
        username: user.name,
        verificationLink: url,
        token,
        baseUrl: resetLinkBaseUrl(request),
      });
    },
    onPasswordReset: async ({ user }, request) => {
      // You can implement any additional logic here after the password has been reset, such as logging or sending a confirmation email.
      console.log(
        `Password for user ${user.email} has been reset successfully.`,
      );
    },
  },
  plugins: [
    dash(),
    admin({
      defaultRole: "pending",
    }),
    emailOTP({
      sendVerificationOnSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        if (type === "sign-in") {
          await sendEmail({
            to: email,
            subject: "Your OTP for Bazaar Sign-In",
            otp,
          });
        } else if (type === "email-verification") {
          await sendEmail({
            to: email,
            subject: "Verify your email for Bazaar",
            otp,
          });
        } else {
          await sendEmail({
            to: email,
            subject: "Reset your password for Bazaar",
            otp,
          });
        }
      },
    }),
  ],
  user: {
    modelName: "users",
    additionalFields: {
      cash_balance: { type: "number", defaultValue: 500000 },
      frozen_balance: { type: "number", defaultValue: 0 },
      // Set by the server when a player finishes onboarding; never by the client.
      onboarded_at: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (user.role) {
            return { data: user };
          }

          return {
            data: {
              ...user,
              role: "pending",
            },
          };
        },
        // A new sign-up shows up in the admin panel's approval queue at once.
        after: async () => {
          emitToAdmins("usersChanged", {});
        },
      },
    },
  },
});
