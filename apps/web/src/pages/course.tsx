import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import type { CourseContent } from '@lms/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiJson } from '@/lib/api';

/**
 * Course page (P2): sections + modules with availability state rendered
 * faithfully — an unavailable-but-shown module appears greyed with its
 * restriction descriptions; a hidden one is simply absent (the API has
 * already filtered it). The API, not this page, is the access gate.
 */
export function CoursePage() {
  const { id } = useParams();
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setContent(await apiJson<CourseContent>(`/api/v1/courses/${id}/content`));
    } catch {
      setError('You cannot access this course (not enrolled, suspended, or the course is hidden).');
    }
  }, [id]);

  useEffect(() => { void reload(); }, [reload]);

  if (error) return <main className="p-8"><p role="alert">{error}</p></main>;
  if (!content) return <main className="p-8">Loading course…</main>;

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>{content.course.fullname}</CardTitle>
          <CardDescription>{content.course.shortname}{content.course.visible ? '' : ' — hidden course'}</CardDescription>
        </CardHeader>
      </Card>
      {content.sections.map((section) => (
        <Card key={section.id}>
          <CardHeader>
            <CardTitle>{section.name ?? `Section ${section.section}`}</CardTitle>
            {section.availabilityResult && !section.availabilityResult.available && (
              <CardDescription>Section restricted: {section.availabilityResult.failedDescriptions.join('; ')}</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {section.modules.map((cm) => {
                const result = cm.availabilityResult;
                const locked = result !== undefined && !result.available;
                return (
                  <li key={cm.id} data-testid={`cm-${cm.id}`} aria-disabled={locked || undefined} className={locked ? 'opacity-50' : undefined}>
                    <span>{cm.name || cm.component}</span>
                    {locked && (
                      <span role="note"> — Locked: {result.failedDescriptions.length ? result.failedDescriptions.join('; ') : 'not available yet'}</span>
                    )}
                    {!locked && result && <span> — Available</span>}
                  </li>
                );
              })}
              {section.modules.length === 0 && <li>No activities in this section.</li>}
            </ul>
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
