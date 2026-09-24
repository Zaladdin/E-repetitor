import { AccountPortal } from '@/components/account-portal';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <><AccountPortal />{children}</>;
}
