import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendEmail = async (options: {
	to: string;
	subject: string;
	otp: string;
}) => {
	resend.emails.send({
		from: "Admin <admin@bullsandbearspdeu.com>",
		to: options.to,
		subject: options.subject,
		html: `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>Your Authentication Code</title>
    <style>
        /* Base Reset */
        body, table, td, a {
            -webkit-text-size-adjust: 100%;
            -ms-text-size-adjust: 100%;
        }
        table, td {
            mso-table-lspace: 0pt;
            mso-table-rspace: 0pt;
        }
        img {
            -ms-interpolation-mode: bicubic;
        }
        
        /* Core Styles */
        body {
            margin: 0;
            padding: 0;
            background-color: #000000;
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
            color: #a1a1aa; /* Soft gray text */
            line-height: 1.6;
        }
        
        /* Structural Grid Layout (Vercel/Vite Style) */
        .email-wrapper {
            width: 100%;
            background-color: #000000;
            padding: 40px 0;
        }
        
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #000000;
            border-top: 1px solid #27272a; /* Vercel style zinc border */
            border-left: 1px solid #27272a;
            border-right: 1px solid #27272a;
        }
        
        /* Header */
        .email-header {
            padding: 32px 40px;
            text-align: left;
            border-bottom: 1px solid #27272a;
        }
        
        .brand-logo {
            color: #ffffff;
            font-size: 16px;
            font-weight: 500;
            letter-spacing: 1px;
            text-decoration: none;
        }

        /* Meta Status Row */
        .meta-row {
            padding: 12px 40px;
            border-bottom: 1px solid #27272a;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
            color: #71717a;
            letter-spacing: 0.5px;
        }

        .meta-row table {
            width: 100%;
        }

        /* Body */
        .email-body {
            padding: 40px;
            border-bottom: 1px solid #27272a;
        }
        
        h1 {
            margin-top: 0;
            font-size: 20px;
            font-weight: 500;
            letter-spacing: -0.5px;
            color: #ffffff;
            text-align: left;
        }
        
        p {
            margin: 0 0 24px 0;
            font-size: 14px;
            color: #a1a1aa;
            text-align: left;
            font-weight: 400;
        }
        
        /* OTP Specific Block */
        .otp-container {
            margin: 32px 0;
            text-align: left;
        }
        
        .otp-code {
            display: inline-block;
            background-color: #09090b; /* zinc-950 */
            color: #ffffff;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 32px;
            font-weight: 600;
            letter-spacing: 6px;
            padding: 16px 32px;
            border: 1px dashed #3f3f46; /* zinc-700 */
            border-radius: 6px;
        }
        
        /* Soft Security Notice Box */
        .security-notice {
            background-color: transparent;
            border: 1px solid #27272a;
            padding: 24px;
            margin-top: 40px;
            border-radius: 6px;
            text-align: left;
        }
        
        .security-notice h3 {
            color: #ededed;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 0 0 8px 0;
            font-weight: 500;
        }

        .security-notice p {
            margin: 0;
            font-size: 13px;
            color: #71717a;
        }
        
        /* Footer */
        .email-footer {
            padding: 32px 40px;
            text-align: left;
            border-bottom: 1px solid #27272a;
        }
        
        .footer-text {
            font-size: 12px;
            color: #52525b;
            margin-bottom: 8px;
            line-height: 1.6;
        }
        
        /* Preheader text (hidden in body) */
        .preheader {
            display: none;
            max-height: 0px;
            overflow: hidden;
        }

        /* Responsive */
        @media screen and (max-width: 600px) {
            .email-body, .email-header, .email-footer, .meta-row {
                padding-left: 24px;
                padding-right: 24px;
            }
            .otp-code {
                font-size: 28px;
                padding: 16px 24px;
                letter-spacing: 4px;
            }
        }
    </style>
</head>
<body>
    <!-- Preheader Text for Email Clients -->
    <div class="preheader">
        Your verification code is ${options.otp}. Do not share this with anyone.
    </div>

    <!-- Main Wrapper -->
    <table class="email-wrapper" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="center">
                <!-- Grid Container -->
                <table class="email-container" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                    
                    <!-- Header Area -->
                    <tr>
                        <td class="email-header">
                            <a href="#" class="brand-logo">
                                Bazaar
                            </a>
                        </td>
                    </tr>
                    
                    <!-- Content Area -->
                    <tr>
                        <td class="email-body">
                            <h1>Authentication Code</h1>
                            
                            <p>Hello there,</p>
                            
                            <p>We received a sign-in attempt to your Bazaar institutional account. Please enter the following verification code to complete the authentication process.</p>
                            
                            <div class="otp-container">
                                <div class="otp-code">${options.otp}</div>
                            </div>
                            
                            <p style="font-size: 13px; color: #71717a;">
                                This security code is valid for 10 minutes.
                            </p>
                            
                            <div class="security-notice">
                                <h3>Unrecognized Activity?</h3>
                                <p>If you did not attempt to sign in, someone else might have your credentials. Your assets remain secure. We recommend changing your password immediately and contacting our security team.</p>
                            </div>
                            
                        </td>
                    </tr>
                    
                    <!-- Footer Area -->
                    <tr>
                        <td class="email-footer">
                            <p class="footer-text">
                                Bulls and Bears PDEU<br>
                                The finance club of PDEU
                            </p>
                        </td>
                    </tr>
                    
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`,
	});
};

