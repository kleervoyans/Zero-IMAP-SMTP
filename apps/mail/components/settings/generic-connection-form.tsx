// In apps/mail/components/settings/generic-connection-form.tsx
'use client'; // Assuming Next.js App Router with client components

import React, { useState, FormEvent } from 'react';
import { useTRPC } from '@/providers/query-provider'; // Adjust path if needed

// Assuming UI components exist (these are typical Shadcn/ui paths)
// If not, worker should note this and use basic HTML elements or placeholders.
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'; // Assuming Select component

// Interface for form state
interface GenericConnectionFormData {
  name: string;
  email: string;
  password: string;
  imapHost: string;
  imapPort: string; // String to allow easier input, convert to number on submit
  imapSecure: 'ssl' | 'starttls'; // Representing common choices
  smtpHost: string;
  smtpPort: string; // String for input
  smtpSecure: 'ssl' | 'starttls';
}

export function GenericConnectionForm({ onSuccess }: { onSuccess?: (data: any) => void }) {
  const trpc = useTRPC();
  const [formData, setFormData] = useState<GenericConnectionFormData>({
    name: '',
    email: '',
    password: '',
    imapHost: '',
    imapPort: '993',
    imapSecure: 'ssl',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: 'starttls',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement /*| HTMLSelectElement*/>) => {
    // HTMLSelectElement is not directly used here as Select has its own onValueChange
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };
  
  // Special handler for Select components if they don't use e.target.name/value directly
  const handleSelectChange = (name: keyof GenericConnectionFormData, value: string) => {
    setFormData(prev => ({ ...prev, [name]: value as 'ssl' | 'starttls' })); // Cast value for type safety
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const imapPortNum = parseInt(formData.imapPort, 10);
    const smtpPortNum = parseInt(formData.smtpPort, 10);

    if (isNaN(imapPortNum) || imapPortNum <= 0) {
      setError("Invalid IMAP port number.");
      setIsLoading(false);
      return;
    }
    if (isNaN(smtpPortNum) || smtpPortNum <= 0) {
      setError("Invalid SMTP port number.");
      setIsLoading(false);
      return;
    }

    try {
      const result = await trpc.connections.addGenericConnection.mutate({
        name: formData.name,
        email: formData.email,
        password: formData.password,
        imapHost: formData.imapHost,
        imapPort: imapPortNum,
        imapSecure: formData.imapSecure === 'ssl', // Convert to boolean
        imapRequireTLS: formData.imapSecure === 'starttls', // Explicit for STARTTLS
        smtpHost: formData.smtpHost,
        smtpPort: smtpPortNum,
        smtpSecure: formData.smtpSecure === 'ssl', // Convert to boolean for SMTPS (true for SSL/TLS, false for STARTTLS)
                                                   // Note: The backend genericConnectionInputSchema for smtp has only smtpSecure (boolean).
                                                   // If smtpSecure is false, STARTTLS is typically implied by the port (e.g. 587).
                                                   // The GenericMailManager also handles this logic.
                                                   // So for SMTP, if formData.smtpSecure is 'starttls', we set smtpSecure to false.
      });

      setIsLoading(false);
      alert('Connection added successfully!'); // Placeholder for success notification
      if (onSuccess && result.connection) {
        onSuccess(result.connection);
      }
      // Optionally reset form:
      setFormData({
        name: '',
        email: '',
        password: '',
        imapHost: '',
        imapPort: '993',
        imapSecure: 'ssl',
        smtpHost: '',
        smtpPort: '587',
        smtpSecure: 'starttls',
      });
    } catch (err: any) {
      setIsLoading(false);
      const errorMessage = err?.data?.zodError?.fieldErrors ? 
        Object.values(err.data.zodError.fieldErrors).flat().join(', ') :
        (err.message || 'Failed to add connection.');
      setError(errorMessage);
      alert(`Error: ${errorMessage}`); // Placeholder
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <p className="text-red-500 p-2 bg-red-100 rounded-md">{error}</p>}
      
      <div>
        <Label htmlFor="name">Connection Name</Label>
        <Input id="name" name="name" value={formData.name} onChange={handleChange} required />
        <p className="text-sm text-muted-foreground">A friendly name for this connection (e.g., My Uni Email).</p>
      </div>

      <div>
        <Label htmlFor="email">Email Address (Username)</Label>
        <Input id="email" name="email" type="email" value={formData.email} onChange={handleChange} required />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" value={formData.password} onChange={handleChange} required />
      </div>

      <h3 className="text-lg font-medium pt-2">IMAP Settings (Incoming Mail)</h3>
      <div>
        <Label htmlFor="imapHost">IMAP Host</Label>
        <Input id="imapHost" name="imapHost" value={formData.imapHost} onChange={handleChange} required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="imapPort">IMAP Port</Label>
          <Input id="imapPort" name="imapPort" type="number" value={formData.imapPort} onChange={handleChange} required />
        </div>
        <div>
          <Label htmlFor="imapSecure">IMAP Security</Label>
          <Select name="imapSecure" value={formData.imapSecure} onValueChange={(value) => handleSelectChange('imapSecure', value)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ssl">SSL/TLS</SelectItem>
              <SelectItem value="starttls">STARTTLS</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <h3 className="text-lg font-medium pt-2">SMTP Settings (Outgoing Mail)</h3>
      <div>
        <Label htmlFor="smtpHost">SMTP Host</Label>
        <Input id="smtpHost" name="smtpHost" value={formData.smtpHost} onChange={handleChange} required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="smtpPort">SMTP Port</Label>
          <Input id="smtpPort" name="smtpPort" type="number" value={formData.smtpPort} onChange={handleChange} required />
        </div>
        <div>
          <Label htmlFor="smtpSecure">SMTP Security</Label>
          <Select name="smtpSecure" value={formData.smtpSecure} onValueChange={(value) => handleSelectChange('smtpSecure', value)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ssl">SMTPS (SSL/TLS)</SelectItem>
              <SelectItem value="starttls">STARTTLS</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      
      <Button type="submit" disabled={isLoading} className="w-full">
        {isLoading ? 'Adding Connection...' : 'Add IMAP/SMTP Connection'}
      </Button>
    </form>
  );
}
