const nodemailer = require('nodemailer');
const mailgun = require('mailgun-js');

// Initialize Mailgun
const initializeMailgun = () => {
  const apiKey = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  
  if (apiKey && domain) {
    return mailgun({ apiKey, domain });
  }
  return null;
};

// Create transporter for nodemailer (fallback)
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailgun.org',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
};

// Send email using Mailgun or nodemailer
const sendEmail = async (to, subject, html) => {
  const mg = initializeMailgun();
  
  const mailOptions = {
    from: process.env.EMAIL_FROM || 'Stock Management <noreply@stockmanager.com>',
    to,
    subject,
    html
  };

  try {
    if (mg) {
      // Use Mailgun
      await mg.messages().send(mailOptions);
      console.log(`📧 Email sent via Mailgun to: ${to}`);
      return true;
    } else {
      // Fallback to nodemailer
      const transporter = createTransporter();
      await transporter.sendMail(mailOptions);
      console.log(`📧 Email sent via SMTP to: ${to}`);
      return true;
    }
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
};

// Send company approval email
const sendApprovalEmail = async (companyEmail, companyName, adminName) => {
  const subject = 'Your Company Has Been Approved - Stock Management System';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">🎉 Congratulations!</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>${adminName}</strong>,</p>
        
        <p>We are pleased to inform you that your company <strong>${companyName}</strong> has been <span style="color: #28a745; font-weight: bold;">APPROVED</span> and is now active on the Stock Management System.</p>
        
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745;">
          <h3 style="margin-top: 0; color: #28a745;">✅ What's Next?</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Log in to your account using your credentials</li>
            <li>Complete your company profile</li>
            <li>Start managing your inventory and sales</li>
            <li>Invite team members to join your account</li>
          </ul>
        </div>
        
        <p>If you have any questions or need assistance, please don't hesitate to contact our support team.</p>
        
        <div style="text-align: center; margin-top: 30px;">
          <a href="${process.env.FRONTEND_URL || 'https://stock-management-v3rl.onrender.com'}" style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Login to Your Account</a>
        </div>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated message from Stock Management System. Please do not reply to this email.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(companyEmail, subject, html);
};

// Send company rejection email
const sendRejectionEmail = async (companyEmail, companyName, adminName, reason) => {
  const subject = 'Your Company Registration - Stock Management System';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%); padding: 30px; border-radius: 10px 10px 0 0;">
        <h1 style="color: white; margin: 0; text-align: center;">Important Update</h1>
      </div>
      
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #ddd; border-top: none;">
        <p>Dear <strong>${adminName}</strong>,</p>
        
        <p>We regret to inform you that your company <strong>${companyName}</strong>'s registration has been <span style="color: #e53e3e; font-weight: bold;">NOT APPROVED</span>.</p>
        
        ${reason ? `
        <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #e53e3e;">
          <h3 style="margin-top: 0; color: #e53e3e;">Reason:</h3>
          <p style="margin: 0;">${reason}</p>
        </div>
        ` : ''}
        
        <p>If you believe this is an error or would like to resubmit your application, please contact our support team.</p>
        
        <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
        
        <p style="font-size: 12px; color: #666; text-align: center;">
          This is an automated message from Stock Management System. Please do not reply to this email.
        </p>
      </div>
    </body>
    </html>
  `;

  return sendEmail(companyEmail, subject, html);
};

module.exports = {
  sendEmail,
  sendApprovalEmail,
  sendRejectionEmail
};
