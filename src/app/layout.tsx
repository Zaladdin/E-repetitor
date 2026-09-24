import type { Metadata } from 'next';
import './globals.css';
import { LocaleProvider } from '@/components/locale-provider';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body><LocaleProvider>{children}</LocaleProvider></body></html>;
}
