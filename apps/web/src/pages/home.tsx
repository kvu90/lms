import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';

export function HomePage() {
  const { t } = useTranslation('app');
  return (
    <main className="mx-auto max-w-2xl p-8">
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
    </main>
  );
}
