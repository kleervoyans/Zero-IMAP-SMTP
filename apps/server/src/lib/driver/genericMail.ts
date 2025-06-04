import type {
  MailManager,
  IGetThreadResponse,
  ParsedDraft,
  IOutgoingMessage,
  CreateDraftData,
  Label,
  ParsedMessage,
} from './types'; // Actual path
import { ImapService, ImapConfig, FullMessage as ImapFullMessage } from './imap.service';
import { SmtpService, SmtpConfig } from './smtp.service';
import { Pop3Service, Pop3Config } from './pop3.service';
import type { HonoContext } from '../../ctx';
import { StandardizedError } from './utils'; // Actual path

// Configuration types
export interface GenericMailManagerAuthConfig {
  email: string;
  passwordPlainText: string;
  imap: ImapConfig;
  smtp: SmtpConfig;
  pop3?: Pop3Config;
  name?: string; // Optional user name
}

export type GenericMailManagerConfig = {
  auth: GenericMailManagerAuthConfig;
  c?: HonoContext;
};

export class GenericMailManager implements MailManager {
  public config: GenericMailManagerConfig;
  private imapService: ImapService;
  private smtpService: SmtpService;
  private pop3Service?: Pop3Service;
  private honoContext?: HonoContext;

  constructor(config: GenericMailManagerConfig) {
    this.config = config;
    this.honoContext = config.c;

    // Note: The ImapConfig and SmtpConfig types in imap.service.ts and smtp.service.ts
    // already include the nested auth structure.
    // So, we directly use this.config.auth.imap and this.config.auth.smtp
    // and then override the auth part with email/passwordPlainText for these services.
    this.imapService = new ImapService({
      ...this.config.auth.imap, // host, port, secure, requireTLS from user's IMAP-specific config
      auth: {
        // Override auth with top-level credentials
        user: this.config.auth.email,
        pass: this.config.auth.passwordPlainText,
      },
      logger: false, // Or pass from HonoContext if available/configured
    });

    this.smtpService = new SmtpService({
      ...this.config.auth.smtp, // host, port, secure from user's SMTP-specific config
      auth: {
        // Override auth with top-level credentials
        user: this.config.auth.email,
        pass: this.config.auth.passwordPlainText,
      },
      logger: false, // Or pass from HonoContext
    });
    if (this.config.auth.pop3) {
      this.pop3Service = new Pop3Service({
        ...this.config.auth.pop3,
        auth: {
          user: this.config.auth.email,
          pass: this.config.auth.passwordPlainText,
        },
      });
      this.pop3Service.connect().catch((err) => {
        console.error('POP3 connection error:', err);
      });
    }
  }

  // --- Essential Implementation ---

  async get(id: string): Promise<IGetThreadResponse> {
    // IMAP typically fetches single messages. 'id' is message UID.
    // Mailbox needs to be known or inferred. Assume INBOX for now.
    // A better approach might be to pass "mailboxPath/uid" as id.
    const mailbox = 'INBOX'; // Placeholder
    const message = this.pop3Service
      ? await this.pop3Service.fetchMessage(Number(id)).catch(() => null)
      : await this.imapService.fetchMessage(mailbox, id);
    if (!message) {
      throw new StandardizedError('Message not found', 404);
    }
    const parsedMessage =
      typeof message === 'string'
        ? this.parsePop3Message(message, id)
        : this.mapImapMessageToParsedMessage(message, mailbox);
    return {
      messages: [parsedMessage],
      latest: parsedMessage,
      hasUnread: typeof message === 'string' ? true : !message.flags.includes('\\Seen'),
      totalReplies: 0,
      labels:
        typeof message === 'string'
          ? []
          : message.flags.map((flag) => ({ id: flag, name: flag, type: 'system' })),
    };
  }

