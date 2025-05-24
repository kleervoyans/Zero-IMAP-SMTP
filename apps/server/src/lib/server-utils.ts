import { connection } from '@zero/db/schema';
import type { HonoContext } from '../ctx';
import { createDriver } from './driver';
import { and, eq } from 'drizzle-orm';
// Assuming GenericMailManagerConfig is exported from genericMail.ts or a central types file
import type { GenericMailManagerConfig, GenericMailManagerAuthConfig } from './driver/genericMail'; 
import type { ManagerConfig } from './driver/types'; // Existing OAuth based config

// Placeholder for a decryption function - this is CRITICAL and needs secure implementation
// In a real scenario, this would call a KMS or use a secure decryption method.
const decryptPassword = async (encryptedPassword: string): Promise<string> => {
    console.warn("decryptPassword: Using placeholder decryption. IMPLEMENT SECURE DECRYPTION!");
    // This is NOT secure. Replace with actual decryption logic.
    try {
        // Example: if it was base64 encoded for transit (very insecure for passwords)
        // return Buffer.from(encryptedPassword, 'base64').toString('utf8');
        // For now, assume it's somehow passed as plaintext IF NO ENCRYPTION IS SET UP YET
        // which is also very bad. This highlights the need for proper secret management.
        if (encryptedPassword.startsWith("decrypted:")) return encryptedPassword.replace("decrypted:","");
        return encryptedPassword; // No actual decryption if not prefixed for this placeholder
    } catch (e) {
        console.error("Decryption failed", e);
        throw new Error("Failed to decrypt password.");
    }
};


export const getActiveConnection = async (c: HonoContext) => {
  const { session, db } = c.var;
  if (!session?.user) throw new Error('Session Not Found');
  
  let activeConnectionDetails: (typeof connection.$inferSelect) | undefined;

  if (!session.activeConnection?.id) {
    // If no active connection ID in session, try to find the default or any connection
    activeConnectionDetails = await db.query.connection.findFirst({
      where: and(
        eq(connection.userId, session.user.id),
        // Optionally, prioritize default connection if that field exists on user table
        // or sort by creation date, etc.
      ),
    });
  } else {
    activeConnectionDetails = await db.query.connection.findFirst({
      where: and(
        eq(connection.userId, session.user.id),
        eq(connection.id, session.activeConnection.id),
      ),
    });
  }

  if (!activeConnectionDetails) {
    throw new Error(`No active or default connection found for user ${session.user.id}`);
  }

  // Validate required fields based on provider type
  // Cast to any to access potential new fields before schema is officially updated
  const connDetails = activeConnectionDetails as any; 

  if (connDetails.providerId === 'google' || connDetails.providerId === 'microsoft') {
    if (!connDetails.refreshToken || !connDetails.accessToken) {
      throw new Error(
        'OAuth Connection is not properly authorized, please reconnect the connection',
      );
    }
  } else if (connDetails.providerId === 'generic_imap_smtp') {
    // Check for fields that will be added to the connection schema for IMAP/SMTP
    if (!connDetails.email || !connDetails.encryptedPassword || !connDetails.imapHost || !connDetails.smtpHost) {
         throw new Error('Generic IMAP/SMTP connection is not configured completely.');
    }
  } else {
    // Potentially other providers or an unknown provider
    // Allow if essential fields like email are present, or throw error.
    if (!connDetails.email) {
        throw new Error('Connection details are incomplete for the provider.');
    }
  }
  return activeConnectionDetails; // Return the original type, not 'any'
};

export const connectionToDriver = async ( // Made async for potential decryption
  activeConnection: typeof connection.$inferSelect,
  c: HonoContext,
) => {
  let driverConfig: ManagerConfig | GenericMailManagerConfig;
  // Cast to any to access potential new fields before schema is officially updated
  const connDetails = activeConnection as any;

  if (connDetails.providerId === 'generic_imap_smtp') {
    // These fields (imapHost, imapPort etc.) are placeholders for actual schema fields
    // Ensure they are added to packages/db/src/schema.ts connection table.
    const plainTextPassword = await decryptPassword(connDetails.encryptedPassword || ''); // Ensure encryptedPassword field exists

    const authConfig: GenericMailManagerAuthConfig = {
      email: connDetails.email, // Assuming 'email' field stores the username
      passwordPlainText: plainTextPassword,
      name: connDetails.name || undefined, // Assuming 'name' field for user's display name
      imap: {
        host: connDetails.imapHost || '', // Placeholder, ensure this DB field exists
        port: connDetails.imapPort || 993, // Placeholder
        secure: connDetails.imapSecure !== undefined ? connDetails.imapSecure : true, // Placeholder
        requireTLS: connDetails.imapRequireTLS !== undefined ? connDetails.imapRequireTLS : true, // Placeholder for STARTTLS if secure is false
        // auth is handled by top-level email/password in GenericMailManager constructor
      },
      smtp: {
        host: connDetails.smtpHost || '', // Placeholder
        port: connDetails.smtpPort || 587, // Placeholder
        secure: connDetails.smtpSecure !== undefined ? connDetails.smtpSecure : false, // Placeholder (false for STARTTLS on 587)
        // auth is handled by top-level email/password
      },
    };
    driverConfig = { auth: authConfig, c };
  } else if (connDetails.providerId === 'google' || connDetails.providerId === 'microsoft') {
    // Existing OAuth based config
    driverConfig = {
      auth: {
        accessToken: connDetails.accessToken || '', // Ensure these fields exist and are non-null
        refreshToken: connDetails.refreshToken || '',
        email: connDetails.email,
      },
      c,
    };
  } else {
    throw new Error(`Unsupported providerId encountered in connectionToDriver: ${connDetails.providerId}`);
  }
  
  // The 'any' for config in createDriver is a temporary workaround.
  // Ideally, createDriver's config param would be a union of specific config types.
  return createDriver(activeConnection.providerId, driverConfig as any);
};
