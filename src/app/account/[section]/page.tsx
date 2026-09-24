import { notFound } from 'next/navigation';
import { ACCOUNT_SECTION_IDS, accountSectionHref } from '@/lib/account-navigation';

export const dynamicParams = false;

export function generateStaticParams() {
  return ACCOUNT_SECTION_IDS.map(id => ({ section: accountSectionHref(id).split('/')[2] }));
}

export default async function AccountSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!generateStaticParams().some(page => page.section === section)) notFound();
  return null;
}