  async list(params: {
    folder: string;
    query?: string; // IMAP SEARCH query (needs parsing/translation)
    maxResults?: number;
    labelIds?: string[]; // Map to IMAP flags/keywords
    pageToken?: string | number; // UID for pagination start
  }): Promise<{ threads: { id: string; $raw?: unknown }[]; nextPageToken: string | null }> {
    // Note: IMAP 'listMessages' in ImapService is simplified.
    // A full implementation would use params.query for SEARCH criteria.
    // labelIds could map to KEYWORD searches or flag searches.
    // pageToken (UID) for starting point.
    const messages = this.pop3Service
      ? (await this.pop3Service.listMessages()).map((num) => ({
          uid: num,
          flags: [],
          envelope: {},
        }))
      : await this.imapService.listMessages(
          params.folder,
          params.pageToken as number,
          params.maxResults,
        );

    const threads = messages.map((msg) => ({
      id: msg.uid.toString(),
      // $raw: msg, // Optionally include raw IMAP message info
    }));

    let nextPageToken: string | null = null;
    if (messages.length > 0 && params.maxResults && messages.length === params.maxResults) {
      nextPageToken = (messages[messages.length - 1].uid + 1).toString();
    }

    return { threads, nextPageToken };
  }

  async create(data: IOutgoingMessage): Promise<{ id?: string | null }> {
    let fromAddress = this.config.auth.email;
    if (this.config.auth.name) {
      fromAddress = `"${this.config.auth.name}" <${this.config.auth.email}>`;
    }

    const result = await this.smtpService.sendMail({
      from: fromAddress,
      to: data.to.map((t) => t.email),
      cc: data.cc?.map((c) => c.email),
      bcc: data.bcc?.map((b) => b.email),
      subject: data.subject,
      text: data.message,
      html: data.htmlBody,
      attachments: data.attachments?.map((att) => ({
        filename: att.filename || 'attachment',
        content: att.content, // Assuming base64 string or Buffer
        contentType: att.contentType,
        path: att.path, // if path is provided
      })),
      headers: data.headers,
      // For threading:
      // inReplyTo: data.inReplyTo, // if IOutgoingMessage has it
      // references: data.references, // if IOutgoingMessage has it
    });
    return { id: result.messageId };
  }

  async markAsRead(threadIds: string[]): Promise<void> {
    const mailbox = 'INBOX'; // Placeholder - needs context
    for (const id of threadIds) {
      await this.imapService.setFlags(mailbox, id, ['\\Seen']);
    }
  }

  async markAsUnread(threadIds: string[]): Promise<void> {
    const mailbox = 'INBOX'; // Placeholder - needs context
    for (const id of threadIds) {
      await this.imapService.unsetFlags(mailbox, id, ['\\Seen']);
    }
  }

