'use client';
import { GenericConnectionForm } from '@/components/settings/generic-connection-form';

export default function AddGenericConnectionPage() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-4 text-2xl font-bold">Add IMAP/SMTP Connection</h1>
      <GenericConnectionForm />
    </div>
  );
}
