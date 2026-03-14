import { dash } from "@better-auth/infra";
import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { Pool } from "pg";
import { sendEmail } from "./email.js";

export const auth = betterAuth({
	database: new Pool({
		connectionString:
			"postgresql://neondb_owner:npg_r7oYWhpHFXP4@ep-fragrant-glitter-a8s9ql6d-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require",
	}),
	baseURL: "http://localhost:5173/",
	emailAndPassword: { enabled: true, requireEmailVerification: true },
	plugins: [
		dash(),
		admin(),
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
		},
	},
});