  async delete(id: string): Promise<void> {
    const trashFolder = 'Trash'; // Common, but should be configurable/discoverable
    const sourceMailbox = 'INBOX'; // Placeholder - needs context

    try {
      await this.imapService.moveMessage(sourceMailbox, id, trashFolder);
    } catch (error) {
      console.warn(
        `Could not move message ${id} to ${trashFolder}. Setting \\Deleted flag as fallback. Expunge not implemented in this manager.`,
      );
      await this.imapService.setFlags(sourceMailbox, id, ['\\Deleted']);
      // An expunge call would be: await this.imapService.expunge(sourceMailbox); // or with specific UIDs
      // For now, re-throw as the original operation (move) failed.
      throw new StandardizedError(
        `Failed to move message to trash and fallback also problematic: ${error}`,
        500,
        error,
      );
    }
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<string | undefined> {
    const mailbox = 'INBOX'; // Placeholder - needs context
    const stream = await this.imapService.downloadAttachment(mailbox, messageId, attachmentId);
    if (!stream) return undefined;

    const chunks = [];
    // Assuming stream is a Node.js ReadableStream or a Web ReadableStream
    if (Symbol.asyncIterator in stream) {
      // Web ReadableStream
      for await (const chunk of stream as any) {
        chunks.push(Buffer.from(chunk));
      }
    } else if (typeof (stream as any).on === 'function') {
      // Node.js ReadableStream
      return new Promise((resolve, reject) => {
        (stream as any).on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
        (stream as any).on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        (stream as any).on('error', reject);
      });
    } else {
      throw new Error('Unsupported stream type for attachment download');
    }
    return Buffer.concat(chunks).toString('base64');
  }

  // --- Drafts ---
  private DRAFTS_FOLDER = 'Drafts'; // Common, but should be configurable/discoverable

  async createDraft(
    data: CreateDraftData,
  ): Promise<{ id?: string | null; success?: boolean; error?: string }> {
    // Constructing a full raw RFC822 message for IMAP append is complex.
    // Nodemailer can be used to build this if available, or a simpler string construction.
    // This example is highly simplified and likely insufficient for rich content.
    // ImapService would need an `append` method.
    // For now, we'll use a console warning and mock success as per plan.
    let rawMessage = `Subject: ${data.subject || ''}\r\n`;
    rawMessage += `To: ${data.to?.map((t) => t.email).join(', ') || ''}\r\n`;
    if (data.cc && data.cc.length > 0)
      rawMessage += `Cc: ${data.cc.map((t) => t.email).join(', ') || ''}\r\n`;
    if (data.bcc && data.bcc.length > 0)
      rawMessage += `Bcc: ${data.bcc.map((t) => t.email).join(', ') || ''}\r\n`; // Note: BCC in headers is unusual for drafts
    // Other headers (Content-Type, Message-ID, Date) would be needed for a proper draft.
    rawMessage += `\r\n${data.message || ''}`;

    try {
      // Placeholder for: const appendResult = await this.imapService.appendMessage(this.DRAFTS_FOLDER, rawMessage, ['\\Draft']);
      // if (appendResult && appendResult.uid) {
      //    return { id: appendResult.uid.toString(), success: true };
      // }
      console.warn(
        'createDraft: ImapService.appendMessage method not yet implemented or available. Mocking success.',
      );
      return { id: `mockDraft_${Date.now()}`, success: true }; // Mock UID
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async getDraft(id: string): Promise<ParsedDraft> {
    const message = await this.imapService.fetchMessage(this.DRAFTS_FOLDER, id);
    if (!message || !message.flags.includes('\\Draft')) {
      // Ensure it's a draft
      throw new StandardizedError('Draft not found or not a draft', 404);
    }
    return {
      id: message.uid.toString(),
      to: message.envelope.to?.map((t) => t.address || ''),
      cc: message.envelope.cc?.map((c) => c.address || ''),
      bcc: message.envelope.bcc?.map((b) => b.address || ''),
      subject: message.envelope.subject,
      content: message.textBody || message.htmlBody, // Prioritize text or html
      // attachments: this.mapImapMessageToParsedMessage(message, this.DRAFTS_FOLDER).attachments, // if needed
    };
  }

  async listDrafts(params: {
    folder?: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }): Promise<{ threads: { id: string; $raw?: unknown }[]; nextPageToken: string | null }> {
    return this.list({ ...params, folder: this.DRAFTS_FOLDER });
  }

  async sendDraft(id: string, data: IOutgoingMessage): Promise<void> {
    // 1. Fetch the draft to potentially get more details if IOutgoingMessage is minimal
    // const draftDetails = await this.getDraft(id); // Optional, if `data` is not complete

    // 2. Send the message using the provided data (or augmented data from draft)
    await this.create(data);

    // 3. Delete the draft from the Drafts folder
    // Ideally, move to Trash or just set \Deleted and expunge.
    try {
      await this.imapService.setFlags(this.DRAFTS_FOLDER, id, ['\\Deleted']);
      // Optionally: await this.imapService.expunge(this.DRAFTS_FOLDER, [id]);
      console.log(`Draft ${id} marked as \\Deleted. Expunge step would be next.`);
    } catch (error) {
      console.error(`Error deleting draft ${id} after sending:`, error);
      throw new StandardizedError(`Failed to delete draft ${id} after sending.`, 500, error);
    }
  }

  // --- Labels (Map to IMAP Folders & Flags) ---
  async modifyLabels(
    ids: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void> {
    const mailbox = 'INBOX'; // Placeholder, real mailbox context needed for each id

    for (const id of ids) {
      // System flags (non-folder based)
      if (options.addLabels.includes('STARRED'))
        await this.imapService.setFlags(mailbox, id, ['\\Starred']);
      if (options.addLabels.includes('IMPORTANT'))
        await this.imapService.setFlags(mailbox, id, ['\\Flagged']); // Standard \Flagged, not "IMPORTANT"

      if (options.removeLabels.includes('STARRED'))
        await this.imapService.unsetFlags(mailbox, id, ['\\Starred']);
      if (options.removeLabels.includes('IMPORTANT'))
        await this.imapService.unsetFlags(mailbox, id, ['\\Flagged']);

      // Folder-based "labels" (moving messages)
      // This assumes 'id' is just UID and mailbox is INBOX. A more robust system
      // would require id to be "mailbox/uid" or have mailbox context.
      if (options.addLabels.includes('TRASH')) {
        await this.imapService.moveMessage(mailbox, id, 'Trash'); // Assumes 'Trash' folder
      } else if (options.removeLabels.includes('INBOX') && !options.addLabels.includes('TRASH')) {
        // Archive
        await this.imapService.moveMessage(mailbox, id, 'Archive'); // Assumes 'Archive' folder
      }
      // Adding to INBOX (unarchiving) would be a move from 'Archive' to 'INBOX'.
      // Custom labels as folders are more complex and would involve moving to that folder.
    }
  }

  async getUserLabels(): Promise<Label[]> {
    const mailboxes = await this.imapService.listMailboxes();
    const systemFlags: Label[] = [
      // Represent common IMAP flags as labels
      { id: '\\Seen', name: 'Read', type: 'system' },
      { id: '\\Starred', name: 'Starred', type: 'system' },
      { id: '\\Flagged', name: 'Flagged', type: 'system' }, // Often "Important"
      { id: '\\Draft', name: 'Draft', type: 'system' },
      { id: '\\Deleted', name: 'Deleted', type: 'system' },
    ];
    const folderLabels: Label[] = mailboxes.map((mb) => ({
      id: mb.path,
      name: mb.name,
      type: 'folder',
    }));
    return [...systemFlags, ...folderLabels];
  }

  async getLabel(id: string): Promise<Label> {
    // id can be mailbox path or flag name
    // Check if it's a known system flag first
    const systemLabel = (await this.getUserLabels()).find(
      (l) => l.id === id && l.type === 'system',
    );
    if (systemLabel) return systemLabel;

    // Assume it's a folder path
    const mailboxes = await this.imapService.listMailboxes();
    const foundFolder = mailboxes.find((mb) => mb.path === id);
    if (foundFolder) {
      return { id: foundFolder.path, name: foundFolder.name, type: 'folder' };
    }
    throw new StandardizedError(`Label (folder or flag) '${id}' not found`, 404);
  }

  async createLabel(label: { name: string /* color? */ }): Promise<void> {
    // This means creating a new IMAP folder.
    // ImapService needs a createMailbox(path) method.
    // await this.imapService.createMailbox(label.name); // e.g., label.name could be "Work/ProjectX"
    console.warn(
      `createLabel (createMailbox for ${label.name}) not fully implemented in ImapService for this subtask.`,
    );
  }

  async updateLabel(id: string, label: { name: string /* color? */ }): Promise<void> {
    // Renaming an IMAP folder (id is oldPath).
    // ImapService needs a renameMailbox(oldPath, newPath) method.
    // await this.imapService.renameMailbox(id, label.name);
    console.warn(
      `updateLabel (renameMailbox from ${id} to ${label.name}) not fully implemented in ImapService for this subtask.`,
    );
  }

  async deleteLabel(id: string): Promise<void> {
    // Deleting an IMAP folder.
    // ImapService needs a deleteMailbox(path) method.
    // await this.imapService.deleteMailbox(id);
    console.warn(
      `deleteLabel (deleteMailbox ${id}) not fully implemented in ImapService for this subtask.`,
    );
  }

  // --- OAuth Specific (Not Applicable for direct IMAP/SMTP) ---
  async getTokens(code: string): Promise<any> {
    throw new StandardizedError('OAuth not supported for direct IMAP/SMTP', 501);
  }
  getScope(): string {
    return '';
  }
  async revokeRefreshToken(refreshToken: string): Promise<boolean> {
    console.warn('revokeRefreshToken called on GenericMailManager, which is not OAuth-based.');
    return false;
  }

  // --- Other Methods ---
  async count(): Promise<{ count?: number; label?: string }[]> {
    const mailboxes = await this.imapService.listMailboxes();
    const counts = [];
    for (const mb of mailboxes) {
      try {
        // ImapService needs a status(mailboxPath, {messages: true}) method
        // const status = await this.imapService.status(mb.path, {messages: true});
        // counts.push({ label: mb.name, count: status.messages });
        console.warn(
          `count for ${mb.name}: ImapService.status method not fully implemented. Returning placeholder.`,
        );
        counts.push({ label: mb.name, count: 0 }); // Placeholder
      } catch (error) {
        console.error(`Error getting status for mailbox ${mb.name}:`, error);
        counts.push({ label: mb.name, count: undefined }); // Indicate error or unknown
      }
    }
    return counts;
  }

  async getUserInfo(): Promise<{ address: string; name: string; photo: string }> {
    return {
      address: this.config.auth.email,
      name: this.config.auth.name || this.config.auth.email.split('@')[0], // Default name from email
      photo: '', // No standard way to get photo URL from IMAP/SMTP
    };
  }

  normalizeIds(ids: string[]): { threadIds: string[] } {
    // For IMAP UIDs, they are generally already in a usable string format.
    return { threadIds: ids };
  }

  async getEmailAliases(): Promise<{ email: string; name?: string; primary?: boolean }[]> {
    // Standard IMAP/SMTP doesn't provide alias information. Return primary configured email.
    return [
      {
        email: this.config.auth.email,
        name: this.config.auth.name,
        primary: true,
      },
    ];
  }

  // --- Helper to map IMAP message to ParsedMessage (from types.ts) ---
  private mapImapMessageToParsedMessage(msg: ImapFullMessage, mailbox: string): ParsedMessage {
    const fromParty = msg.envelope?.from?.[0];
    const toParties = msg.envelope?.to || [];
    const ccParties = msg.envelope?.cc || [];
    const bccParties = msg.envelope?.bcc || []; // Usually not present in fetched message for privacy

    return {
      id: msg.uid.toString(),
      threadId: msg.uid.toString(), // For IMAP, message UID often serves as threadId for individual messages
      mailbox: mailbox,
      subject: msg.envelope?.subject || '',
      from: fromParty ? { name: fromParty.name || '', email: fromParty.address || '' } : undefined,
      to: toParties.map((t: any) => ({ name: t.name || '', email: t.address || '' })),
      cc: ccParties.map((c: any) => ({ name: c.name || '', email: c.address || '' })),
      bcc: bccParties.map((b: any) => ({ name: b.name || '', email: b.address || '' })), // Likely empty
      bodyPlain: msg.textBody,
      bodyHtml: msg.htmlBody,
      // prefer internalDate if available, fallback to envelope date
      receivedOn: msg.internalDate || msg.envelope?.date || new Date(),
      sentOn: msg.envelope?.date || new Date(), // Envelope date is closer to sent time
      read: msg.flags.includes('\\Seen'),
      labels: msg.flags.map((f: string) => ({
        id: f,
        name: f.startsWith('\\') ? f.substring(1) : f, // Prettify system flags like \Seen -> Seen
        type: 'system', // All IMAP flags are system level
      })),
      attachments:
        msg.attachments?.map((att: any) => ({
          id: att.partID, // This is the IMAP partID
          name: att.filename || `attachment-${att.partID}`,
          contentType: att.type,
          size: att.size,
          // A direct download URL would need to be constructed based on API routes
          // e.g. url: `${this.honoContext?.env?.APP_URL}/api/mail/attachment/${mailbox}/${msg.uid}/${att.partID}`
          // For now, leave url undefined or use a placeholder structure if your app handles it.
        })) || [],
      isDraft: msg.flags.includes('\\Draft'),
      isScheduled: false, // IMAP doesn't have native scheduled send
      snoozedUntil: null, // IMAP doesn't have native snooze
      $raw: this.honoContext?.env?.NODE_ENV === 'development' ? msg : undefined, // Only include raw in dev
    };
  }

  // Very naive parser for POP3 raw messages
  private parsePop3Message(raw: string, id: string): ParsedMessage {
    const [headerPart, ...bodyParts] = raw.split(/\r?\n\r?\n/);
    const headers: Record<string, string> = {};
    for (const line of headerPart.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[key] = value;
      }
    }
    return {
      id,
      threadId: id,
      mailbox: 'INBOX',
      subject: headers['subject'] || '',
      from: headers['from'] ? { name: '', email: headers['from'] } : undefined,
      to: [],
      cc: [],
      bcc: [],
      bodyPlain: bodyParts.join('\n\n'),
      bodyHtml: undefined,
      receivedOn: new Date(),
      sentOn: new Date(),
      read: false,
      labels: [],
      attachments: [],
      isDraft: false,
      isScheduled: false,
      snoozedUntil: null,
      $raw: this.honoContext?.env?.NODE_ENV === 'development' ? raw : undefined,
    };
  }
}
