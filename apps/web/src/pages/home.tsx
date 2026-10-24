import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { PageShell } from '../components/page-shell';

export function HomePage() {
  const { t } = useTranslation('app');
  return (
    <PageShell width="wide">
      <Card>
        <CardHeader>
          <CardTitle>LMS</CardTitle>
          <CardDescription>{t('homeDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Button render={<Link to="/login" />}>{t('signIn')}</Button>
            <Button variant="outline" render={<Link to="/health" />}>
              {t('checkApiHealth')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
