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
<html dir="ltr" lang="en">
  <head>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
    <meta name="x-apple-disable-message-reformatting" />
  </head>
  <body
    style='background-color:rgb(243,244,246);font-family:ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";padding-top:40px;padding-bottom:40px'>
    <!--$-->
    <table
      align="center"
      width="100%"
      border="0"
      cellpadding="0"
      cellspacing="0"
      role="presentation"
      style="background-color:rgb(255,255,255);border-radius:8px;box-shadow:var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), 0 0 #0000;max-width:600px;margin-left:auto;margin-right:auto;padding:40px">
      <tbody>
        <tr style="width:100%">
          <td>
            <table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="text-align:center;margin-bottom:32px">
              <tbody>
                <tr>
                  <td>
                    <h1
                      style="font-size:28px;font-weight:700;color:rgb(17,24,39);margin:0px;margin-bottom:8px">
                      Verify Your Email Address
                    </h1>
                    <p
                      style="font-size:16px;color:rgb(75,85,99);margin:0px;line-height:24px;margin-top:0px;margin-bottom:0px;margin-left:0px;margin-right:0px">
                      Please use the verification code below to complete your
                      registration
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
            <table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="margin-bottom:32px">
              <tbody>
                <tr>
                  <td>
                    <p
                      style="font-size:16px;color:rgb(55,65,81);margin-bottom:0px;margin:0px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      Hi there,
                    </p>
                    <p
                      style="font-size:16px;color:rgb(55,65,81);margin-bottom:0px;margin:0px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      Thank you for signing up! To complete your account
                      verification, please enter the following 6-digit code:
                    </p>
                    <table
                      align="center"
                      width="100%"
                      border="0"
                      cellpadding="0"
                      cellspacing="0"
                      role="presentation"
                      style="text-align:center;background-color:rgb(249,250,251);border-radius:8px;padding:24px;margin-bottom:24px">
                      <tbody>
                        <tr>
                          <td>
                            <p
                              class="letter-spacing-[8px]"
                              style="font-size:32px;font-weight:700;color:rgb(17,24,39);margin:0px;line-height:24px;margin-top:0px;margin-bottom:0px;margin-left:0px;margin-right:0px">
                              ${options.otp}
                            </p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p
                      style="font-size:16px;color:rgb(55,65,81);margin-bottom:0px;margin:0px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      This verification code will expire in
                      <strong>10 minutes</strong> for security reasons.
                    </p>
                    <p
                      style="font-size:16px;color:rgb(55,65,81);margin-bottom:0px;margin:0px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      If you didn&#x27;t request this verification, please
                      ignore this email or contact our support team if you have
                      concerns.
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
            <table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="background-color:rgb(239,246,255);border-left-width:4px;border-style:solid;border-color:rgb(96,165,250);padding:16px;margin-bottom:32px">
              <tbody>
                <tr>
                  <td>
                    <p
                      style="font-size:14px;color:rgb(30,64,175);margin:0px;margin-bottom:8px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      <strong>Security Notice:</strong>
                    </p>
                    <p
                      style="font-size:14px;color:rgb(29,78,216);margin:0px;line-height:24px;margin-top:0px;margin-bottom:0px;margin-left:0px;margin-right:0px">
                      Never share this code with anyone. Our team will never ask
                      for your verification code.
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
            <hr
              style="border-color:rgb(229,231,235);margin-top:32px;margin-bottom:32px;width:100%;border:none;border-top:1px solid #eaeaea" />
			<table
              align="center"
              width="100%"
              border="0"
              cellpadding="0"
              cellspacing="0"
              role="presentation"
              style="text-align:center">
              <tbody>
                <tr>
                  <td>
                    <p
                      style="font-size:14px;color:rgb(107,114,128);margin-bottom:0px;margin:0px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      This email was sent to
                      <!-- -->${options.to}
                    </p>
                    <p
                      style="font-size:12px;color:rgb(156,163,175);margin:0px;margin-bottom:8px;line-height:24px;margin-top:0px;margin-left:0px;margin-right:0px">
                      © 2026 Bulls and Bears. All rights reserved.
                    </p>
                  </td>
                </tr>
              </tbody>
            </table>
		  </td>
        </tr>
      </tbody>
    </table>
    <!--7--><!--/$-->
  </body>
</html>
`,
	});
};
