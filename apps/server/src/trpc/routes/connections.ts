import { createRateLimiterMiddleware, privateProcedure, router } from '../trpc';
import { connection, user as user_ } from '@zero/db/schema';
import { Ratelimit } from '@upstash/ratelimit';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod'; // Existing Zod import

// New Zod schema for adding a generic IMAP/SMTP connection
const genericConnectionInputSchema = z.object({
  name: z.string().min(1, "Connection name is required"), // User-defined name for this connection
  email: z.string().email("Invalid email format"), // This will be the username
  password: z.string().min(1, "Password is required"), // Plain text password, to be encrypted
  
  imapHost: z.string().min(1, "IMAP host is required"),
  imapPort: z.number().int().positive("IMAP port must be a positive integer"),
  imapSecure: z.boolean(), // true for SSL/TLS, false for STARTTLS
  imapRequireTLS: z.boolean().optional(), // Explicit STARTTLS requirement if imapSecure is false
  
  smtpHost: z.string().min(1, "SMTP host is required"),
  smtpPort: z.number().int().positive("SMTP port must be a positive integer"),
  smtpSecure: z.boolean(), // true for SMTPS, false for STARTTLS
  pop3Host: z.string().optional(),
  pop3Port: z.number().int().positive().optional(),
  pop3Tls: z.boolean().optional(),
});

// Placeholder for an encryption function - CRITICAL: IMPLEMENT SECURELY!
const encryptPassword = async (plainTextPassword: string): Promise<string> => {
    console.warn("encryptPassword: Using placeholder encryption. IMPLEMENT SECURE SERVER-SIDE ENCRYPTION!");
    // This is NOT secure. In a real application, use a strong, one-way hashing algorithm (e.g., Argon2, bcrypt)
    // if storing for verification, or proper symmetric/asymmetric encryption if reversible decryption is truly needed
    // (which it is for IMAP/SMTP passwords, so use KMS or similar).
    // For this placeholder, we'll just simulate it's "encrypted".
    return `encrypted:${plainTextPassword}`; // DO NOT USE THIS IN PRODUCTION
};

export const connectionsRouter = router({
  list: privateProcedure
    .use(
      createRateLimiterMiddleware({
        limiter: Ratelimit.slidingWindow(60, '1m'),
        generatePrefix: ({ session }) => `ratelimit:get-connections-${session?.user.id}`,
      }),
    )
    .query(async ({ ctx }) => {
      const { db, session } = ctx;
      const connections = await db
        .select({
          id: connection.id,
          email: connection.email,
          name: connection.name,
          providerId: connection.providerId, // Ensure providerId is returned
          picture: connection.picture,
          createdAt: connection.createdAt,
        })
        .from(connection)
        .where(eq(connection.userId, session.user.id));

      return { connections };
    }),
  setDefault: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const { db } = ctx;
      const user = ctx.session.user;
      const foundConnection = await db.query.connection.findFirst({
        where: and(eq(connection.id, connectionId), eq(connection.userId, user.id)),
      });
      if (!foundConnection) throw new TRPCError({ code: 'NOT_FOUND' });
      await db
        .update(user_)
        .set({ defaultConnectionId: connectionId })
        .where(eq(user_.id, user.id));
    }),
  delete: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const { db } = ctx;
      const user = ctx.session.user;
      await db
        .delete(connection)
        .where(and(eq(connection.id, connectionId), eq(connection.userId, user.id)));

      if (connectionId === ctx.session.connectionId)
        await db.update(user_).set({ defaultConnectionId: null });
    }),

    addGenericConnection: privateProcedure
      .input(genericConnectionInputSchema)
      .mutation(async ({ input, ctx }) => {
        const { db, session } = ctx;
        const userId = session.user.id;

        console.log(`Attempting to add generic connection for user ${userId} with email ${input.email}`);

        // **CRITICAL SECURITY WARNING:** The password must be securely encrypted before saving.
        // The `encryptPassword` function used here is a placeholder and NOT secure.
        const hashedPassword = await encryptPassword(input.password);
        
        try {
          const newConnection = await db
            .insert(connection)
            .values({
              id: `conn_generic_${crypto.randomUUID()}`, // Generate a unique ID
              userId: userId,
              providerId: 'generic_imap_smtp',
              email: input.email, // IMAP/SMTP username
              name: input.name,   // User-given name for the connection
              
              encryptedPassword: hashedPassword, // Store the "encrypted" password
              
              imapHost: input.imapHost,
              imapPort: input.imapPort,
              imapSecure: input.imapSecure,
              imapRequireTLS: input.imapRequireTLS ?? (input.imapSecure ? false : true), // Default requireTLS based on secure flag
              
              smtpHost: input.smtpHost,
              smtpPort: input.smtpPort,
              smtpSecure: input.smtpSecure,
              pop3Host: input.pop3Host || null,
              pop3Port: input.pop3Port || null,
              pop3Tls: input.pop3Tls || null,
              // smtpRequireTLS is often implicit in nodemailer based on port/secure

              // Set OAuth fields to null or appropriate defaults for non-OAuth connections
              accessToken: null,
              refreshToken: null,
              expiresAt: null,
              tokenType: null,
              scope: null,
              picture: null, // No picture for generic IMAP/SMTP
            })
            .returning({ id: connection.id, email: connection.email, name: connection.name }); // Return some basic info

          if (!newConnection || newConnection.length === 0) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create generic connection.',
            });
          }

          console.log(`Generic connection added successfully for user ${userId}: ${newConnection[0].id}`);
          return { success: true, connection: newConnection[0] };

        } catch (error: any) {
          console.error('Error adding generic connection:', error);
          // Check for unique constraint violations if email or name should be unique per user for this provider
          if (error.message?.includes('unique constraint')) { // Adjust based on actual DB error
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'A connection with this email or name might already exist.',
            });
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: error.message || 'An unknown error occurred while adding the connection.',
          });
        }
      }),
});
