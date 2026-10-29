import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@lms/ui/components/card';
import { PageHeader, PageShell } from '#components/page-shell';

/** Khung một màn form riêng (tạo/sửa) theo chuẩn §9: tiêu đề + quay lại danh sách. */
export function FormScreen({
  title, backTo, children,
}: {
  title: string;
  backTo: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('app');
  return (
    <PageShell width="narrow">
      <PageHeader title={title} />
      <Card>
        <CardContent>{children}</CardContent>
      </Card>
      <p>
        <Link to={backTo} className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </p>
    </PageShell>
  );
}
