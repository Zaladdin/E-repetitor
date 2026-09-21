# Навыки дизайна и веб-разработки

Установлены 21 сентября 2026 года для проекта E-repetitor.
Названия взяты из `E:/IMRP/docs/UI-AUDIT-2026-09-11.md`.
Копий этих навыков в проверенных локальных проектах не найдено, поэтому загружены
версии из исходных публичных репозиториев. Это новые снимки исходников, а не
восстановление точных версий, использованных в IMRP.

## Установлено в проект

| Навык | Назначение | Исходник и зафиксированный commit |
| --- | --- | --- |
| `frontend-design` | Визуальный стиль, композиция и типографика | [anthropics/skills](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/frontend-design), `34040c9c568585f6929bedeaad110ad08f079624` |
| `web-design-guidelines` | Проверка интерфейсов и доступности | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/063bee94c3f4df8453406c830b0a7df0f2860278/skills/web-design-guidelines), `063bee94c3f4df8453406c830b0a7df0f2860278` |
| `ui-ux-pro-max` | Поиск палитр, шрифтов, UX- и стековых рекомендаций | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/0d2b646cb6f48d8478f41417b2e8a5a30fd59175/.claude/skills/ui-ux-pro-max), `0d2b646cb6f48d8478f41417b2e8a5a30fd59175` |

Каталог установки: `E:/E-repetitor/.agents/skills/`.
Использован встроенный `skill-installer`, скачивание по commit SHA.
В UI/UX Pro Max сохранены Python-скрипты, CSV-данные, тесты и справочники.
Его SKILL.md адаптирован для PowerShell и пути текущего проекта вместо
`CLAUDE_PLUGIN_ROOT`; Python-исходники не изменены.

При подготовке репозитория сохранён исходный `frontend-design/LICENSE.txt` и
добавлен `.agents/skills/ui-ux-pro-max/LICENSE` из корня того же зафиксированного
upstream commit. В выбранном каталоге `web-design-guidelines` и корне его
репозитория на указанном commit отдельный файл лицензии отсутствует;
атрибуция автора и ссылка на исходник сохранены. Общая лицензия для собственного
кода E-repetitor этим не устанавливается.

## Уже доступны из общего каталога

`C:/Users/Zaladdin/.codex/skills/` содержит `frontend-app-builder`,
`frontend-testing-debugging`, `react-best-practices` и `shadcn-best-practices`.
Они повторно не устанавливались. Плагин ECC также уже включён; его навыки
используются напрямую. `AGENTS.md` проекта содержит таблицу выбора.

Указанные в старом аудите `design-system` и `accessibility` уже доступны через ECC.
Для `apple-design` локальный исходник и точная версия не установлены, поэтому
произвольный одноимённый пакет не добавлен.

## Проверка установки

- Нативный `skills/list` Codex распознал все 3 локальных и 4 общих навыка:
  `enabled: true`, ошибок загрузки нет.
- После статической проверки скрипта выполнен поиск
  `keyboard focus modal --domain ux` с запретом записи Python bytecode:
  код завершения 0, найдены 3 рекомендации из локальной CSV-базы.
- Поиск проверен без `--persist`; дизайн приложения не генерировался.

## Использование

Примеры запросов: «Используй frontend-design для главной страницы»,
«Подбери палитру и типографику через ui-ux-pro-max»,
«Проверь интерфейс с web-design-guidelines».

Навыки содержат инструкции и справочники. Приложение, зависимости, внешние
сервисы и hooks этой установкой не создаются.
