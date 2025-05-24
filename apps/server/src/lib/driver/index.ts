import type { MailManager, ManagerConfig } from './types';
import { GoogleMailManager } from './google';
import { GenericMailManager } from './genericMail'; // Added import

// Assume MicrosoftMailManager might exist or be added later
// import { MicrosoftMailManager } from './microsoft';

const supportedProviders = {
  google: GoogleMailManager,
  // microsoft: MicrosoftMailManager,
  generic_imap_smtp: GenericMailManager, // Added new provider
};

export const createDriver = (
  provider: keyof typeof supportedProviders | (string & {}), // Keep existing flexibility
  config: ManagerConfig | any, // Temporarily use 'any' for config due to different shapes
                                // This should be refined to a union type later if possible
): MailManager => {
  const Provider = supportedProviders[provider as keyof typeof supportedProviders];
  if (!Provider) throw new Error('Provider not supported: ' + provider);
  return new Provider(config);
};
