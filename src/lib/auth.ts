import { dash } from "@better-auth/infra";
import { betterAuth } from "better-auth";
import { admin, emailOTP } from "better-auth/plugins";
import { Pool } from "pg";
import { sendEmail, sendPasswordResetEmail } from "./email.js";

export const auth = betterAuth({
	database: new Pool({
		connectionString:
			"postgresql://neondb_owner:npg_r7oYWhpHFXP4@ep-fragrant-glitter-a8s9ql6d-pooler.eastus2.azure.neon.tech/neondb?sslmode=require&channel_binding=require",
	}),
	baseURL: "http://localhost:5173/",
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
				baseUrl: "http://localhost:5173", // TODO: Update this to match your frontend URL
				// You can also include additional information in the email, such as the user's IP address or the time of the request, to help them identify if the request was legitimate.
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
			},
		},
	},
});
