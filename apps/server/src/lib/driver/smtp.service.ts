import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

// Define Supporting Types
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true for SMTPS (SSL/TLS direct), false for STARTTLS
  auth: {
    user: string;
    pass: string;
  };
  logger?: boolean | any; // Or a more specific logger type
}

export interface MailAttachment {
  filename: string;
  path?: string; // Path to the file if on disk
  content?: Buffer | string; // Content if not from a file
  contentType?: string;
  cid?: string; // For inline attachments
}

export interface MailSendOptions {
  from: string; // e.g., "Sender Name <sender@example.com>"
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  headers?: Record<string, string>; // Custom headers
}

// Implement SmtpService Class
export class SmtpService {
  private transporter: Transporter;
  private config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.config = config;
    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure, // true for 465, false for other ports (like 587 for STARTTLS)
      auth: {
        user: this.config.auth.user,
        pass: this.config.auth.pass,
      },
      logger: config.logger !== undefined ? config.logger : false,
      // requireTLS: !this.config.secure, // For STARTTLS on port 587, nodemailer usually handles this automatically.
                                      // `secure: false` and port 587 typically implies STARTTLS.
                                      // Explicit `requireTLS` can be added if needed for specific server configs.
    });
  }

  async sendMail(options: MailSendOptions): Promise<{ messageId: string; response: string; }> {
    try {
      // Ensure 'from' is properly set, otherwise use the authenticated user
      const mailOptions = {
        ...options,
        from: options.from || this.config.auth.user, 
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log(`SMTP mail sent: ${info.messageId}`);
      return {
        messageId: info.messageId,
        response: info.response,
      };
    } catch (error) {
      console.error(`SMTP sendMail error:`, error);
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      const success = await this.transporter.verify();
      if (success) {
        console.log('SMTP connection verified successfully.');
      } else {
        console.error('SMTP connection verification failed, but no error was thrown.');
      }
      return success;
    } catch (error) {
      console.error('SMTP connection verification failed:', error);
      return false;
    }
  }
}
