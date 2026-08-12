import type { Metadata } from 'next';
import './globals.css';
import { Toaster } from '@/components/ui/sonner';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'EZTruckr',
  description: 'Trucking management for Philippine hauling operations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
        {/* Removal outcomes are reported here — a deactivation has to be seen. */}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
