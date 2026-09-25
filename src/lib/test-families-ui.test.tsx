import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { availableVariantCodes, TestFamilyList } from '@/components/test-family-library';
import type { TestFamily, TestSummary } from './account-tests';

const variant = (code: string, changes: Partial<TestSummary> = {}): TestSummary => ({
  id: `variant-${code}`, familyId: 'family', variantCode: code, title: 'Квадратные уравнения',
  subjectId: 'math', subjectName: 'Математика', status: 'draft', revision: 1,
  questionCount: 5, maxPoints: 10, updatedAt: '2026-09-25T12:00:00Z', ...changes,
});
const family: TestFamily = { id: 'family', title: 'Квадратные уравнения', subjectId: 'math', subjectName: 'Математика', variants: [
  variant('A', { status: 'published', latestVersion: { id: 'version-a', number: 2, publishedAt: '2026-09-25T12:00:00Z' } }),
  variant('B'),
] };
const render = (value = family) => renderToStaticMarkup(<TestFamilyList families={[value]} disabled={false} onOpen={() => {}} onAssign={() => {}} onCopy={() => {}} onArchive={() => {}} />);

describe('test family library', () => {
  it('renders one family title with independent draft and published variant states', () => {
    const html = render();
    expect(html.match(/<h3>/g)).toHaveLength(1);
    expect(html.match(/test-variant-row/g)).toHaveLength(2);
    expect(html).toContain('Вариант A'); expect(html).toContain('Вариант B');
    expect(html).toContain('Версия 2'); expect(html).toContain('Нет опубликованных версий');
    expect(html.match(/>Назначить<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Копировать в новый вариант<\/button>/g)).toHaveLength(2);
  });

  it('keeps archived variants readable without offering mutation or assignment actions', () => {
    const html = render({ ...family, variants: [variant('A', { ...family.variants[0], status: 'archived' })] });
    expect(html).toContain('Посмотреть'); expect(html).toContain('В архиве');
    expect(html).not.toContain('>Назначить</button>');
    expect(html).not.toContain('Копировать в новый вариант');
    expect(html).not.toContain('>В архив</button>');
  });

  it('reserves codes across all variants including archived ones and respects the A–Z limit', () => {
    expect(availableVariantCodes({ ...family, variants: [variant('A'), variant('C', { status: 'archived' })] }).slice(0, 3)).toEqual(['B', 'D', 'E']);
    const full = { ...family, variants: Array.from({ length: 26 }, (_, index) => variant(String.fromCharCode(65 + index))) };
    expect(availableVariantCodes(full)).toEqual([]);
    expect(render(full)).toContain('disabled=""');
  });
});