export const sendPasswordResetEmail = async (options: {
	to: string;
	subject: string;
	username: string;
	verificationLink: string;
	token: string;
	baseUrl: string; // The base URL of the frontend, e.g., "http://localhost:5173"
}) => {
	return resend.emails.send({
		from: "Admin <admin@bullsandbearspdeu.com>",
		to: options.to,
		subject: options.subject,
		html: `
      <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>Reset Your Password</title>
    <style>
        /* Base Reset */
        body, table, td, a {
            -webkit-text-size-adjust: 100%;
            -ms-text-size-adjust: 100%;
        }
        table, td {
            mso-table-lspace: 0pt;
            mso-table-rspace: 0pt;
        }
        img {
            -ms-interpolation-mode: bicubic;
        }
        
        /* Core Styles */
        body {
            margin: 0;
            padding: 0;
            background-color: #000000;
            font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
            color: #a1a1aa; /* Soft gray text */
            line-height: 1.6;
        }
        
        /* Structural Grid Layout (Vercel/Vite Style) */
        .email-wrapper {
            width: 100%;
            background-color: #000000;
            padding: 40px 0;
        }
        
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #000000;
            border-top: 1px solid #27272a; /* Vercel style zinc border */
            border-left: 1px solid #27272a;
            border-right: 1px solid #27272a;
        }
        
        /* Header */
        .email-header {
            padding: 32px 40px;
            text-align: left;
            border-bottom: 1px solid #27272a;
        }
        
        .brand-logo {
            color: #ffffff;
            font-size: 16px;
            font-weight: 500;
            letter-spacing: 1px;
            text-decoration: none;
        }

        /* Meta Status Row */
        .meta-row {
            padding: 12px 40px;
            border-bottom: 1px solid #27272a;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
            color: #71717a;
            letter-spacing: 0.5px;
        }

        .meta-row table {
            width: 100%;
        }

        /* Hero Graphic */
        .hero-graphic-container {
            padding: 40px;
            text-align: center;
            border-bottom: 1px solid #27272a;
            background-image: radial-gradient(circle at top, rgba(255,255,255,0.04) 0%, transparent 60%);
        }

        .hero-graphic {
            width: 100%;
            max-width: 320px;
            height: auto;
            display: inline-block;
            opacity: 0.9;
            mix-blend-mode: screen;
        }

        /* Body */
        .email-body {
            padding: 40px;
            border-bottom: 1px solid #27272a;
        }
        
        h1 {
            margin-top: 0;
            font-size: 20px;
            font-weight: 500;
            letter-spacing: -0.5px;
            color: #ffffff;
            text-align: left;
        }
        
        p {
            margin: 0 0 24px 0;
            font-size: 14px;
            color: #a1a1aa;
            text-align: left;
            font-weight: 400;
        }
        
        /* Button */
        .btn-container {
            text-align: left;
            margin: 32px 0;
        }
        
        .btn {
            display: inline-block;
            background-color: #ededed;
            color: #000000;
            font-weight: 500;
            font-size: 14px;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            transition: opacity 0.3s ease;
        }
        
        .btn:hover {
            opacity: 0.8;
        }
        
        /* Soft Security Notice Box */
        .security-notice {
            background-color: transparent;
            border: 1px solid #27272a;
            padding: 24px;
            margin-top: 40px;
            border-radius: 6px;
            text-align: left;
        }
        
        .security-notice h3 {
            color: #ededed;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 0 0 8px 0;
            font-weight: 500;
        }

        .security-notice p {
            margin: 0;
            font-size: 13px;
            color: #71717a;
        }
        
        /* Raw Link Fallback */
        .raw-link {
            font-size: 12px;
            color: #52525b;
            word-break: break-all;
            margin-top: 30px;
            text-align: left;
        }
        
        .raw-link a {
            color: #a1a1aa;
            text-decoration: none;
            border-bottom: 1px solid #52525b;
        }
        
        /* Footer */
        .email-footer {
            padding: 32px 40px;
            text-align: left;
            border-bottom: 1px solid #27272a;
        }
        
        .footer-text {
            font-size: 12px;
            color: #52525b;
            margin-bottom: 8px;
            line-height: 1.6;
        }
        
        .footer-links {
            margin-top: 16px;
        }

        .footer-links a {
            color: #71717a;
            text-decoration: none;
            margin-right: 16px;
            transition: color 0.2s ease;
        }

        .footer-links a:hover {
            color: #ffffff;
        }

        /* Preheader text (hidden in body) */
        .preheader {
            display: none;
            max-height: 0px;
            overflow: hidden;
        }

        /* Responsive */
        @media screen and (max-width: 600px) {
            .email-body, .email-header, .email-footer, .hero-graphic-container, .meta-row {
                padding-left: 24px;
                padding-right: 24px;
            }
        }
    </style>
</head>
<body>
    <!-- Preheader Text for Email Clients -->
    <div class="preheader">
        Secure authentication required: Reset your MarketVault password.
    </div>

    <!-- Main Wrapper -->
    <table class="email-wrapper" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
            <td align="center">
                <!-- Grid Container -->
                <table class="email-container" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                    
                    <!-- Header Area -->
                    <tr>
                        <td class="email-header">
                            <a href="#" class="brand-logo">
                                Bazaar
                            </a>
                        </td>
                    </tr>
                    
                    <!-- Content Area -->
                    <tr>
                        <td class="email-body">
                            <h1>Authentication Reset</h1>
                            
                            <p>Hello ${options.username},</p>
                            
                            <p>A request was initiated to update the credentials for your institutional trading account. To proceed securely, please verify your identity using the link below.</p>
                            
                            <div class="btn-container">
                                <a href="${options.baseUrl}/auth/resetpassword?token=${options.token}" class="btn">Reset Password</a>
                            </div>
                            
                            <p style="font-size: 13px; color: #71717a;">
                                This secure session link expires in 30 minutes.
                            </p>
                            
                            <div class="security-notice">
                                <h3>Unrecognized Activity?</h3>
                                <p>If you did not initiate this request, no action is required. Your assets remain secured behind our encrypted vault. Please forward this to our security team if you suspect unauthorized access attempts.</p>
                            </div>
                            
                            <div class="raw-link">
                                Secure Link Verification:<br>
                                <a href="${options.baseUrl}/auth/resetpassword?token=${options.token}">${options.baseUrl}/auth/resetpassword?token=${options.token}</a>
                            </div>
                            
                        </td>
                    </tr>
                    <tr>
                        <td class="email-footer">
                            <p class="footer-text">
                                Bulls and Bears PDEU<br>
                                The finance club of PDEU
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `,
	});
};
