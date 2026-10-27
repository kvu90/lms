/**
 * Màn tạo danh mục câu hỏi RIÊNG (route /questions/categories/new): tách
 * khỏi trang ngân hàng câu hỏi để mỗi module một màn; hành vi giữ nguyên
 * như khi còn nằm trong trang — xem TSDoc của component bên dưới.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';

import { useQueryClient } from '@tanstack/react-query';

import { accessContextsQueryOptions } from '#lib/access';
import { usePermissions } from '#lib/permissions';
import { clearQuestionBankListCache, useCreateQuestionCategory } from '#lib/questions-data';
import { PageHeader, PageShell } from '../page-shell';
import { withApiReason, type ContextOption } from './shared';

/**
 * Màn tạo danh mục câu hỏi RIÊNG theo chuẩn §9 (route
 * /questions/categories/new): trước đây form này nhồi ngay dưới danh
 * sách ngân hàng trong cùng một trang (§9: tạo mới là màn riêng, không
 * nhồi form vào danh sách). Ngữ cảnh vẫn là control Select của @lms/ui
 * chỉ liệt kê ngữ cảnh người dùng thật sự có question:managecategory
 * (issue #55 mục 2), mặc định ngữ cảnh hệ thống. Tạo xong quay về danh
 * sách ngân hàng (trang danh sách tự nạp lại khi mở).
 */
export function QuestionCategoryNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createCategoryMutation = useCreateQuestionCategory();
  const perms = usePermissions();
  const [catName, setCatName] = useState('');
  const [contextId, setContextId] = useState('');
  const [contextOptions, setContextOptions] = useState<ContextOption[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!perms.ready || !perms.canUseQuestionBank) return;
    let cancelled = false;
    void (async () => {
      try {
        const contexts = await queryClient.fetchQuery(accessContextsQueryOptions());
        const manageable = new Set(
          (perms.access?.contexts ?? [])
            .filter((c) => c.capabilities.includes('question:managecategory'))
            .map((c) => c.contextId),
        );
        const courseName = (instanceId: string) =>
          perms.courses.find((c) => c.course.id === instanceId)?.course.fullName;
        const options: ContextOption[] = contexts
          .filter((c) => c.contextLevel === 10 || c.contextLevel === 40 || c.contextLevel === 50)
          .filter((c) => perms.access?.isSiteAdmin || manageable.has(c.id))
          .map((c) => ({
            id: c.id,
            level: c.contextLevel,
            label:
              c.contextLevel === 10
                ? t('contextSystem')
                : c.contextLevel === 50
                  ? `${t('contextCourse')}: ${courseName(c.instanceId) ?? c.instanceId.slice(0, 8)}`
                  : `${t('contextCourseCategory')}: ${c.instanceId.slice(0, 8)}`,
          }));
        if (cancelled) return;
        setContextOptions(options);
        setContextId((prev) => prev || options.find((o) => o.level === 10)?.id || options[0]?.id || '');
      } catch {
        // Không tải được danh sách ngữ cảnh thì select để rỗng; nếu vẫn
        // gửi tạo danh mục, lỗi hiện lý do thật từ API (mục 3).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [perms.ready, perms.canUseQuestionBank, perms.access]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await createCategoryMutation.mutateAsync({ name: catName, contextId });
      clearQuestionBankListCache(queryClient);
      navigate('/questions');
    } catch (err) {
      setMessage(withApiReason(t('categoryCreateFailedShort'), err));
    }
  }

  if (!perms.ready) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('newCategory')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (!perms.canUseQuestionBank) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('newCategory')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
        <p>
          <Link to="/questions" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell width="medium">
      <PageHeader title={t('newCategory')} />
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <form onSubmit={(e) => void createCategory(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="qcat-name">{t('name')}</FieldLabel>
                <Input id="qcat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel id="qcat-context-label">{t('questionCategoryContext')}</FieldLabel>
                <Select
                  items={Object.fromEntries(contextOptions.map((option) => [option.id, option.label]))}
                  value={contextId === '' ? null : contextId}
                  onValueChange={(v) => setContextId(v ?? '')}
                >
                  <SelectTrigger aria-labelledby="qcat-context-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {contextOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex justify-end">
                <Button type="submit" disabled={!contextId}>
                  {t('createCategory')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <p>
        <Link to="/questions" className="text-sm underline">
          {t('backToQuestionBankList')}
        </Link>
      </p>
    </PageShell>
  );
}
