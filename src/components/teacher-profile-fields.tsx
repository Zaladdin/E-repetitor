'use client';

import { useI18n } from './locale-provider';


import { useId } from 'react';

export function TeacherProfileFields({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  return <div className="teacher-profile-fields">
    <div className="teacher-profile-field">
      <label htmlFor={`${id}-phone`}>{t("Номер телефона")}</label>
      <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required maxLength={40}
        placeholder="+994 50 123 45 67" disabled={disabled} aria-describedby={`${id}-phone-hint`} />
      <small id={`${id}-phone-hint`}>{t("Международный формат с кодом страны, например +994 50 123 45 67.")}</small>
    </div>
    <div className="teacher-profile-field">
      <label htmlFor={`${id}-birth-date`}>{t("Дата рождения")}</label>
      <input id={`${id}-birth-date`} name="birthDate" type="date" autoComplete="bday" required
        min="0001-01-01" max={new Date().toISOString().slice(0, 10)} disabled={disabled} />
    </div>
    <div className="teacher-profile-field teacher-profile-subject">
      <label htmlFor={`${id}-subject`}>{t("Первый предмет")}</label>
      <input id={`${id}-subject`} name="subject" required maxLength={100} placeholder={t("Например, математика")}
        disabled={disabled} aria-describedby={`${id}-subject-hint`} />
      <small id={`${id}-subject-hint`}>{t("Другие предметы можно добавить позже в кабинете.")}</small>
    </div>
  </div>;
}
