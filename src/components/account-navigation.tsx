'use client';

import { useI18n } from './locale-provider';


import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { AccountRole } from '@/lib/account-api';
import { accountSectionHref, accountSections, type AccountSectionId } from '@/lib/account-navigation';

export function AccountNavigation({ role, isAdmin = false, unreadNotifications, active }: {
  role: AccountRole; isAdmin?: boolean; unreadNotifications: number | null; active: AccountSectionId;
}) {
  const { t, locale } = useI18n();
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const link = navigationRef.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
    const strip = link?.parentElement;
    if (!link || !strip) return;
    const current = link.getBoundingClientRect(), visible = strip.getBoundingClientRect();
    if (current.left < visible.left) strip.scrollLeft -= visible.left - current.left + 4;
    else if (current.right > visible.right) strip.scrollLeft += current.right - visible.right + 4;
  }, [active, locale]);

  return <nav ref={navigationRef} className="account-section-nav account-navigation" aria-label={t("Разделы кабинета")}>
    <div className="account-navigation-links">{accountSections(role, isAdmin).map(({ id, label }) => <Link key={id} href={accountSectionHref(id)} aria-current={id === active ? 'page' : undefined}>
      {t(label)}{id === 'account-notifications-section' && !!unreadNotifications && <span className="account-navigation-count" aria-label={t("Непрочитанных: {value0}", { value0: String(unreadNotifications) })}>{unreadNotifications}</span>}
    </Link>)}</div>
  </nav>;
}
