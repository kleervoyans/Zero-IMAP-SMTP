import { ImapFlow, ImapFlowOptions } from 'imapflow';

// Define Supporting Types
export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean; // true for SSL/TLS direct connection, false for STARTTLS
  auth: {
    user: string;
    pass: string;
  };
  logger?: false | any; // Or a more specific logger type if you have one
  requireTLS?: boolean; // Often used for STARTTLS
}

export interface Mailbox {
  path: string;
  name: string; // Derived from path
  uidValidity?: number;
  // Add other relevant mailbox attributes if available
}

export interface MessageEnvelope {
  date?: Date;
  subject?: string;
  from?: { name?: string; address?: string }[];
  to?: { name?:string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  bcc?: { name?: string; address?: string }[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface BasicMessageInfo {
  uid: number; // IMAP UID
  flags: string[];
  envelope: MessageEnvelope;
  size?: number;
  // Potentially internalDate if available
}

export interface AttachmentInfo {
  partID: string;
  type: string; // e.g., 'application/pdf'
  filename?: string;
  size?: number;
  disposition?: string; // 'attachment', 'inline'
  // encoding?: string;
}

export interface MessagePart {
    partID: string;
    type: string; // e.g. text/plain, text/html, image/jpeg
    size?: number;
    encoding?: string;
    filename?: string;
    disposition?: string;
    // other relevant attributes
}

export interface FullMessage extends BasicMessageInfo {
  bodyStructure: any; // Raw body structure from imapflow, can be complex
  textBody?: string; // Plain text body part
  htmlBody?: string; // HTML body part
  attachments: AttachmentInfo[];
}

// Implement ImapService Class
export class ImapService {
  private client: ImapFlow;
  private config: ImapConfig;
  private connectionLock: any; // imapflow specific lock object

  constructor(config: ImapConfig) {
    this.config = config;
    const imapOptions: ImapFlowOptions = {
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.auth.user,
        pass: this.config.auth.pass,
      },
      logger: config.logger !== undefined ? config.logger : false, // Default to false if not provided
    };
    if (config.requireTLS !== undefined) {
        imapOptions.requireTLS = config.requireTLS;
    }
    this.client = new ImapFlow(imapOptions);
  }

  async connect(): Promise<void> {
    if (this.client.usable) {
      console.log('IMAP client is already connected or connecting.');
      return;
    }
    try {
      await this.client.connect();
      console.log(`IMAP connected to ${this.config.host}`);
    } catch (error) {
      console.error(`IMAP connection error to ${this.config.host}:`, error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client.usable && this.client.state === this.client.states.LOGOUT) {
        console.log('IMAP client is already disconnected.');
        return;
    }
    try {
      await this.client.logout();
      console.log(`IMAP disconnected from ${this.config.host}`);
    } catch (error) {
      console.error(`IMAP disconnection error from ${this.config.host}:`, error);
      // Don't throw here, as we want to ensure logout is attempted.
    }
  }

  async listMailboxes(): Promise<Mailbox[]> {
    await this.connectIfNeeded();
    try {
      const mailboxes = await this.client.list();
      return mailboxes.map(mb => ({
        path: mb.path,
        name: mb.name, // imapflow provides 'name' which is the last part of the path
        // uidValidity: mb.uidValidity, // If available and needed
      }));
    } catch (error) {
      console.error('IMAP listMailboxes error:', error);
      throw error;
    }
  }

  async listMessages(mailboxPath: string, startSeq?: number, count?: number): Promise<BasicMessageInfo[]> {
    await this.connectIfNeeded();
    let lock;
    try {
      lock = await this.client.getMailboxLock(mailboxPath);
      const messages: BasicMessageInfo[] = [];
      // imapflow uses UID ranges or sequence numbers. '*' means latest.
      // For simplicity, let's fetch recent messages. A proper implementation
      // would handle pagination using UIDs or sequence numbers based on `startSeq` and `count`.
      // Example: Fetch last 'count' messages or up to a certain number if count is not specified.
      // This example fetches basic info for messages from sequence 1 up to 100.
      // A more robust solution would use UID ranges and handle the 'startSeq' and 'count' for pagination.
      
      let fetchRange = '1:100'; // Default range, adjust as needed
      if (startSeq && count) {
        fetchRange = `${startSeq}:${startSeq + count - 1}`;
      } else if (count) { // fetch last 'count' messages
         // Get total messages first to determine the range for the last 'count'
         const mailboxStatus = await this.client.status(mailboxPath, {messages: true});
         const totalMessages = mailboxStatus.messages ?? 0;
         if (totalMessages > 0) {
            const start = Math.max(1, totalMessages - count + 1);
            fetchRange = `${start}:${totalMessages}`;
         } else {
            return []; // No messages
         }
      }


      for await (const msg of this.client.fetch(fetchRange, { uid: true, flags: true, envelope: true, size: true })) {
        messages.push({
          uid: msg.uid,
          flags: Array.from(msg.flags), // Convert Set to Array
          envelope: { // Map envelope fields
            date: msg.envelope.date || undefined,
            subject: msg.envelope.subject || undefined,
            from: msg.envelope.from?.map(f => ({name: f.name, address: f.address})),
            to: msg.envelope.to?.map(t => ({name: t.name, address: t.address})),
            cc: msg.envelope.cc?.map(c => ({name: c.name, address: c.address})),
            bcc: msg.envelope.bcc?.map(b => ({name: b.name, address: b.address})),
            messageId: msg.envelope.messageId || undefined,
            inReplyTo: msg.envelope.inReplyTo || undefined,
            references: msg.envelope.references || undefined,
          },
          size: msg.size,
        });
      }
      return messages;
    } catch (error) {
      console.error(`IMAP listMessages error in ${mailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }

  async fetchMessage(mailboxPath: string, uid: string): Promise<FullMessage | null> {
    await this.connectIfNeeded();
    let lock;
    try {
      lock = await this.client.getMailboxLock(mailboxPath);
      const message = await this.client.fetchOne(uid, { 
        uid: true, flags: true, envelope: true, size: true, bodyStructure: true, internalDate: true 
      });
      if (!message) return null;

      let textBody: string | undefined;
      let htmlBody: string | undefined;
      const attachments: AttachmentInfo[] = [];

      // Function to find text/plain and text/html parts
      const findBodyParts = async (part: any, partIDPrefix = '') => {
        const currentPartID = partIDPrefix ? `${partIDPrefix}.${part.partID}` : part.partID;
        if (part.type === 'text/plain' && !part.disposition) {
           const content = await this.client.download(uid, currentPartID);
           let strContent = '';
           for await (const chunk of content.content) {
               strContent += chunk.toString();
           }
           textBody = strContent;
        } else if (part.type === 'text/html' && !part.disposition) {
           const content = await this.client.download(uid, currentPartID);
           let strContent = '';
           for await (const chunk of content.content) {
               strContent += chunk.toString();
           }
           htmlBody = strContent;
        }
        // Attachment handling (basic example)
        if (part.disposition === 'attachment' || (part.filename && part.type !== 'text/plain' && part.type !== 'text/html')) {
            attachments.push({
                partID: currentPartID,
                type: part.type,
                filename: part.filename || 'untitled',
                size: part.size,
                disposition: part.disposition,
            });
        }

        if (part.childNodes && part.childNodes.length > 0) {
            for (const childNode of part.childNodes) {
                await findBodyParts(childNode, currentPartID);
            }
        }
      };
      
      if (message.bodyStructure) {
        if (message.bodyStructure.childNodes && message.bodyStructure.childNodes.length > 0) {
            for (const part of message.bodyStructure.childNodes) {
                await findBodyParts(part);
            }
        } else { // Single part message
            await findBodyParts(message.bodyStructure);
        }
      }


      return {
        uid: message.uid,
        flags: Array.from(message.flags),
        envelope: { /* map envelope fields as in listMessages */ 
            date: message.envelope.date || undefined,
            subject: message.envelope.subject || undefined,
            from: message.envelope.from?.map(f => ({name: f.name, address: f.address})),
            to: message.envelope.to?.map(t => ({name: t.name, address: t.address})),
            cc: message.envelope.cc?.map(c => ({name: c.name, address: c.address})),
            bcc: message.envelope.bcc?.map(b => ({name: b.name, address: b.address})),
            messageId: message.envelope.messageId || undefined,
            inReplyTo: message.envelope.inReplyTo || undefined,
            references: message.envelope.references || undefined,
        },
        size: message.size,
        bodyStructure: message.bodyStructure, // Keep the raw structure for potential advanced use
        textBody,
        htmlBody,
        attachments,
      };
    } catch (error) {
      console.error(`IMAP fetchMessage error for UID ${uid} in ${mailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }
  
  async downloadAttachment(mailboxPath: string, uid: string, partID: string): Promise<ReadableStream | null> {
    await this.connectIfNeeded();
    let lock;
    try {
      lock = await this.client.getMailboxLock(mailboxPath);
      const download = await this.client.download(uid, partID);
      return download?.content || null;
    } catch (error) {
      console.error(`IMAP downloadAttachment error for UID ${uid}, partID ${partID} in ${mailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }

  async setFlags(mailboxPath: string, uidOrRange: string, flags: string[]): Promise<void> {
    await this.connectIfNeeded();
    let lock;
    try {
      lock = await this.client.getMailboxLock(mailboxPath);
      await this.client.messageFlagsAdd(uidOrRange, flags);
    } catch (error) {
      console.error(`IMAP setFlags error in ${mailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }

  async unsetFlags(mailboxPath: string, uidOrRange: string, flags: string[]): Promise<void> {
    await this.connectIfNeeded();
    let lock;
    try {
      lock = await this.client.getMailboxLock(mailboxPath);
      await this.client.messageFlagsRemove(uidOrRange, flags);
    } catch (error) {
      console.error(`IMAP unsetFlags error in ${mailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }

  async moveMessage(mailboxPath: string, uid: string, destinationMailboxPath: string): Promise<void> {
    await this.connectIfNeeded();
    let lock;
    try {
      // Note: imapflow's move is UID based. Ensure destinationMailboxPath exists.
      lock = await this.client.getMailboxLock(mailboxPath);
      const moveResponse = await this.client.messageMove(uid, destinationMailboxPath);
      console.log('IMAP message move response:', moveResponse);
    } catch (error) {
      console.error(`IMAP moveMessage error from ${mailboxPath} to ${destinationMailboxPath}:`, error);
      throw error;
    } finally {
      if (lock) lock.release();
    }
  }
  
  private async connectIfNeeded(): Promise<void> {
    if (!this.client.usable || this.client.state === this.client.states.LOGOUT) {
      console.log('IMAP client not connected, attempting to connect...');
      await this.connect();
    }
  }
}
